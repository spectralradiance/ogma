import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'


const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const DICTIONARY_DATA_DIR = resolve(PROJECT_DIR, 'data')
export const DICTIONARY_JSONL_PATH = resolve(DICTIONARY_DATA_DIR, 'wiktionary.jsonl')
export const DICTIONARY_DB_PATH = resolve(DICTIONARY_DATA_DIR, 'wiktionary.db')

export interface DictionaryExample {
  text: string
  translation?: string
}

export interface DictionarySense {
  glosses: string[]
  examples: DictionaryExample[]
}

export interface DictionaryEntryData {
  senses: DictionarySense[]
  ipa: string[]
  synonyms: string[]
  antonyms: string[]
  derived: string[]
  related: string[]
}

export interface DictionaryEntryRow {
  id: number
  word: string
  pos: string | null
  etymology: string | null
  data: string
}

export function openDictionaryDb(
  path = DICTIONARY_DB_PATH,
  options: Database.Options = {},
): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, options)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -64000')
  return db
}

export function initializeDictionarySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      word TEXT NOT NULL,
      pos TEXT,
      etymology TEXT,
      data JSON NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      word,
      etymology,
      glosses,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE INDEX IF NOT EXISTS idx_word ON entries(word);
  `)
}