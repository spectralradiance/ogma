import { LOCAL_FILE_SCHEME } from './ipc'

// Path helpers usable in the renderer, which has no access to node:path.

export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path.slice(0, index + 1) : path.slice(0, index)
}

export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** Resolve `relative` (as written in Markdown) against a directory, normalizing . and .. segments. */
export function resolvePath(directory: string, relative: string): string {
  const joined = isAbsolutePath(relative) ? relative : `${directory}/${relative}`
  const separator = joined.includes('\\') || /^[a-zA-Z]:/.test(joined) ? '\\' : '/'
  const segments = joined.split(/[\\/]+/)
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '.' || (segment === '' && resolved.length > 0)) continue
    if (segment === '..') {
      if (resolved.length > 1) resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join(separator) || separator
}

/** URL for an image inside the workspace; the main process checks it is under a workspace root. */
export function localFileUrl(path: string): string {
  return `${LOCAL_FILE_SCHEME}://file/${encodeURIComponent(path)}`
}

export function pathFromLocalFileUrl(url: string): string | null {
  const prefix = `${LOCAL_FILE_SCHEME}://file/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
}

export function joinPath(directory: string, name: string): string {
  const separator = directory.includes('\\') || /^[a-zA-Z]:/.test(directory) ? '\\' : '/'
  return directory.endsWith(separator) ? directory + name : directory + separator + name
}

/** Path equality as the OS sees it: case-insensitive for Windows paths, ignoring trailing separators. */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const trimmed = value.replace(/[\\/]+$/, '')
    const windows = /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')
    return windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
  }
  return normalize(left) === normalize(right)
}
