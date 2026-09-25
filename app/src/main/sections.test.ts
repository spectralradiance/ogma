import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FolderModel } from '../shared/ipc'
import {
  buildFolderModel,
  type FolderEntryName,
  parseFileName,
  parseOrdinal,
  planNewSection,
  planRename,
  planSwap,
  splitExtension,
  validateTitle,
} from './sections'
import { isIgnoredChange } from './watcher'
import { BackupStore, PathGuard } from './fileService'
import { applyRenames, createFolder, createSection, mergeSections, moveSection, readFolder, renameSection, trashSection } from './workspaceService'

const files = (...names: string[]): FolderEntryName[] => names.map((name) => ({ name, kind: 'file' }))
const summary = (model: FolderModel) => model.sections.map((s) => `${s.stem} [${s.notes ?? '-'} | ${s.output ?? '-'}]`)

describe('file name parsing', () => {
  it('only treats short alphanumeric suffixes as extensions', () => {
    expect(splitExtension('1 the first era')).toEqual({ base: '1 the first era', extension: '' })
    expect(splitExtension('1.2 the solar system')).toEqual({ base: '1.2 the solar system', extension: '' })
    expect(splitExtension('intro-notes.md')).toEqual({ base: 'intro-notes', extension: '.md' })
  })

  it('recognizes -notes and -output suffixes', () => {
    expect(parseFileName('02 intro-notes.md')).toEqual({ stem: '02 intro', role: 'notes' })
    expect(parseFileName('02 intro-OUTPUT.md')).toEqual({ stem: '02 intro', role: 'output' })
    expect(parseFileName('field notes.txt')).toEqual({ stem: 'field notes', role: 'plain' })
  })

  it('splits ordinals, separators and titles', () => {
    expect(parseOrdinal('1 the first era')).toEqual({ ordinal: '1', separator: ' ', title: 'the first era' })
    expect(parseOrdinal('1.2 the solar system')).toEqual({ ordinal: '1.2', separator: ' ', title: 'the solar system' })
    expect(parseOrdinal('02-intro')).toEqual({ ordinal: '02', separator: '-', title: 'intro' })
    expect(parseOrdinal('001')).toEqual({ ordinal: '001', separator: '', title: '' })
    expect(parseOrdinal('outline')).toEqual({ ordinal: null, separator: '', title: 'outline' })
  })
})

describe('buildFolderModel', () => {
  it('reads the existing universal metaphysics layout as-is', () => {
    const model = buildFolderModel([
      ...files('0 introduction', '1 the first era', '10 the tenth era', '2 the second era', 'outline', 'random'),
      { name: '1 universal narrative', kind: 'dir' },
    ])
    expect(summary(model)).toEqual([
      '0 introduction [0 introduction | -]',
      '1 the first era [1 the first era | -]',
      '2 the second era [2 the second era | -]',
      '10 the tenth era [10 the tenth era | -]',
    ])
    expect(model.sections[1]).toMatchObject({ title: 'the first era', outputName: '1 the first era-output.md' })
    expect(model.documentNotes).toEqual(['outline', 'random'])
    expect(model.subdocuments).toEqual([{ name: '1 universal narrative', ordinal: '1', title: 'universal narrative' }])
  })

  it('pairs notes and output files, including unnumbered suffixed pairs', () => {
    const model = buildFolderModel(files(
      '01 intro-notes.md', '01 intro-output.md', '02 body.md', '02 body-output.md', 'glossary-notes.md', 'introduction.txt',
    ))
    expect(summary(model)).toEqual([
      '01 intro [01 intro-notes.md | 01 intro-output.md]',
      '02 body [02 body.md | 02 body-output.md]',
      'glossary [glossary-notes.md | -]',
    ])
    expect(model.documentNotes).toEqual(['introduction.txt'])
  })

  it('orders dotted ordinals numerically', () => {
    const model = buildFolderModel(files('1.10 x', '1.2 y', '1 z', '2 w'))
    expect(model.sections.map((s) => s.ordinal)).toEqual(['1', '1.2', '1.10', '2'])
  })

  it('keeps duplicate files visible as document notes instead of hiding them', () => {
    const model = buildFolderModel(files('1 era', '1 era.md', '1 era-notes.md'))
    expect(model.sections[0].notes).toBe('1 era-notes.md')
    expect(model.documentNotes).toEqual(['1 era', '1 era.md'])
  })
})

