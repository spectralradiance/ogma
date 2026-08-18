#!/usr/bin/env node

import cliProgress from 'cli-progress'
import type Database from 'better-sqlite3'
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'

import {
  DICTIONARY_DB_PATH,
  DICTIONARY_JSONL_PATH,
  initializeDictionarySchema,
  openDictionaryDb,
  type DictionaryEntryData,
  type DictionaryExample,
  type DictionarySense,
} from '../lib/dictionary/db.ts'


const PRIMARY_URL = 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl'
const FALLBACK_URL = `${PRIMARY_URL}.gz`
const BATCH_SIZE = 5_000

interface KaikkiTerm {
  word?: unknown
}

interface KaikkiExample {
  text?: unknown
  translation?: unknown
}

interface KaikkiSense {
  glosses?: unknown
  raw_glosses?: unknown
  examples?: unknown
  synonyms?: unknown
  antonyms?: unknown
}

interface KaikkiSound {
  ipa?: unknown
}

interface KaikkiEntry {
  word?: unknown
  pos?: unknown
  etymology_text?: unknown
  senses?: unknown
  sounds?: unknown
  synonyms?: unknown
  antonyms?: unknown
  derived?: unknown
  related?: unknown
}

interface IngestRecord {
  word: string
  pos: string | null
  etymology: string | null
  data: DictionaryEntryData
  glosses: string
}

interface CliOptions {
  download: boolean
  forceDownload: boolean
  rebuild: boolean
}

function parseOptions(arguments_: string[]): CliOptions {
  const known = new Set(['--download', '--force-download', '--rebuild'])
  const unknown = arguments_.filter((argument) => !known.has(argument))
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(', ')}`)
  return {
    download: arguments_.includes('--download'),
    forceDownload: arguments_.includes('--force-download'),
    rebuild: arguments_.includes('--rebuild'),
  }
}

function removeIfPresent(path: string): void {
  rmSync(path, { force: true })
}

async function fetchChecked(url: string, offset: number): Promise<Response> {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`)
  }
  return response
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const partial = `${destination}.part`
  let offset = existsSync(partial) ? statSync(partial).size : 0
  let response = await fetchChecked(url, offset)

  if (offset > 0 && response.status !== 206) {
    removeIfPresent(partial)
    offset = 0
    response = await fetchChecked(url, 0)
  }

  const remaining = Number(response.headers.get('content-length') ?? 0)
  const total = remaining > 0 ? offset + remaining : 0
  const progress = new cliProgress.SingleBar(
    { format: 'Downloading [{bar}] {percentage}% | {value}/{total} MB' },
    cliProgress.Presets.shades_classic,
  )
  if (total > 0) progress.start(Math.ceil(total / 1_048_576), Math.floor(offset / 1_048_576))

  let downloaded = offset
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length
      if (total > 0) progress.update(Math.floor(downloaded / 1_048_576))
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }),
    )
  } finally {
    if (total > 0) progress.stop()
  }
  await rename(partial, destination)
}

async function decompressGzip(source: string, destination: string): Promise<void> {
  const partial = `${destination}.decompressing`
  removeIfPresent(partial)
  console.log('Decompressing Wiktionary dataset...')
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(partial))
  await rename(partial, destination)
}

async function ensureDataset(forceDownload: boolean): Promise<void> {
  if (forceDownload) {
    removeIfPresent(DICTIONARY_JSONL_PATH)
    removeIfPresent(`${DICTIONARY_JSONL_PATH}.part`)
  }
  if (existsSync(DICTIONARY_JSONL_PATH)) {
    console.log(`Using existing dataset: ${DICTIONARY_JSONL_PATH}`)
    return
  }

  try {
    console.log(`Downloading ${PRIMARY_URL}`)
    await downloadFile(PRIMARY_URL, DICTIONARY_JSONL_PATH)
  } catch (primaryError) {
    console.warn(`Uncompressed download unavailable: ${String(primaryError)}`)
    const gzipPath = `${DICTIONARY_JSONL_PATH}.gz`
    console.log(`Downloading fallback ${FALLBACK_URL}`)
    await downloadFile(FALLBACK_URL, gzipPath)
    await decompressGzip(gzipPath, DICTIONARY_JSONL_PATH)
    removeIfPresent(gzipPath)
  }
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (item && typeof item === 'object' && typeof (item as KaikkiTerm).word === 'string') {
      const word = (item as KaikkiTerm).word as string
      return word.trim() ? [word.trim()] : []
    }
    return []
  })
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function examples(value: unknown): DictionaryExample[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const example = item as KaikkiExample
    if (typeof example.text !== 'string' || !example.text.trim()) return []
    return [{
      text: example.text.trim(),
      ...(typeof example.translation === 'string' && example.translation.trim()
        ? { translation: example.translation.trim() }
        : {}),
    }]
  })
}

