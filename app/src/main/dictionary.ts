import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { DictionaryEntry, DictionarySearchResult, DictionarySense } from '../shared/ipc'

/**
 * Read-only access to the Wiktionary database built by ogma's
 * setup-wiktionary script (entries + entries_fts). Uses Node's built-in
 * SQLite, so there is no native module to rebuild for Electron.
 */

interface EntryRow {
  id: number
  word: string
  pos: string | null
  etymology: string | null
  data: string
}

interface EntryData {
  senses?: DictionarySense[]
  ipa?: string[]
  synonyms?: string[]
  antonyms?: string[]
  derived?: string[]
  related?: string[]
}

/** Spellings to try, exactly, so the lookup can use the case-sensitive word index. */
export function lookupVariants(word: string): string[] {
  const trimmed = word.normalize('NFC').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (!trimmed) return []
  const lower = trimmed.toLocaleLowerCase()
  const capitalized = lower.charAt(0).toLocaleUpperCase() + lower.slice(1)
  return [...new Set([trimmed, lower, capitalized])]
}

/** FTS5 prefix query from free text: every token must prefix-match. */
export function prefixQuery(text: string): string {
  return text.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.map((token) => `"${token}"*`).join(' ') ?? ''
}

const unique = (values: string[] | undefined) =>
  [...new Set((values ?? []).filter((value) => value && !value.startsWith(':') && !value.includes('Category:')))]

export function toEntry(row: EntryRow): DictionaryEntry {
  let data: EntryData = {}
  try {
    data = JSON.parse(row.data) as EntryData
  } catch {
    // keep the empty entry rather than failing the whole lookup
  }
  const self = (value: string) => value.toLocaleLowerCase() !== row.word.toLocaleLowerCase()
  return {
    id: row.id,
    word: row.word,
    pos: row.pos,
    etymology: row.etymology,
    senses: data.senses ?? [],
    ipa: data.ipa ?? [],
    synonyms: unique(data.synonyms).filter(self),
    antonyms: unique(data.antonyms).filter(self),
    derived: unique(data.derived).filter(self),
    related: unique(data.related).filter(self),
  }
}

export class Dictionary {
  private readonly db: DatabaseSync
  private readonly lookupStatement: StatementSync
  private readonly searchStatement: StatementSync

  constructor(path: string) {
    if (!existsSync(path)) throw new Error(`Dictionary not found at ${path}`)
    this.db = new DatabaseSync(path, { readOnly: true })
    this.lookupStatement = this.db.prepare(
      'SELECT id, word, pos, etymology, data FROM entries WHERE word IN (?, ?, ?) ORDER BY id',
    )
    this.searchStatement = this.db.prepare(`
      SELECT entries.word AS word, entries.pos AS pos, snippet(entries_fts, 2, '', '', ' … ', 14) AS gloss
      FROM entries_fts JOIN entries ON entries.id = entries_fts.rowid
      WHERE entries_fts MATCH ?
      ORDER BY CASE WHEN entries.word LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, bm25(entries_fts), length(entries.word)
      LIMIT ?
    `)
  }

  lookup(word: string): DictionaryEntry[] {
    const variants = lookupVariants(word)
    if (variants.length === 0) return []
    const [first, second = first, third = first] = variants
    return (this.lookupStatement.all(first, second, third) as unknown as EntryRow[]).map(toEntry)
  }

  search(text: string, limit = 20): DictionarySearchResult[] {
    const query = prefixQuery(text)
    if (!query) return []
    const like = `${text.trim().replace(/[\\%_]/g, '\\$&')}%`
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100)
    const rows = this.searchStatement.all(query, like, bounded) as unknown as DictionarySearchResult[]
    // One row per word/part of speech; FTS returns every sense row.
    const seen = new Set<string>()
    return rows.filter((row) => {
      const key = `${row.word}|${row.pos}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  close(): void {
    this.db.close()
  }
}
