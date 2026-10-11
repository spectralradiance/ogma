import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { usesInlineNotes, WritingStats } from './stats'

describe('single-file documents', () => {
  it('splits words by notes blocks instead of by file name', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-stats-')), 'stats.json')
    const stats = new WritingStats(file, () => new Date(2026, 8, 24, 10, 0))
    const first = 'one two\n\n::: notes\nthree four five\n:::\n'
    stats.recordSave('C:\\n\\Night Sky.md', null, first)
    stats.recordSave('C:\\n\\Night Sky.md', first, 'one two six\n\n::: notes\nthree\n:::\n')
    expect(stats.daily(1)).toEqual([{ day: '2026-09-24', notes: 1, output: 3 }])
  })

  it('only applies to plain, unnumbered Markdown files or files with notes blocks', () => {
    expect(usesInlineNotes('C:\\n\\Night Sky.md', null, 'text')).toBe(true)
    expect(usesInlineNotes('C:\\n\\1 era', null, 'text')).toBe(false)
    expect(usesInlineNotes('C:\\n\\1 era', null, '::: notes\nx\n:::')).toBe(true)
    expect(usesInlineNotes('C:\\n\\1 era-output.md', null, '::: notes\nx\n:::')).toBe(false)
  })
})
