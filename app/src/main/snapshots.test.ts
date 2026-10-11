import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SnapshotStore } from './snapshots'

async function store(start = Date.parse('2026-09-25T10:00:00Z')) {
  let now = start
  const snapshots = new SnapshotStore(path.join(await mkdtemp(path.join(tmpdir(), 'ogma-snap-')), 'snapshots'), () => now)
  return { snapshots, advance: (minutes: number) => { now += minutes * 60_000 } }
}

const FILE = 'C:\\notes\\1 the first era-output.md'

describe('SnapshotStore', () => {
  it('takes an automatic snapshot on save at most every ten minutes', async () => {
    const { snapshots, advance } = await store()
    expect(await snapshots.afterSave(FILE, 'one')).toMatchObject({ words: 1, label: null })
    advance(5)
    expect(await snapshots.afterSave(FILE, 'one two')).toBeNull()
    advance(6)
    expect(await snapshots.afterSave(FILE, 'one two three')).toMatchObject({ words: 3 })
    const list = await snapshots.list(FILE)
    expect(list.map((entry) => entry.words)).toEqual([3, 1])
    expect(await snapshots.read(FILE, list[1].id)).toBe('one')
  })

  it('skips an automatic snapshot identical to the latest one', async () => {
    const { snapshots, advance } = await store()
    await snapshots.afterSave(FILE, 'same')
    advance(20)
    expect(await snapshots.afterSave(FILE, 'same')).toBeNull()
  })

  it('keeps manual snapshots with labels, separate per file and case-insensitive on Windows paths', async () => {
    const { snapshots } = await store()
    await snapshots.manual(FILE, 'draft one', '  before rewrite ')
    await snapshots.manual(FILE, 'draft two', '')
    expect((await snapshots.list(FILE)).map((entry) => entry.label)).toEqual(['Snapshot', 'before rewrite'])
    if (process.platform === 'win32') expect(await snapshots.list(FILE.toUpperCase())).toHaveLength(2)
    expect(await snapshots.list('C:\\notes\\other.md')).toEqual([])
  })

  it('prunes old automatic snapshots but never manual ones', async () => {
    const { snapshots, advance } = await store()
    await snapshots.manual(FILE, 'keep me', 'milestone')
    for (let i = 0; i < 103; i += 1) {
      await snapshots.afterSave(FILE, `version ${i}`)
      advance(11)
    }
    const list = await snapshots.list(FILE)
    expect(list.filter((entry) => entry.label === null)).toHaveLength(100)
    expect(list.some((entry) => entry.label === 'milestone')).toBe(true)
    expect(await snapshots.read(FILE, list[0].id)).toBe('version 102')
  })

  it('rejects ids that could escape the folder', async () => {
    const { snapshots } = await store()
    await expect(snapshots.read(FILE, '..\\..\\secrets')).rejects.toThrow(/Invalid/)
  })
})
