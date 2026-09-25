import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { MATCH_END, MATCH_START, type SearchHit, type SearchStatus } from '../shared/ipc'
import { STOPWORDS } from '../shared/readability'
import { isInside, isTextFileName, readTextDocument } from './fileService'

export { MATCH_END, MATCH_START }

const SKIPPED_DIRECTORIES = new Set(['node_modules', '__pycache__'])
const MAX_CHUNK_CHARS = 2000
const MAX_FILE_BYTES = 5 * 1024 * 1024

export interface Chunk {
  line: number
  text: string
}

/** Paragraph chunks (blank-line separated) with their 1-based starting line; long ones are split. */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = []
  const lines = text.split('\n')
  let start = -1
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length === 0) return
    const joined = buffer.join('\n').trim()
    for (let offset = 0; offset < joined.length; offset += MAX_CHUNK_CHARS) {
      chunks.push({ line: start + 1, text: joined.slice(offset, offset + MAX_CHUNK_CHARS) })
    }
    buffer = []
  }
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      flush()
      return
    }
    if (buffer.length === 0) start = index
    buffer.push(line)
  })
  flush()
  return chunks
}

/** Every token must prefix-match; quotes keep FTS syntax out of user input. */
export function matchQuery(text: string): string {
  return text.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.map((token) => `"${token}"*`).join(' ') ?? ''
}

/** The most frequent content words of a passage, as an any-of query for "related notes". */
export function relatedQuery(text: string, terms = 24): string {
  const counts = new Map<string, number>()
  for (const word of text.toLocaleLowerCase().match(/\p{L}[\p{L}'’-]*\p{L}/gu) ?? []) {
    if (word.length > 3 && !STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, terms)
    .map(([word]) => `"${word.replace(/"/g, '')}"`)
    .join(' OR ')
}

/**
 * Full-text index of every text file under the workspace roots, used for
 * search and "related notes". Kept in <userData>/search.db and refreshed
 * incrementally: only files whose size or mtime changed are re-read.
 */
export class SearchIndex {
  private readonly db: DatabaseSync
  private readonly statements: Record<string, StatementSync>
  private syncing: Promise<void> | null = null
  private progress = { done: 0, total: 0 }
  private ready = false

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED, line UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');
    `)
    this.statements = {
      file: this.db.prepare('SELECT mtime, size FROM files WHERE path = ?'),
      upsertFile: this.db.prepare('INSERT INTO files (path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size'),
      deleteFile: this.db.prepare('DELETE FROM files WHERE path = ?'),
      deleteChunks: this.db.prepare('DELETE FROM chunks WHERE path = ?'),
      insertChunk: this.db.prepare('INSERT INTO chunks (path, line, text) VALUES (?, ?, ?)'),
      allFiles: this.db.prepare('SELECT path FROM files'),
      count: this.db.prepare('SELECT count(*) AS n FROM files'),
      search: this.db.prepare(`
        SELECT path, line, snippet(chunks, 2, '${MATCH_START}', '${MATCH_END}', ' … ', 16) AS snippet
        FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?
      `),
    }
  }

  status(): SearchStatus {
    const files = (this.statements.count.get() as { n: number }).n
    return { files, indexing: this.syncing !== null, done: this.progress.done, total: this.progress.total, ready: this.ready }
  }

  /** Brings the index up to date with the roots; concurrent calls share one pass. */
  sync(roots: string[], onProgress?: (status: SearchStatus) => void): Promise<void> {
    this.syncing ??= this.runSync(roots, onProgress).finally(() => {
      this.syncing = null
      this.ready = true
      onProgress?.(this.status())
    })
    return this.syncing
  }

  async updateFile(file: string, roots: string[]): Promise<void> {
    const inside = roots.some((root) => isInside(root, file))
    const info = await stat(file).catch(() => null)
    if (!inside || !info || !info.isFile() || !isTextFileName(path.basename(file)) || isHiddenPath(file, roots)) {
      this.removeFile(file)
      return
    }
    await this.indexFile(file, info.mtimeMs, info.size)
  }

  removeFile(file: string): void {
    this.statements.deleteChunks.run(file)
    this.statements.deleteFile.run(file)
  }

  search(text: string, limit = 100): SearchHit[] {
    const query = matchQuery(text)
    if (!query) return []
    return this.statements.search.all(query, limit) as unknown as SearchHit[]
  }

  /** Paragraphs elsewhere in the workspace that share the passage's key words; best one per file. */
  related(text: string, exclude: string[], limit = 12): SearchHit[] {
    const query = relatedQuery(text)
    if (!query) return []
    const excluded = new Set(exclude.map((file) => file.toLowerCase()))
    const seen = new Set<string>()
    const hits: SearchHit[] = []
    for (const hit of this.statements.search.all(query, 200) as unknown as SearchHit[]) {
      const key = hit.path.toLowerCase()
      if (excluded.has(key) || seen.has(key)) continue
      seen.add(key)
      hits.push(hit)
      if (hits.length >= limit) break
    }
    return hits
  }

  close(): void {
    this.db.close()
  }

  private async runSync(roots: string[], onProgress?: (status: SearchStatus) => void): Promise<void> {
    const found = new Map<string, { mtime: number; size: number }>()
    for (const root of roots) await walk(root, found)
    this.progress = { done: 0, total: found.size }

    for (const row of this.statements.allFiles.all() as { path: string }[]) {
      if (!found.has(row.path)) this.removeFile(row.path)
    }
    let index = 0
    for (const [file, info] of found) {
      const known = this.statements.file.get(file) as { mtime: number; size: number } | undefined
      if (!known || known.mtime !== info.mtime || known.size !== info.size) await this.indexFile(file, info.mtime, info.size)
      index += 1
      if (index % 50 === 0) {
        this.progress = { done: index, total: found.size }
        onProgress?.(this.status())
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    this.progress = { done: found.size, total: found.size }
  }

  private async indexFile(file: string, mtime: number, size: number): Promise<void> {
    let chunks: Chunk[] = []
    if (size <= MAX_FILE_BYTES) {
      try {
        chunks = chunkText((await readTextDocument(file)).text)
      } catch {
        chunks = [] // binary or unreadable: remember it so it is not retried until it changes
      }
    }
    this.db.exec('BEGIN')
    try {
      this.statements.deleteChunks.run(file)
      for (const chunk of chunks) this.statements.insertChunk.run(file, chunk.line, chunk.text)
      this.statements.upsertFile.run(file, mtime, size)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function isHiddenPath(file: string, roots: string[]): boolean {
  const root = roots.find((candidate) => isInside(candidate, file))
  const parts = path.relative(root ?? '', file).split(/[\\/]/)
  return parts.some((part) => part.startsWith('.') || SKIPPED_DIRECTORIES.has(part))
}

async function walk(directory: string, found: Map<string, { mtime: number; size: number }>): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(full, found)
    } else if (entry.isFile() && isTextFileName(entry.name)) {
      const info = await stat(full).catch(() => null)
      if (info) found.set(full, { mtime: info.mtimeMs, size: info.size })
    }
  }
}
