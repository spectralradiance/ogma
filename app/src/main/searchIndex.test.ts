import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { chunkText, MATCH_END, MATCH_START, matchQuery, relatedQuery, SearchIndex } from './searchIndex'

describe('chunkText', () => {
  it('splits paragraphs and records their starting lines', () => {
    expect(chunkText('# Title\n\nFirst para\ncontinues\n\n\nSecond')).toEqual([
      { line: 1, text: '# Title' },
      { line: 3, text: 'First para\ncontinues' },
      { line: 7, text: 'Second' },
    ])
  })

  it('splits very long paragraphs', () => {
    expect(chunkText('x'.repeat(4500))).toHaveLength(3)
  })
})

describe('queries', () => {
  it('quote every token so FTS syntax in user input is harmless', () => {
    expect(matchQuery('star* OR "light"')).toBe('"star"* "OR"* "light"*')
    expect(matchQuery('  ')).toBe('')
  })

  it('pick the frequent content words of a passage', () => {
    const query = relatedQuery('The wandering planets wander. Planets drift; planets are wanderers of the night night.', 3)
    expect(query).toBe('"planets" OR "night" OR "drift"')
  })
})

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'ogma-search-'))
  const index = new SearchIndex(path.join(await mkdtemp(path.join(tmpdir(), 'ogma-searchdb-')), 'search.db'))
  await mkdir(path.join(root, 'Night Sky'))
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(root, 'Night Sky', '1 planets-notes.md'), 'planets wander against the fixed stars\n\nretrograde motion')
  await writeFile(path.join(root, 'Night Sky', '1 planets-output.md'), 'The wanderers drift through the constellations.')
  await writeFile(path.join(root, 'journal'), 'Saw Venus tonight; planets do not twinkle.')
  await writeFile(path.join(root, 'old.txt'), Buffer.from([0x49, 0x92, 0x6d, 0x20, 0x70, 0x6c, 0x61, 0x6e, 0x65, 0x74, 0x73]))
  await writeFile(path.join(root, '.git', 'planets'), 'hidden')
  await writeFile(path.join(root, 'photo.png'), 'planets')
  return { root, index }
}

describe('SearchIndex', () => {
  it('indexes text files (any encoding), skips hidden and non-text files, and ranks matches', async () => {
    const { root, index } = await workspace()
    await index.sync([root])
    expect(index.status()).toMatchObject({ files: 4, indexing: false, ready: true })

    const hits = index.search('planet')
    expect(hits.map((hit) => path.basename(hit.path)).sort()).toEqual(['1 planets-notes.md', 'journal', 'old.txt'])
    const notes = hits.find((hit) => hit.path.endsWith('notes.md'))!
    expect(notes.line).toBe(1)
    expect(notes.snippet).toContain(`${MATCH_START}planets${MATCH_END}`)
    expect(index.search('retrograde')[0].line).toBe(3)
    index.close()
  })

  it('updates incrementally and forgets deleted files and removed roots', async () => {
    const { root, index } = await workspace()
    await index.sync([root])
    const journal = path.join(root, 'journal')
    await writeFile(journal, 'Now about comets instead.')
    const later = new Date(Date.now() + 5000)
    await utimes(journal, later, later)
    await index.sync([root])
    expect(index.search('comets').map((hit) => hit.path)).toEqual([journal])
    expect(index.search('venus')).toEqual([])

    await rm(journal)
    await index.updateFile(journal, [root])
    expect(index.search('comets')).toEqual([])

    await index.sync([])
    expect(index.status().files).toBe(0)
    index.close()
  })

  it('finds related paragraphs in other files, one per file', async () => {
    const { root, index } = await workspace()
    await index.sync([root])
    const notes = path.join(root, 'Night Sky', '1 planets-notes.md')
    const related = index.related('Planets wander; the planets move against the stars.', [notes])
    const names = related.map((hit) => path.basename(hit.path))
    expect(names).not.toContain('1 planets-notes.md')
    expect(names).toContain('journal')
    expect(new Set(names).size).toBe(names.length)
    index.close()
  })
})
