import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { initializeDictionarySchema, openDictionaryDb } from './db.ts'
import { lookupWord, searchWords } from './service.ts'
import { normalizeKaikkiEntry } from '../../scripts/setup-wiktionary.ts'


test('dictionary service returns exact entries and FTS prefix results', () => {
  const path = join(tmpdir(), `sift-dictionary-${process.pid}-${Date.now()}.db`)
  const db = openDictionaryDb(path)
  initializeDictionarySchema(db)
  const data = JSON.stringify({
    senses: [{ glosses: ['A self-evident or redundant statement.'], examples: [] }],
    ipa: ['/tɔːˈtɒlədʒi/'],
    synonyms: [],
    antonyms: [],
    derived: [],
    related: [],
  })
  const result = db.prepare(`
    INSERT INTO entries (word, pos, etymology, data)
    VALUES (?, ?, ?, ?)
  `).run('tautology', 'noun', 'From Greek.', data)
  db.prepare(`
    INSERT INTO entries_fts (rowid, word, etymology, glosses)
    VALUES (?, ?, ?, ?)
  `).run(result.lastInsertRowid, 'tautology', 'From Greek.', 'A self-evident statement.')
  db.close()

  try {
    const exact = lookupWord('Tautology', path)
    assert.equal(exact.length, 1)
    assert.deepEqual(exact[0]?.data.ipa, ['/tɔːˈtɒlədʒi/'])
    assert.equal(searchWords('taut', 5, path)[0]?.word, 'tautology')
    assert.equal(searchWords('evident', 5, path)[0]?.word, 'tautology')
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  }
})

test('Kaikki entries normalize nested senses, sounds, and relations', () => {
  const entry = normalizeKaikkiEntry({
    word: 'sift',
    pos: 'verb',
    etymology_text: 'From Old English.',
    senses: [{
      glosses: ['To separate material through a sieve.'],
      examples: [{ text: 'Sift the flour.', translation: 'Filter the flour.' }],
      synonyms: [{ word: 'filter' }],
      antonyms: [{ word: 'combine' }],
    }],
    sounds: [{ ipa: '/sɪft/' }, { ipa: '/sɪft/' }],
    derived: [{ word: 'sifter' }],
    related: ['sieve'],
  })

  assert.equal(entry?.word, 'sift')
  assert.deepEqual(entry?.data.ipa, ['/sɪft/'])
  assert.deepEqual(entry?.data.synonyms, ['filter'])
  assert.deepEqual(entry?.data.antonyms, ['combine'])
  assert.deepEqual(entry?.data.derived, ['sifter'])
  assert.deepEqual(entry?.data.related, ['sieve'])
  assert.equal(entry?.data.senses[0]?.examples[0]?.text, 'Sift the flour.')
})