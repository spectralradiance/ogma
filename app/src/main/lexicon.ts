import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LexiconEntry } from '../shared/ipc'
import { lexiconFileName, parseLexiconFile, serializeLexiconEntry, splitList } from '../shared/lexicon'

/** The personal lexicon: a folder of Markdown files, one per word. */
export class LexiconStore {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get location(): string {
    return this.directory
  }

  async list(): Promise<LexiconEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return []
    }
    const entries = await Promise.all(names.filter((name) => name.endsWith('.md')).map(async (name) =>
      parseLexiconFile(await readFile(path.join(this.directory, name), 'utf8').catch(() => ''))))
    return entries
      .filter((entry): entry is LexiconEntry => entry !== null)
      .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }))
  }

  /** Creates or replaces the entry for this word (atomic write). */
  async save(entry: LexiconEntry): Promise<LexiconEntry> {
    const word = entry.word.trim()
    if (!word) throw new Error('A lexicon entry needs a word.')
    const saved: LexiconEntry = {
      ...entry,
      word,
      tags: [...new Set(entry.tags.map((tag) => tag.trim()).filter(Boolean))],
      synonyms: [...new Set(entry.synonyms.map((synonym) => synonym.trim()).filter(Boolean))],
      added: entry.added || new Date().toISOString().slice(0, 10),
    }
    await mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, lexiconFileName(word))
    const temporary = `${target}.tmp`
    await writeFile(temporary, serializeLexiconEntry(saved), 'utf8')
    await rename(temporary, target)
    return saved
  }

  async remove(word: string, trash: (file: string) => Promise<void>): Promise<void> {
    await trash(path.join(this.directory, lexiconFileName(word)))
  }

  /**
   * Imports Aisling's Vocabulary/*.json files ({word, definition, tags, synonyms},
   * lists as comma-separated text). Words already in the lexicon are left alone.
   */
  async importAisling(folder: string): Promise<{ imported: number; skipped: number }> {
    const existing = new Set((await this.list()).map((entry) => entry.word.toLocaleLowerCase()))
    let imported = 0
    let skipped = 0
    for (const name of (await readdir(folder)).filter((file) => file.toLowerCase().endsWith('.json'))) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(await readFile(path.join(folder, name), 'utf8')) as Record<string, unknown>
      } catch {
        skipped += 1
        continue
      }
      const word = typeof raw.word === 'string' ? raw.word.trim() : ''
      if (!word || existing.has(word.toLocaleLowerCase())) {
        skipped += 1
        continue
      }
      const field = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
      await this.save({
        word,
        definition: field('definition'),
        tags: splitList(field('tags')),
        synonyms: splitList(field('synonyms')),
        context: '',
        source: path.join(folder, name),
        added: '',
        note: '',
      })
      existing.add(word.toLocaleLowerCase())
      imported += 1
    }
    return { imported, skipped }
  }
}
