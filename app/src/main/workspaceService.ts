import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { FolderModel, SectionInfo } from '../shared/ipc'
import { type LeadingHeading, splitLeadingHeading, withLeadingHeading } from '../shared/text'
import { type BackupStore, listDirectory, readTextDocument, writeTextDocument } from './fileService'
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

/**
 * Renames both files of a section. With `backups`, the section's heading (a
 * heading on the output's first line) is changed to the new title too.
 */
export async function renameSection(folder: string, stem: string, title: string, backups?: BackupStore): Promise<SectionInfo> {
  const section = findSection(await readFolder(folder), stem)
  const steps = planRename(section, title, await existingNames(folder))
  await applyRenames(folder, steps)
  const newStem = section.ordinal === null ? title.trim() : `${section.ordinal}${section.separator || ' '}${title.trim()}`
  const renamed = findSection(await readFolder(folder), steps.length > 0 ? newStem : section.stem)
  if (backups && renamed.output) {
    const current = await readTextDocument(path.join(folder, renamed.output))
    const heading = splitLeadingHeading(current.text).heading
    if (heading && heading.text !== title.trim()) {
      await setSectionHeading(folder, renamed.stem, { level: heading.level, text: title.trim() }, backups)
    }
  }
  return renamed
}

/**
 * Sets the heading on the first line of a section's output (creating the file
 * if needed), or removes it when `heading` is null. The file is backed up first.
 */
export async function setSectionHeading(folder: string, stem: string, heading: LeadingHeading | null, backups: BackupStore): Promise<SectionInfo> {
  const section = findSection(await readFolder(folder), stem)
  if (heading && !heading.text.trim()) throw new Error('A heading needs some text.')
  const target = path.join(folder, section.output ?? section.outputName)
  const current = await readTextDocument(target, true)
  const text = withLeadingHeading(current.text, heading && { level: Math.min(6, Math.max(1, heading.level)), text: heading.text.trim() })
  if (text === current.text || (current.mtimeMs === null && !heading)) return section
  const result = await writeTextDocument(target, { path: target, text, format: current.format, expectedMtimeMs: current.mtimeMs }, backups)
  if (!result.ok) throw new Error(`${path.basename(target)} changed on disk; try again.`)
  return findSection(await readFolder(folder), stem)
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

/**
 * Merges `laterStem` into `stem`: each of the later section's notes and output is
 * appended (after a blank line) to the same file of the earlier section, which
 * keeps its title and encoding. The later section's files go to the Recycle Bin
 * only after every write succeeded.
 */
export async function mergeSections(
  folder: string,
  stem: string,
  laterStem: string,
  backups: BackupStore,
  trash: (file: string) => Promise<void>,
): Promise<SectionInfo> {
  const model = await readFolder(folder)
  const target = findSection(model, stem)
  const later = findSection(model, laterStem)
  if (target.stem.toLowerCase() === later.stem.toLowerCase()) throw new Error('Choose two different sections to merge.')

  for (const role of ['notes', 'output'] as const) {
    const laterName = later[role]
    if (!laterName) continue
    const addition = await readTextDocument(path.join(folder, laterName))
    if (!addition.text.trim()) continue
    const targetPath = path.join(folder, target[role] ?? (role === 'notes' ? target.notesName : target.outputName))
    const current = await readTextDocument(targetPath, true)
    const merged = current.text.trim()
      ? `${current.text.replace(/\s+$/, '')}\n\n${addition.text.replace(/^\s+/, '')}`
      : addition.text
    const result = await writeTextDocument(targetPath, {
      path: targetPath,
      text: merged,
      format: current.mtimeMs === null ? addition.format : current.format,
      expectedMtimeMs: current.mtimeMs,
    }, backups)
    if (!result.ok) throw new Error(`${path.basename(targetPath)} changed while merging, so nothing was removed.`)
  }
  for (const name of [later.notes, later.output]) {
    if (name) await trash(path.join(folder, name))
  }
  return findSection(await readFolder(folder), target.stem)
}
