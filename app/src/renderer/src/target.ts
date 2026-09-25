import { samePath } from '../../shared/paths'

/**
 * What the main area shows: a double document (a folder of sections, each with
 * notes and output files) scrolled to a section, or a regular single file.
 */
export type OpenTarget =
  | {
    kind: 'document'
    folder: string
    title: string
    ordinal: string | null
    /** Section to scroll to; `nonce` changes to scroll again to the same one. */
    focusStem: string | null
    nonce: number
  }
  | { kind: 'file'; path: string }

/** The four ways to show a double document. */
export type ViewMode = 'column' | 'split' | 'output' | 'notes'

export const VIEW_MODES: { id: ViewMode; label: string; title: string }[] = [
  { id: 'column', label: 'Column', title: 'One column: each section’s output, then its notes' },
  { id: 'split', label: 'Side by side', title: 'Notes and output side by side, section by section' },
  { id: 'output', label: 'Output', title: 'Only the output (foreground)' },
  { id: 'notes', label: 'Notes', title: 'Only the notes (background)' },
]

export function parseViewMode(raw: string | null): ViewMode {
  return VIEW_MODES.some((mode) => mode.id === raw) ? (raw as ViewMode) : 'split'
}

/** The pane the user last typed in, and which section it belongs to (if any). */
export interface ActivePane {
  path: string
  folder: string | null
  stem: string | null
}

export function isOpenDocument(target: OpenTarget | null, folder: string): boolean {
  return target?.kind === 'document' && samePath(target.folder, folder)
}

export function sameTarget(left: OpenTarget | null, right: OpenTarget | null): boolean {
  if (!left || !right) return left === right
  if (left.kind === 'file' && right.kind === 'file') return samePath(left.path, right.path)
  if (left.kind === 'document' && right.kind === 'document') return samePath(left.folder, right.folder)
  return false
}

export function parseTarget(raw: string | null): OpenTarget | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as OpenTarget
    if (value.kind === 'file' && typeof value.path === 'string') return value
    if (value.kind === 'document' && typeof value.folder === 'string') return { ...value, nonce: 0 }
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
