import type Database from 'better-sqlite3'

import {
  DICTIONARY_DB_PATH,
  openDictionaryDb,
  type DictionaryEntryData,
  type DictionaryEntryRow,
} from './db.ts'


export interface DictionaryEntry extends Omit<DictionaryEntryRow, 'data'> {
  data: DictionaryEntryData
}

export interface DictionarySearchResult {
  id: number
  word: string
  pos: string | null
  gloss: string
}

function parseEntry(row: DictionaryEntryRow): DictionaryEntry {
  return { ...row, data: JSON.parse(row.data) as DictionaryEntryData }
}

function ftsPrefixQuery(query: string): string {
  return query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' ') ?? ''
}

export function lookupWord(
  word: string,
  dbPath = DICTIONARY_DB_PATH,
): DictionaryEntry[] {
  const normalized = word.normalize('NFKC').trim()
  if (!normalized) return []

  const db = openDictionaryDb(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`
      SELECT id, word, pos, etymology, data
      FROM entries
      WHERE word = ? COLLATE NOCASE
      ORDER BY id
    `).all(normalized) as DictionaryEntryRow[]
    return rows.map(parseEntry)
  } finally {
    db.close()
  }
}

export function searchWords(
  query: string,
  limit = 20,
  dbPath = DICTIONARY_DB_PATH,
): DictionarySearchResult[] {
  const match = ftsPrefixQuery(query)
  if (!match) return []
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100)

  const db = openDictionaryDb(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`
      SELECT
        entries.id,
        entries.word,
        entries.pos,
        snippet(entries_fts, 2, '', '', ' … ', 18) AS gloss
      FROM entries_fts
      JOIN entries ON entries.id = entries_fts.rowid
      WHERE entries_fts MATCH ?
      ORDER BY CASE WHEN entries.word LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
               bm25(entries_fts),
               length(entries.word),
               entries.word
      LIMIT ?
    `).all(match, `${escapeLike(query.trim())}%`, boundedLimit) as DictionarySearchResult[]
  } finally {
    db.close()
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function getDefinition(word: string, dbPath?: string): DictionaryEntry[] {
  return lookupWord(word, dbPath)
}

export function searchPrefix(
  prefix: string,
  limit?: number,
  dbPath?: string,
): DictionarySearchResult[] {
  return searchWords(prefix, limit, dbPath)
}

export function withDictionaryDb<T>(
  callback: (db: Database.Database) => T,
  dbPath = DICTIONARY_DB_PATH,
): T {
  const db = openDictionaryDb(dbPath, { readonly: true, fileMustExist: true })
  try {
    return callback(db)
  } finally {
    db.close()
  }
}