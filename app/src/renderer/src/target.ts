import type { SectionInfo } from '../../shared/ipc'
import { joinPath, samePath } from '../../shared/paths'

/** What the main area shows: a section (notes + output side by side) or a single file. */
export type OpenTarget =
  | {
    kind: 'section'
    folder: string
    stem: string
    title: string
    ordinal: string | null
    notesPath: string
    outputPath: string
  }
  | { kind: 'file'; path: string }

export type PaneId = 'notes' | 'output' | 'file'

export function sectionTarget(folder: string, section: SectionInfo): OpenTarget {
  return {
    kind: 'section',
    folder,
    stem: section.stem,
    title: section.title,
    ordinal: section.ordinal,
    notesPath: joinPath(folder, section.notesName),
    outputPath: joinPath(folder, section.outputName),
  }
}

export function isOpenSection(target: OpenTarget | null, folder: string, stem: string): boolean {
  return target?.kind === 'section' && samePath(target.folder, folder) && target.stem.toLowerCase() === stem.toLowerCase()
}

export function sameTarget(left: OpenTarget | null, right: OpenTarget | null): boolean {
  if (!left || !right) return left === right
  if (left.kind === 'file' && right.kind === 'file') return samePath(left.path, right.path)
  if (left.kind === 'section' && right.kind === 'section') {
    return samePath(left.notesPath, right.notesPath) && samePath(left.outputPath, right.outputPath)
  }
  return false
}

export function parseTarget(raw: string | null): OpenTarget | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as OpenTarget
    if (value.kind === 'file' && typeof value.path === 'string') return value
    if (value.kind === 'section' && typeof value.notesPath === 'string' && typeof value.outputPath === 'string') return value
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
