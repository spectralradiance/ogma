import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { localDay, roleOf, WritingStats } from './stats'

async function statsFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), 'oisin-stats-')), 'stats.json')
}

describe('roleOf and localDay', () => {
  it('classifies files and formats local dates', () => {
    expect(roleOf('C:\\n\\1 era-output.md')).toBe('output')
    expect(roleOf('C:\\n\\1 era')).toBe('notes')
    expect(roleOf('C:\\n\\outline.md')).toBe('notes')
    expect(localDay(new Date(2026, 8, 5))).toBe('2026-09-05')
  })
})

describe('WritingStats', () => {
  it('adds up net words per day and role, including cuts, and persists', async () => {
    const file = await statsFile()
    let now = new Date(2026, 8, 24, 22, 0)
    const stats = new WritingStats(file, () => now)
    stats.recordSave('C:\\n\\1 a-output.md', null, 'one two three')
    stats.recordSave('C:\\n\\1 a-output.md', 'one two three', 'one two three four five')
    stats.recordSave('C:\\n\\1 a', 'a b c d', 'a b')
    stats.recordSave('C:\\n\\1 a', 'same', 'same')
    now = new Date(2026, 8, 25, 9, 0)
    stats.recordSave('C:\\n\\2 b-output.md', '', 'new day')

    const reloaded = new WritingStats(file, () => now)
    expect(reloaded.daily(3)).toEqual([
      { day: '2026-09-23', notes: 0, output: 0 },
      { day: '2026-09-24', notes: -2, output: 5 },
      { day: '2026-09-25', notes: 0, output: 2 },
    ])
  })

  it('reports per-section counts for a document, with its goal', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'oisin-stats-doc-'))
    await writeFile(path.join(folder, '1 first'), 'four words of notes')
    await writeFile(path.join(folder, '1 first-output.md'), 'two words')
    await writeFile(path.join(folder, '2 second-notes.md'), 'x')
    const stats = new WritingStats(await statsFile())
    stats.setGoal(folder, 3000)
    const result = await stats.documentStats(folder)
    expect(result).toMatchObject({ notesWords: 5, outputWords: 2, goal: 3000 })
    expect(result.sections.map((section) => [section.title, section.notesWords, section.outputWords])).toEqual([
      ['first', 4, 2],
      ['second', 1, 0],
    ])
    expect(result.sections[0].modified).not.toBeNull()
    stats.setGoal(folder, null)
    expect(stats.goal(folder)).toBeNull()
  })
})
