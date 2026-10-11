import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { parseEtymology, parseTreeLine } from '../shared/etymology'
import type { LexiconEntry } from '../shared/ipc'
import { lexiconFileName, matchesLexiconQuery, parseLexiconFile, serializeLexiconEntry } from '../shared/lexicon'
import { Dictionary, lookupVariants, prefixQuery } from './dictionary'
import { LexiconStore } from './lexicon'

async function fixtureDictionary(): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-dict-')), 'wiktionary.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY, word TEXT NOT NULL, pos TEXT, etymology TEXT, data JSON NOT NULL);
    CREATE VIRTUAL TABLE entries_fts USING fts5(word, etymology, glosses, tokenize = 'unicode61 remove_diacritics 2');
    CREATE INDEX idx_word ON entries(word);
  `)
  const insert = db.prepare('INSERT INTO entries (id, word, pos, etymology, data) VALUES (?, ?, ?, ?, ?)')
  const fts = db.prepare('INSERT INTO entries_fts (rowid, word, etymology, glosses) VALUES (?, ?, ?, ?)')
  const rows: [number, string, string, string, object][] = [
    [1, 'melancholy', 'noun', 'From Middle English malencolie.', {
      senses: [{ glosses: ['Great sadness or depression.'], examples: [{ text: 'A deep melancholy.' }] }],
      ipa: ['/ˈmɛlənkəli/'], synonyms: ['sadness', 'melancholy', ':Category:Moods'], antonyms: ['joy'], derived: [], related: [],
    }],
    [2, 'melancholy', 'adj', null as unknown as string, { senses: [{ glosses: ['Gloomy.'], examples: [] }], ipa: [], synonyms: [], antonyms: [], derived: [], related: [] }],
    [3, 'Aisling', 'noun', 'From Irish.', { senses: [{ glosses: ['A vision poem.'], examples: [] }] }],
    [4, 'melancholic', 'adj', '', { senses: [{ glosses: ['Affected with melancholy.'], examples: [] }] }],
  ]
  for (const [id, word, pos, etymology, data] of rows) {
    insert.run(id, word, pos, etymology, JSON.stringify(data))
    fts.run(id, word, etymology ?? '', (data as { senses: { glosses: string[] }[] }).senses.flatMap((s) => s.glosses).join(' '))
  }
  db.close()
  return file
}

describe('Dictionary', () => {
  it('finds case variants through the index and cleans relation lists', async () => {
    const dictionary = new Dictionary(await fixtureDictionary())
    const entries = dictionary.lookup('Melancholy.')
    expect(entries.map((entry) => entry.pos)).toEqual(['noun', 'adj'])
    expect(entries[0]).toMatchObject({ ipa: ['/ˈmɛlənkəli/'], synonyms: ['sadness'], antonyms: ['joy'] })
    expect(dictionary.lookup('aisling')[0].word).toBe('Aisling')
    expect(dictionary.lookup('   ')).toEqual([])
    dictionary.close()
  })

  it('searches by prefix with one row per word and part of speech', async () => {
    const dictionary = new Dictionary(await fixtureDictionary())
    const results = dictionary.search('melanch')
    expect(results.map((result) => `${result.word}/${result.pos}`).sort()).toEqual(['melancholic/adj', 'melancholy/adj', 'melancholy/noun'])
    expect(dictionary.search('vision').map((result) => result.word)).toEqual(['Aisling'])
    dictionary.close()
  })

  it('builds variants and FTS queries safely', () => {
    expect(lookupVariants('“Star”,')).toEqual(['Star', 'star'])
    expect(prefixQuery('black "bile"')).toBe('"black"* "bile"*')
    expect(() => new Dictionary('Z:\\missing\\wiktionary.db')).toThrow(/not found/)
  })
})

describe('parseEtymology', () => {
  const star = 'Etymology tree\nProto-Indo-European *h₂stḗr\nProto-Germanic *sternǭ\nOld English steorra\nMiddle English sterre\nEnglish star\nFrom Middle English sterre, from Old English steorra (“star”).\nCognates\nCognate with Scots starn.'

  it('splits the tree, prose and cognates', () => {
    const parsed = parseEtymology(star, 'star')
    expect(parsed.tree).toEqual([
      { language: 'Proto-Indo-European', term: '*h₂stḗr' },
      { language: 'Proto-Germanic', term: '*sternǭ' },
      { language: 'Old English', term: 'steorra' },
      { language: 'Middle English', term: 'sterre' },
      { language: 'English', term: 'star' },
    ])
    expect(parsed.prose).toBe('From Middle English sterre, from Old English steorra (“star”).')
    expect(parsed.cognates).toBe('Cognate with Scots starn.')
  })

  it('handles prose-only text, empty text and leaked template labels', () => {
    expect(parseEtymology('From Old French melancolie.', 'melancholy')).toEqual({ tree: [], prose: 'From Old French melancolie.', cognates: null })
    expect(parseEtymology(null)).toEqual({ tree: [], prose: '', cognates: null })
    expect(parseTreeLine('Latin nucleuslbor.')).toEqual({ language: 'Latin', term: 'nucleus' })
  })
})

const entry: LexiconEntry = {
  word: 'melancholy',
  definition: 'Great sadness.',
  tags: ['emotion', 'mood'],
  synonyms: ['gloom'],
  context: 'A “deep” melancholy settled: over the valley.',
  source: 'C:\\notes\\1 the first era',
  added: '2026-09-25',
  note: 'From the Greek for *black bile*.',
}

describe('lexicon files', () => {
  it('round-trip through Markdown front matter', () => {
    const text = serializeLexiconEntry(entry)
    expect(text.startsWith('---\nword: "melancholy"\n')).toBe(true)
    expect(parseLexiconFile(text)).toEqual(entry)
  })

  it('accept hand-edited YAML', () => {
    const parsed = parseLexiconFile('---\nword: tranquil\ntags: [calm, peace]\n---\nnotes')
    expect(parsed).toMatchObject({ word: 'tranquil', tags: ['calm', 'peace'], note: 'notes', source: null })
    expect(parseLexiconFile('no front matter')).toBeNull()
  })

  it('make safe file names', () => {
    expect(lexiconFileName('what/ever?')).toBe('what_ever_.md')
  })

  it('support Aisling-style prefixed search', () => {
    expect(matchesLexiconQuery(entry, 'tag:emo')).toBe(true)
    expect(matchesLexiconQuery(entry, 'syn:gloom word:mel')).toBe(true)
    expect(matchesLexiconQuery(entry, 'def:joy')).toBe(false)
    expect(matchesLexiconQuery(entry, 'bile')).toBe(true)
  })
})

describe('LexiconStore', () => {
  it('saves, lists, replaces and imports Aisling vocabulary', async () => {
    const store = new LexiconStore(path.join(await mkdtemp(path.join(tmpdir(), 'ogma-lexicon-')), 'lexicon'))
    expect(await store.list()).toEqual([])
    await store.save(entry)
    await store.save({ ...entry, definition: 'Updated.', tags: ['mood', 'mood', ' '] })
    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ definition: 'Updated.', tags: ['mood'] })

    const aisling = await mkdtemp(path.join(tmpdir(), 'ogma-aisling-'))
    await cp('C:\\Users\\snowb\\Programs\\text editors\\aisling\\Aisling\\Vocabulary', aisling, { recursive: true })
      .catch(async () => {
        await writeFile(path.join(aisling, 'Calm.json'), JSON.stringify({ word: 'Calm', definition: 'Still.', tags: 'emotion, peace', synonyms: 'peaceful, tranquil' }))
      })
    await writeFile(path.join(aisling, 'Melancholy.json'), JSON.stringify({ word: 'melancholy', definition: 'dup' }))
    await writeFile(path.join(aisling, 'broken.json'), '{ not json')
    const result = await store.importAisling(aisling)
    const jsonFiles = (await readdir(aisling)).filter((name) => name.endsWith('.json')).length
    expect(result.imported + result.skipped).toBe(jsonFiles)
    expect(result.skipped).toBeGreaterThanOrEqual(2)

    const calm = (await store.list()).find((item) => item.word === 'Calm')
    expect(calm?.tags).toContain('emotion')
    expect(calm?.synonyms).toContain('tranquil')
    expect(await readFile(path.join(store.location, 'melancholy.md'), 'utf8')).toContain('Updated.')
  })
})
