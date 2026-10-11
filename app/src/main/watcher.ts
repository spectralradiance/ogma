import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'

const DEBOUNCE_MS = 250

/** Ogma's own temporary files, plus folders that are never part of a document. */
export function isIgnoredChange(changed: string): boolean {
  const parts = changed.split(/[\\/]/)
  const name = parts.at(-1) ?? ''
  if (name.startsWith('.') && name.includes('.ogma-')) return true
  return parts.some((part) => part === '.git' || part === 'node_modules' || part === '__pycache__')
}

/**
 * Watches every workspace root recursively and reports changed paths in
 * debounced batches. Roots that cannot be watched (unsupported file systems,
 * missing folders) are skipped; the app still works, it just will not notice
 * outside edits until a folder is reopened.
 */
export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private readonly onChange: (paths: string[]) => void

  constructor(onChange: (paths: string[]) => void) {
    this.onChange = onChange
  }

  setRoots(roots: string[]): void {
    for (const [root, watcher] of this.watchers) {
      if (!roots.includes(root)) {
        watcher.close()
        this.watchers.delete(root)
      }
    }
    for (const root of roots) {
      if (this.watchers.has(root)) continue
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          const changed = filename ? path.join(root, filename.toString()) : root
          if (!isIgnoredChange(changed)) this.queue(changed)
        })
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(root)
        })
        this.watchers.set(root, watcher)
      } catch {
        // unwatchable root: see class comment
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.timer) clearTimeout(this.timer)
  }

  private queue(changed: string): void {
    this.pending.add(changed)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const paths = [...this.pending]
      this.pending.clear()
      this.onChange(paths)
    }, DEBOUNCE_MS)
  }
}
