import { dirname, samePath } from '../../shared/paths'

type Listener = (paths: string[]) => void

const listeners = new Set<Listener>()
let unsubscribe: (() => void) | null = null

/**
 * One IPC subscription for disk changes, fanned out to however many folder
 * nodes and editor panes are listening.
 */
export function onDiskChange(listener: Listener): () => void {
  listeners.add(listener)
  unsubscribe ??= window.oisin.files.onChanged((paths) => {
    for (const current of [...listeners]) current(paths)
  })
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

/** Whether a batch of changed paths affects the listing of `folder`. */
export function touchesFolder(paths: string[], folder: string): boolean {
  return paths.some((path) => samePath(path, folder) || samePath(dirname(path), folder))
}

export function touchesFile(paths: string[], file: string): boolean {
  return paths.some((path) => samePath(path, file) || samePath(path, dirname(file)))
}