function senses(value: unknown): { senses: DictionarySense[]; synonyms: string[]; antonyms: string[] } {
  if (!Array.isArray(value)) return { senses: [], synonyms: [], antonyms: [] }
  const parsed: DictionarySense[] = []
  const synonyms: string[] = []
  const antonyms: string[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const sense = item as KaikkiSense
    const glosses = strings(sense.glosses).length
      ? strings(sense.glosses)
      : strings(sense.raw_glosses)
    parsed.push({ glosses, examples: examples(sense.examples) })
    synonyms.push(...strings(sense.synonyms))
    antonyms.push(...strings(sense.antonyms))
  }
  return { senses: parsed, synonyms, antonyms }
}

export function normalizeKaikkiEntry(value: unknown): IngestRecord | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as KaikkiEntry
  if (typeof entry.word !== 'string' || !entry.word.trim()) return null
  const parsedSenses = senses(entry.senses)
  const sounds = Array.isArray(entry.sounds) ? entry.sounds : []
  const data: DictionaryEntryData = {
    senses: parsedSenses.senses,
    ipa: unique(sounds.flatMap((sound) =>
      sound && typeof sound === 'object' && typeof (sound as KaikkiSound).ipa === 'string'
        ? [(sound as KaikkiSound).ipa as string]
        : []
    )),
    synonyms: unique([...strings(entry.synonyms), ...parsedSenses.synonyms]),
    antonyms: unique([...strings(entry.antonyms), ...parsedSenses.antonyms]),
    derived: unique(strings(entry.derived)),
    related: unique(strings(entry.related)),
  }
  return {
    word: entry.word.trim(),
    pos: typeof entry.pos === 'string' && entry.pos.trim() ? entry.pos.trim() : null,
    etymology: typeof entry.etymology_text === 'string' && entry.etymology_text.trim()
      ? entry.etymology_text.trim()
      : null,
    data,
    glosses: data.senses.flatMap((sense) => sense.glosses).join('\n'),
  }
}

function createBatchWriter(db: Database.Database): (records: IngestRecord[]) => void {
  const insertEntry = db.prepare(`
    INSERT INTO entries (word, pos, etymology, data)
    VALUES (@word, @pos, @etymology, @data)
  `)
  const insertFts = db.prepare(`
    INSERT INTO entries_fts (rowid, word, etymology, glosses)
    VALUES (?, ?, ?, ?)
  `)
  return db.transaction((records: IngestRecord[]) => {
    for (const record of records) {
      const result = insertEntry.run({
        word: record.word,
        pos: record.pos,
        etymology: record.etymology,
        data: JSON.stringify(record.data),
      })
      insertFts.run(result.lastInsertRowid, record.word, record.etymology, record.glosses)
    }
  })
}

async function ingestDataset(source: string, destination: string): Promise<void> {
  const temporaryDb = `${destination}.building`
  for (const suffix of ['', '-wal', '-shm']) removeIfPresent(`${temporaryDb}${suffix}`)
  const db = openDictionaryDb(temporaryDb)
  initializeDictionarySchema(db)
  const writeBatch = createBatchWriter(db)
  const batch: IngestRecord[] = []
  let inserted = 0
  let rejected = 0
  const progress = new cliProgress.SingleBar(
    { format: 'Indexing [{bar}] {percentage}% | {value}/{total} MB | entries: {entries}' },
    cliProgress.Presets.shades_classic,
  )
  const totalBytes = statSync(source).size
  let consumedBytes = 0
  progress.start(Math.ceil(totalBytes / 1_048_576), 0, { entries: 0 })

  const input = createReadStream(source)
  input.on('data', (chunk: string | Buffer) => {
    consumedBytes += Buffer.byteLength(chunk)
    progress.update(Math.floor(consumedBytes / 1_048_576), { entries: inserted })
  })

  try {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = normalizeKaikkiEntry(JSON.parse(line) as unknown)
        if (!record) {
          rejected += 1
          continue
        }
        batch.push(record)
        if (batch.length >= BATCH_SIZE) {
          writeBatch(batch)
          inserted += batch.length
          batch.length = 0
        }
      } catch (error) {
        rejected += 1
        if (rejected <= 5) console.warn(`Skipping malformed JSONL entry: ${String(error)}`)
      }
    }
    if (batch.length) {
      writeBatch(batch)
      inserted += batch.length
    }
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    progress.stop()
    db.close()
  }

  for (const suffix of ['', '-wal', '-shm']) removeIfPresent(`${destination}${suffix}`)
  await rename(temporaryDb, destination)
  console.log(`Indexed ${inserted.toLocaleString()} entries (${rejected} rejected).`)
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const databaseMissing = !existsSync(DICTIONARY_DB_PATH)
  if (options.download || options.forceDownload || databaseMissing) {
    await ensureDataset(options.forceDownload)
  }
  if (!existsSync(DICTIONARY_JSONL_PATH)) {
    throw new Error(`Dataset not found: ${DICTIONARY_JSONL_PATH}. Run with --download.`)
  }
  if (databaseMissing || options.rebuild || options.forceDownload) {
    await ingestDataset(DICTIONARY_JSONL_PATH, DICTIONARY_DB_PATH)
  } else {
    console.log(`Dictionary database already exists: ${DICTIONARY_DB_PATH}`)
    console.log('Use --rebuild to recreate it or --force-download to refresh both files.')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}