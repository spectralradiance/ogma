import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { FolderModel, SectionInfo } from '../shared/ipc'
import { listDirectory } from './fileService'
import { buildFolderModel, planNewSection, planRename, planSwap, type RenameStep, validateTitle } from './sections'

export async function readFolder(folder: string): Promise<FolderModel> {
  return buildFolderModel(await listDirectory(folder))
}

async function existingNames(folder: string): Promise<string[]> {
  return (await listDirectory(folder)).map((entry) => entry.name)
}

function findSection(model: FolderModel, stem: string): SectionInfo {
  const section = model.sections.find((candidate) => candidate.stem.toLowerCase() === stem.toLowerCase())
  if (!section) throw new Error(`No section named “${stem}” in this folder.`)
  return section
}

/**
 * Renames in two phases through hidden temporary names, so swaps and case-only
 * renames never collide, and rolls everything back if any step fails.
 */
export async function applyRenames(folder: string, steps: RenameStep[]): Promise<void> {
  const tag = randomBytes(4).toString('hex')
  const staged = steps.map((step, index) => ({ ...step, temporary: `.${step.from}.oisin-rename-${tag}-${index}` }))
  const done: RenameStep[] = []
  try {
    for (const step of staged) {
      await rename(path.join(folder, step.from), path.join(folder, step.temporary))
      done.push({ from: step.from, to: step.temporary })
    }
    for (const step of staged) {
      await rename(path.join(folder, step.temporary), path.join(folder, step.to))
      done.push({ from: step.temporary, to: step.to })
    }
  } catch (error) {
    for (const step of done.reverse()) {
      await rename(path.join(folder, step.to), path.join(folder, step.from)).catch(() => {})
    }
    throw error
  }
}

export async function createSection(folder: string, title: string): Promise<SectionInfo> {
  const model = await readFolder(folder)
  const name = planNewSection(model, title, await existingNames(folder))
  await writeFile(path.join(folder, name), '', { flag: 'wx' })
  const created = (await readFolder(folder)).sections
    .find((section) => section.notes?.toLowerCase() === name.toLowerCase())
  if (!created) throw new Error('The new section could not be found after creating it.')
  return created
}

export async function renameSection(folder: string, stem: string, title: string): Promise<SectionInfo> {
  const section = findSection(await readFolder(folder), stem)
  const steps = planRename(section, title, await existingNames(folder))
  await applyRenames(folder, steps)
  const newStem = section.ordinal === null ? title.trim() : `${section.ordinal}${section.separator || ' '}${title.trim()}`
  return findSection(await readFolder(folder), steps.length > 0 ? newStem : section.stem)
}

/** Moves a numbered section one place by swapping ordinals with its numbered neighbour. */
export async function moveSection(folder: string, stem: string, direction: 'up' | 'down'): Promise<SectionInfo> {
  const model = await readFolder(folder)
  const numbered = model.sections.filter((section) => section.ordinal !== null)
  const index = numbered.findIndex((section) => section.stem.toLowerCase() === stem.toLowerCase())
  if (index < 0) throw new Error('Only numbered sections can be reordered.')
  const neighbour = numbered[direction === 'up' ? index - 1 : index + 1]
  if (!neighbour) return numbered[index]
  const section = numbered[index]
  const steps = planSwap(section, neighbour, await existingNames(folder))
  await applyRenames(folder, steps)
  return findSection(await readFolder(folder), `${neighbour.ordinal}${section.separator || ' '}${section.title}`)
}

export async function trashSection(folder: string, stem: string, trash: (file: string) => Promise<void>): Promise<void> {
  const section = findSection(await readFolder(folder), stem)
  for (const name of [section.notes, section.output]) {
    if (name) await trash(path.join(folder, name))
  }
}

export async function createFolder(parent: string, name: string): Promise<string> {
  const error = validateTitle(name)
  if (error) throw new Error(error)
  const target = path.join(parent, name.trim())
  await mkdir(target)
  return target
}
