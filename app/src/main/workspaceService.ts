import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { FolderListing } from '../shared/ipc'
import { listDirectory } from './fileService'

/** A folder's subfolders and text files, for the sidebar. */
export async function readFolder(folder: string): Promise<FolderListing> {
  const entries = await listDirectory(folder)
  return {
    folders: entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.name),
    files: entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name),
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

/** Returns an error message, or null when `name` is usable as a file or folder name. */
export function validateName(name: string): string | null {
  if (!name.trim()) return 'The name cannot be empty.'
  if (/[<>:"/\\|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) {
    return 'The name cannot contain < > : " / \\ | ? * or control characters.'
  }
  if (/[. ]$/.test(name)) return 'The name cannot end with a dot or a space.'
  if (WINDOWS_RESERVED.test(name.trim())) return `“${name.trim()}” is reserved by Windows.`
  return null
}

const exists = (target: string) => access(target).then(() => true, () => false)

/** Renames a file or folder in place and returns its new path. */
async function renameEntry(source: string, name: string): Promise<string> {
  const error = validateName(name)
  if (error) throw new Error(error)
  const target = path.join(path.dirname(source), name.trim())
  if (path.basename(source) === name.trim()) return source
  // A case-only change is the same entry on Windows, so only other matches are collisions.
  if (target.toLowerCase() !== source.toLowerCase() && await exists(target)) {
    throw new Error(`“${name.trim()}” already exists here.`)
  }
  await rename(source, target)
  return target
}

export async function createFolder(parent: string, name: string): Promise<string> {
  const error = validateName(name)
  if (error) throw new Error(error)
  const target = path.join(parent, name.trim())
  await mkdir(target)
  return target
}

export function renameFolder(folder: string, name: string): Promise<string> {
  return renameEntry(folder, name)
}

/** Renames a file; a name without an extension keeps the file's current one. */
export function renameFile(file: string, name: string): Promise<string> {
  const extension = path.extname(file)
  const withExtension = path.extname(name.trim()) || !extension ? name.trim() : `${name.trim()}${extension}`
  return renameEntry(file, withExtension)
}

export interface TrashedFile {
  path: string
  bytes: Buffer
}

/** Moves a file to the trash and returns its contents, so the deletion can be undone. */
export async function trashFile(file: string, trash: (file: string) => Promise<void>): Promise<TrashedFile> {
  const bytes = await readFile(file)
  await trash(file)
  return { path: file, bytes }
}

/** Puts back a file removed by `trashFile`, refusing to overwrite one created since. */
export async function restoreFile(file: TrashedFile): Promise<void> {
  await writeFile(file.path, file.bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EEXIST' ? new Error(`“${path.basename(file.path)}” exists again, so nothing was restored.`) : error
  })
}
