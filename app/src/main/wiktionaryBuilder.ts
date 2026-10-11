import { mkdir, rename, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { get } from 'node:https'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createGunzip } from 'node:zlib'

import type { DictionaryDownload } from '../shared/ipc'

/** Kaikki.org's extract of the English Wiktionary, one JSON object per line. */
export const WIKTIONARY_URL = 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl'

const BATCH = 20000

/** Opens the URL (following redirects) without decoding it, so progress can count the bytes actually sent. */
function open(url: string, signal: AbortSignal, redirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'accept-encoding': 'gzip' }, signal }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume()
        resolve(open(new URL(response.headers.location, url).toString(), signal, redirects - 1))
      } else if (status !== 200) {
        response.resume()
        reject(new Error(`Download failed (HTTP ${status}).`))
      } else {
        resolve(response)
      }
    })
    request.on('error', reject)
  })
}

interface KaikkiSense {
  glosses?: string[]
  examples?: { text?: string; english?: string }[]
  synonyms?: { word?: string }[]
  antonyms?: { word?: string }[]
  derived?: { word?: string }[]
  related?: { word?: string }[]
}

interface KaikkiEntry extends KaikkiSense {
  word?: string
  pos?: string
  etymology_text?: string
  sounds?: { ipa?: string }[]
  senses?: KaikkiSense[]
}

const words = (...lists: ({ word?: string }[] | undefined)[]) =>
  [...new Set(lists.flatMap((list) => (list ?? []).map((item) => item.word ?? '').filter(Boolean)))]

/** The row stored for one Kaikki line, or null when it has nothing to show. */
export function toRow(line: string): { word: string; pos: string; etymology: string | null; data: string; gloss: string } | null {
  let entry: KaikkiEntry
  try {
    entry = JSON.parse(line) as KaikkiEntry
  } catch {
    return null
  }
  if (!entry.word || !entry.pos) return null
  const senses = (entry.senses ?? [])
    .filter((sense) => sense.glosses?.length)
    .map((sense) => ({
      glosses: sense.glosses ?? [],
      examples: (sense.examples ?? [])
        .filter((example) => example.text)
        .slice(0, 3)
        .map((example) => ({ text: example.text ?? '', ...(example.english ? { translation: example.english } : {}) })),
    }))
  if (senses.length === 0) return null
  const each = (key: 'synonyms' | 'antonyms' | 'derived' | 'related') => words(entry[key], ...(entry.senses ?? []).map((sense) => sense[key]))
  const data = {
    senses,
    ipa: [...new Set((entry.sounds ?? []).map((sound) => sound.ipa ?? '').filter(Boolean))],
    synonyms: each('synonyms'),
    antonyms: each('antonyms'),
    derived: each('derived'),
    related: each('related'),
  }
  return {
    word: entry.word,
    pos: entry.pos,
    etymology: entry.etymology_text?.trim() || null,
    data: JSON.stringify(data),
    gloss: senses.slice(0, 4).map((sense) => sense.glosses.join('; ')).join(' | '),
  }
}

/**
 * Streams the Kaikki dump into a new SQLite database (entries + entries_fts, as Dictionary reads it).
 * Nothing is left at `target` unless the whole download succeeds.
 */
export async function buildWiktionary(
  target: string,
  onProgress: (status: DictionaryDownload) => void,
  signal: AbortSignal,
  url = WIKTIONARY_URL,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const partial = `${target}.partial`
  await rm(partial, { force: true })
  let db: DatabaseSync | null = null
  try {
    const response = await open(url, signal)
    const total = Number(response.headers['content-length']) || null

    db = new DatabaseSync(partial)
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE entries (id INTEGER PRIMARY KEY, word TEXT NOT NULL, pos TEXT, etymology TEXT, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE entries_fts USING fts5(word, pos, gloss, tokenize = 'unicode61 remove_diacritics 2');
    `)
    const insertEntry = db.prepare('INSERT INTO entries (id, word, pos, etymology, data) VALUES (?, ?, ?, ?, ?)')
    const insertFts = db.prepare('INSERT INTO entries_fts (rowid, word, pos, gloss) VALUES (?, ?, ?, ?)')

    let count = 0
    let received = 0
    let pending = 0
    db.exec('BEGIN')
    const add = (line: string) => {
      const row = line.trim() ? toRow(line) : null
      if (!row) return
      count++
      insertEntry.run(count, row.word, row.pos, row.etymology, row.data)
      insertFts.run(count, row.word, row.pos, row.gloss)
      if (++pending >= BATCH) {
        db?.exec('COMMIT; BEGIN')
        pending = 0
      }
    }

    const decoder = new TextDecoder()
    let rest = ''
    let lastReport = 0
    response.on('data', (chunk: Buffer) => { received += chunk.byteLength })
    const body = response.headers['content-encoding'] === 'gzip' ? response.pipe(createGunzip()) : response
    response.on('error', (error) => body.destroy(error))
    for await (const value of body as AsyncIterable<Buffer>) {
      const lines = (rest + decoder.decode(value, { stream: true })).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) add(line)
      if (Date.now() - lastReport > 250) {
        lastReport = Date.now()
        onProgress({ state: 'downloading', received, total, entries: count, error: null })
      }
    }
    add(rest + decoder.decode())
    db.exec('COMMIT')

    onProgress({ state: 'indexing', received, total, entries: count, error: null })
    // Yield so the renderer can show the final stage before the synchronous index build blocks the loop.
    await new Promise((done) => setTimeout(done, 50))
    db.exec('CREATE INDEX entries_word ON entries (word)')
    db.close()
    db = null
    await rm(target, { force: true })
    await rename(partial, target)
  } catch (error) {
    db?.close()
    await rm(partial, { force: true })
    throw error
  }
}
