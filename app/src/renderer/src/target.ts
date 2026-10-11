import { samePath } from '../../shared/paths'

/** The document open in the main area. */
export interface OpenTarget {
  path: string
}

/** The editor the user last typed in. */
export interface ActivePane {
  path: string
}

export function sameTarget(left: OpenTarget | null, right: OpenTarget | null): boolean {
  if (!left || !right) return left === right
  return samePath(left.path, right.path)
}

export function parseTarget(raw: string | null): OpenTarget | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<OpenTarget>
    if (typeof value.path === 'string') return { path: value.path }
  } catch {
    // Old or corrupt preference: start with nothing open.
  }
  return null
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Strip Electron's "Error invoking remote method 'x:y': Error: " prefix.
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
