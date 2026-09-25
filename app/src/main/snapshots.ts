import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { SnapshotEntry } from '../shared/ipc'
import { countWords } from '../shared/text'

const AUTOMATIC_INTERVAL_MS = 10 * 60 * 1000
const MAX_AUTOMATIC = 100

interface SnapshotIndex {
  path: string
  entries: SnapshotEntry[]
}

/**
 * Version history per file, kept in <userData>/snapshots/<hash of path>/:
 * one text file per version plus index.json. Saving takes an automatic
 * snapshot at most every ten minutes; manual snapshots carry a label and are
 * never pruned. Snapshots hold the editor text (LF line breaks); restoring
 * goes back through the editor so the file keeps its own encoding.
 */
export class SnapshotStore {
  private readonly directory: string
  private readonly now: () => number

  constructor(directory: string, now: () => number = Date.now) {
    this.directory = directory
    this.now = now
  }

  async list(file: string): Promise<SnapshotEntry[]> {
    return [...(await this.index(file)).entries].reverse()
  }

  async read(file: string, id: string): Promise<string> {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid snapshot id.')
    return readFile(path.join(this.folder(file), `${id}.md`), 'utf8')
  }

  /** Called after every successful save; records a version when the last automatic one is old enough. */
  async afterSave(file: string, text: string): Promise<SnapshotEntry | null> {
    const index = await this.index(file)
    const lastAutomatic = [...index.entries].reverse().find((entry) => entry.label === null)
    if (lastAutomatic && this.now() - Date.parse(lastAutomatic.at) < AUTOMATIC_INTERVAL_MS) return null
    if (index.entries.at(-1) && (await this.read(file, index.entries.at(-1)!.id).catch(() => null)) === text) return null
    return this.capture(file, text, null, index)
  }

  async manual(file: string, text: string, label: string): Promise<SnapshotEntry> {
    return this.capture(file, text, label.trim() || 'Snapshot', await this.index(file))
  }

  private async capture(file: string, text: string, label: string | null, index: SnapshotIndex): Promise<SnapshotEntry> {
    const at = new Date(this.now())
    let id = at.toISOString().replace(/[:.]/g, '-')
    while (index.entries.some((entry) => entry.id === id)) id += '-1'
    const entry: SnapshotEntry = { id, at: at.toISOString(), words: countWords(text), chars: text.length, label }
    await mkdir(this.folder(file), { recursive: true })
    await writeFile(path.join(this.folder(file), `${id}.md`), text, 'utf8')
    index.entries.push(entry)

    const automatic = index.entries.filter((item) => item.label === null)
    for (const old of automatic.slice(0, Math.max(0, automatic.length - MAX_AUTOMATIC))) {
      await rm(path.join(this.folder(file), `${old.id}.md`), { force: true })
      index.entries = index.entries.filter((item) => item.id !== old.id)
    }
    await this.saveIndex(file, index)
    return entry
  }

  private folder(file: string): string {
    const key = createHash('sha1').update(process.platform === 'win32' ? file.toLowerCase() : file).digest('hex').slice(0, 20)
    return path.join(this.directory, key)
  }

  private async index(file: string): Promise<SnapshotIndex> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.folder(file), 'index.json'), 'utf8')) as SnapshotIndex
      return { path: file, entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
    } catch {
      return { path: file, entries: [] }
    }
  }

  private async saveIndex(file: string, index: SnapshotIndex): Promise<void> {
    const target = path.join(this.folder(file), 'index.json')
    await writeFile(`${target}.tmp`, JSON.stringify(index, null, 2), 'utf8')
    await rename(`${target}.tmp`, target)
  }
}
