import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { DirEntry, TextDocument, WriteRequest, WriteResult } from '../shared/ipc'
import { decodeText, encodeText } from './textFile'

type PathApi = typeof path.win32

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__pycache__'])
const MAX_TEXT_BYTES = 20 * 1024 * 1024
const RENAME_ATTEMPTS = 5

export class OutsideWorkspaceError extends Error {
  constructor(target: string) {
    super(`${target} is not inside a workspace folder.`)
  }
}

/**
 * Notes are often extensionless ("1 the first era") or have dots in their names
 * ("1.2 the solar system"), so only a short alphanumeric, non-numeric suffix
 * counts as a real extension.
 */
export function isTextFileName(name: string): boolean {
  if (name.startsWith('.')) return false
  const extension = path.extname(name)
  const looksLikeExtension = /^\.[A-Za-z0-9]{1,8}$/.test(extension) && !/^\.\d+$/.test(extension)
  return !looksLikeExtension || TEXT_EXTENSIONS.has(extension.toLowerCase())
}

export function isInside(root: string, target: string, pathApi: PathApi = path): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

/** Rejects any path outside the current workspace roots. */
export class PathGuard {
  private readonly getRoots: () => string[]
  private readonly pathApi: PathApi

  constructor(getRoots: () => string[], pathApi: PathApi = path) {
    this.getRoots = getRoots
    this.pathApi = pathApi
  }

  resolve(target: unknown): string {
    if (typeof target !== 'string' || !this.pathApi.isAbsolute(target)) {
      throw new TypeError('Expected an absolute path.')
    }
    const resolved = this.pathApi.resolve(target)
    if (!this.getRoots().some((root) => isInside(root, resolved, this.pathApi))) {
      throw new OutsideWorkspaceError(resolved)
    }
    return resolved
  }

  rootOf(target: string): string | undefined {
    return this.getRoots().find((root) => isInside(root, target, this.pathApi))
  }
}

/** Copies each file's original bytes once per app session before Oisín first overwrites it. */
export class BackupStore {
  private readonly sessionDir: string
  private readonly backedUp = new Set<string>()
  private readonly guard: PathGuard

  constructor(backupsDir: string, guard: PathGuard, now = new Date()) {
    this.sessionDir = path.join(backupsDir, now.toISOString().replace(/[:.]/g, '-'))
    this.guard = guard
  }

  async ensureBackup(target: string): Promise<void> {
    const key = process.platform === 'win32' ? target.toLowerCase() : target
    if (this.backedUp.has(key)) return
    const root = this.guard.rootOf(target)
    const label = root ? path.join(path.basename(root), path.relative(root, target)) : path.basename(target)
    const destination = path.join(this.sessionDir, label)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(target, destination)
    this.backedUp.add(key)
  }

  /** Removes session folders older than `days`. Only touches Oisín's own backup copies. */
  static async prune(backupsDir: string, days: number, now = Date.now()): Promise<void> {
    let entries
    try {
      entries = await readdir(backupsDir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const folder = path.join(backupsDir, entry.name)
      const info = await stat(folder)
      if (now - info.mtimeMs > days * 86_400_000) await rm(folder, { recursive: true, force: true })
    }))
  }
}

export async function listDirectory(directory: string): Promise<DirEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: DirEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      result.push({ name: entry.name, path: path.join(directory, entry.name), kind: 'dir' })
    } else if (entry.isFile() && isTextFileName(entry.name)) {
      result.push({ name: entry.name, path: path.join(directory, entry.name), kind: 'file' })
    }
  }
  return result.sort((left, right) =>
    left.kind === right.kind ? compareNames(left.name, right.name) : left.kind === 'dir' ? -1 : 1)
}

export async function readTextDocument(target: string): Promise<TextDocument> {
  const info = await stat(target)
  if (info.size > MAX_TEXT_BYTES) throw new Error('This file is too large to open as text.')
  const { text, format } = decodeText(await readFile(target))
  return { path: target, text, format, mtimeMs: info.mtimeMs, size: info.size }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      // Windows briefly locks files that sync clients or antivirus are scanning.
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

/** Atomic write: temp file in the same folder, then rename over the original. */
export async function writeTextDocument(
  target: string,
  request: WriteRequest,
  backups: BackupStore,
): Promise<WriteResult> {
  const current = await stat(target).catch(() => null)
  if (!request.force && (!current || current.mtimeMs !== request.expectedMtimeMs)) {
    return { ok: false, reason: 'conflict', diskMtimeMs: current?.mtimeMs ?? 0 }
  }
  if (current) await backups.ensureBackup(target)

  const encoded = encodeText(request.text, request.format)
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.oisin-${randomBytes(4).toString('hex')}.tmp`,
  )
  await writeFile(temporary, encoded.bytes, { flag: 'wx' })
  try {
    await renameWithRetry(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  const saved = await stat(target)
  return { ok: true, mtimeMs: saved.mtimeMs, size: saved.size, format: encoded.format, notice: encoded.notice }
}
