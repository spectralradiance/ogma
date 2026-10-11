import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { splitSections } from '../shared/document'
import { convertToSingleDocument } from './workspaceService'

async function makeFolder() {
  const root = await mkdtemp(path.join(tmpdir(), 'ogma-convert-'))
  const folder = path.join(root, '1 Night Sky')
  await mkdir(folder)
  await writeFile(path.join(folder, '01 First Light-notes.md'), 'Dawn notes.\n\n# a notes heading\n')
  await writeFile(path.join(folder, '01 First Light-output.md'), '# First Light\n\nThe sun rises.\n')
  await writeFile(path.join(folder, '02 Stars-notes.md'), 'Only notes here.\n')
  await writeFile(path.join(folder, 'outline.md'), 'Dawn, then stars.\n')
  return { root, folder }
}

describe('convertToSingleDocument', () => {
  it('writes one file next to the folder with a section per heading and notes inline', async () => {
    const { root, folder } = await makeFolder()
    const result = await convertToSingleDocument(folder)
    expect(result).toEqual({ path: path.join(root, 'Night Sky.md'), created: true, sections: 2, subfolders: 0 })

    const sections = splitSections(await readFile(result.path, 'utf8'))
    expect(sections.map((section) => section.title)).toEqual([null, 'First Light', 'Stars'])
    expect(sections[0].notes).toContain('Dawn, then stars.')
    expect(sections[1]).toMatchObject({ output: 'The sun rises.' })
    expect(sections[1].notes).toContain('Dawn notes.')
    expect(sections[2]).toMatchObject({ output: '', notes: 'Only notes here.' })
  })

  it('does not overwrite an existing file', async () => {
    const { root, folder } = await makeFolder()
    await writeFile(path.join(root, 'Night Sky.md'), 'mine')
    await expect(convertToSingleDocument(folder)).rejects.toThrow('already exists')
    expect(await readFile(path.join(root, 'Night Sky.md'), 'utf8')).toBe('mine')
  })

  it('refuses a folder without sections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ogma-convert-'))
    await expect(convertToSingleDocument(root)).rejects.toThrow('no sections')
  })
})
