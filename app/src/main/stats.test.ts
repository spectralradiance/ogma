import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { localDay, WritingStats } from './stats'

async function statsFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), 'ogma-stats-')), 'stats.json')
}

describe('localDay', () => {
  it('formats local dates', () => {
    expect(localDay(new Date(2026, 8, 5))).toBe('2026-09-05')
  })
})

describe('WritingStats', () => {
  it('adds up net words per day, split by notes blocks, including cuts, and persists', async () => {
    const file = await statsFile()
    let now = new Date(2026, 8, 24, 22, 0)
    const stats = new WritingStats(file, () => now)
    const first = 'one two\n\n::: notes\nthree four five\n:::\n'
    stats.recordSave(null, first)
    stats.recordSave(first, 'one two six\n\n::: notes\nthree\n:::\n')
    stats.recordSave('same', 'same')
    now = new Date(2026, 8, 25, 9, 0)
    stats.recordSave('', 'new day')

    const reloaded = new WritingStats(file, () => now)
    expect(reloaded.daily(3)).toEqual([
      { day: '2026-09-23', notes: 0, output: 0 },
      { day: '2026-09-24', notes: 1, output: 3 },
      { day: '2026-09-25', notes: 0, output: 2 },
    ])
  })

  it('reports per-section counts for a document, with its goal', async () => {
    const document = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-stats-doc-')), 'Night Sky.md')
    await writeFile(document, '# first\n\ntwo words\n\n::: notes\nfour words of notes\n:::\n\n# second\n\n::: notes\nx\n:::\n')
    const stats = new WritingStats(await statsFile())
    stats.setGoal(document, 3000)
    const result = await stats.documentStats(document)
    expect(result).toMatchObject({ notesWords: 5, outputWords: 4, goal: 3000 })
    expect(result.sections).toEqual([
      { title: 'first', line: 1, hasText: true, notesWords: 4, outputWords: 3 },
      { title: 'second', line: 9, hasText: false, notesWords: 1, outputWords: 1 },
    ])
    expect(result.modified).not.toBeNull()
    stats.setGoal(document, null)
    expect(stats.goal(document)).toBeNull()
  })
})