describe('rename planning', () => {
  const model = buildFolderModel(files('1 alpha', '1 alpha-output.md', '02-beta-notes.md', 'outline'))
  const [alpha, beta] = model.sections
  const existing = ['1 alpha', '1 alpha-output.md', '02-beta-notes.md', 'outline']

  it('renames both files and keeps the ordinal', () => {
    expect(planRename(alpha, 'Alpha Centauri', existing)).toEqual([
      { from: '1 alpha', to: '1 Alpha Centauri' },
      { from: '1 alpha-output.md', to: '1 Alpha Centauri-output.md' },
    ])
  })

  it('rejects collisions and unusable names', () => {
    expect(() => planRename(alpha, 'x', [...existing, '1 x'])).toThrow(/already exists/)
    expect(() => planRename(alpha, 'a/b', existing)).toThrow(/cannot contain/)
    expect(validateTitle('ends with dot.')).toMatch(/dot/)
    expect(validateTitle('CON')).toMatch(/reserved/)
  })

  it('swaps ordinals while keeping each section’s own separator and padding', () => {
    expect(planSwap(alpha, beta, existing)).toEqual([
      { from: '1 alpha', to: '02 alpha' },
      { from: '1 alpha-output.md', to: '02 alpha-output.md' },
      { from: '02-beta-notes.md', to: '1-beta-notes.md' },
    ])
  })

  it('numbers new sections after the last one in the siblings’ style', () => {
    // Mixed siblings ("1 alpha", "02-beta"): padding wins, and a -notes sibling means -notes.
    expect(planNewSection(model, 'gamma', existing)).toBe('03 gamma-notes.md')
    const padded = buildFolderModel(files('01 a', '02 b'))
    expect(planNewSection(padded, 'c', ['01 a', '02 b'])).toBe('03 c.md')
    expect(planNewSection(buildFolderModel([]), 'first', [])).toBe('1 first.md')
  })
})

describe('isIgnoredChange', () => {
  it('ignores Oisín temp files and tool folders', () => {
    expect(isIgnoredChange('C:\\n\\.a.md.oisin-1a2b.tmp')).toBe(true)
    expect(isIgnoredChange('C:\\n\\.git\\index')).toBe(true)
    expect(isIgnoredChange('C:\\n\\1 the first era')).toBe(false)
  })
})

describe('workspace operations on disk', () => {
  async function folderWith(...names: string[]) {
    const folder = await mkdtemp(path.join(tmpdir(), 'oisin-sections-'))
    for (const name of names) await writeFile(path.join(folder, name), name)
    return folder
  }
  const listing = async (folder: string) => (await readdir(folder)).sort()

  it('moves a section by swapping ordinals, with both files following', async () => {
    const folder = await folderWith('1 alpha', '1 alpha-output.md', '2 beta')
    const moved = await moveSection(folder, '2 beta', 'up')
    expect(moved).toMatchObject({ stem: '1 beta', notes: '1 beta' })
    expect(await listing(folder)).toEqual(['1 beta', '2 alpha', '2 alpha-output.md'])
    expect(await moveSection(folder, '1 beta', 'up')).toMatchObject({ stem: '1 beta' })
  })

  it('renames sections, including case-only changes on Windows', async () => {
    const folder = await folderWith('1 alpha', '1 alpha-output.md')
    expect(await renameSection(folder, '1 alpha', 'Alpha')).toMatchObject({ stem: '1 Alpha', output: '1 Alpha-output.md' })
    expect(await listing(folder)).toEqual(['1 Alpha', '1 Alpha-output.md'])
  })

  it('rolls back every step when a rename fails part way', async () => {
    const folder = await folderWith('a', 'b')
    await expect(applyRenames(folder, [{ from: 'a', to: 'x' }, { from: 'missing', to: 'y' }])).rejects.toThrow()
    expect(await listing(folder)).toEqual(['a', 'b'])
  })

  it('creates sections and folders, and trashes both files of a section', async () => {
    const folder = await folderWith('01 a')
    expect(await createSection(folder, 'b')).toMatchObject({ stem: '02 b', notes: '02 b.md' })
    await createFolder(folder, '3 chapter three')
    await mkdir(path.join(folder, 'empty')).catch(() => {})
    expect((await readFolder(folder)).subdocuments.map((d) => d.name)).toEqual(['3 chapter three', 'empty'])

    const trashed: string[] = []
    await writeFile(path.join(folder, '01 a-output.md'), '')
    await trashSection(folder, '01 a', async (file) => { trashed.push(path.basename(file)) })
    expect(trashed).toEqual(['01 a', '01 a-output.md'])
  })
})

describe('mergeSections', () => {
  it('appends the later section to the earlier one, keeping its encoding, then trashes the later files', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'oisin-merge-'))
    await writeFile(path.join(folder, '1 first'), Buffer.from([0x49, 0x92, 0x6d, 0x0d, 0x0a]))
    await writeFile(path.join(folder, '2 second'), 'second notes\n')
    await writeFile(path.join(folder, '2 second-output.md'), 'Second output.\n')
    const backups = new BackupStore(path.join(folder, '..', `backups-${path.basename(folder)}`), new PathGuard(() => [folder]))
    const trashed: string[] = []
    const merged = await mergeSections(folder, '1 first', '2 second', backups, async (file) => {
      trashed.push(path.basename(file))
      await rm(file)
    })
    expect(merged).toMatchObject({ stem: '1 first', output: '1 first-output.md' })
    expect(await readFile(path.join(folder, '1 first'))).toEqual(Buffer.from('I\x92m\r\n\r\nsecond notes\r\n', 'latin1'))
    expect(await readFile(path.join(folder, '1 first-output.md'), 'utf8')).toBe('Second output.\n')
    expect(trashed.sort()).toEqual(['2 second', '2 second-output.md'])
    await expect(mergeSections(folder, '1 first', '1 first', backups, async () => {})).rejects.toThrow(/two different/)
  })
})
