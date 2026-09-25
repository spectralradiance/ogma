import type { FolderModel, SectionInfo, SubdocumentInfo } from '../shared/ipc'

/**
 * The section model, derived purely from file names so existing folders work
 * without renaming anything (PLAN.md §3):
 *
 * - `1 the first era`, `02 intro-notes.md`  → the notes file of a section
 * - `02 intro-output.md`                    → the output file of that section
 * - a leading number (`1`, `1.2`, `02`) orders sections
 * - unnumbered files without a -notes/-output suffix (`outline`, `random`)
 *   are notes for the whole document
 */

export interface FolderEntryName {
  name: string
  kind: 'file' | 'dir'
}

export function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, extension: '' }
  const extension = name.slice(dot)
  const looksLikeExtension = /^\.[A-Za-z0-9]{1,8}$/.test(extension) && !/^\.\d+$/.test(extension)
  return looksLikeExtension ? { base: name.slice(0, dot), extension } : { base: name, extension: '' }
}

export function parseFileName(name: string): { stem: string; role: 'notes' | 'output' | 'plain' } {
  const { base } = splitExtension(name)
  const suffixed = /^(.+)-(notes|output)$/i.exec(base)
  if (suffixed) return { stem: suffixed[1], role: suffixed[2].toLowerCase() as 'notes' | 'output' }
  return { stem: base, role: 'plain' }
}

export function parseOrdinal(stem: string): { ordinal: string | null; separator: string; title: string } {
  const match = /^(\d+(?:\.\d+)*)(?:([\s._-]+)(.*))?$/.exec(stem)
  if (!match) return { ordinal: null, separator: '', title: stem }
  return { ordinal: match[1], separator: match[2] ?? '', title: match[3] ?? '' }
}

function orderOf(ordinal: string | null): number[] | null {
  return ordinal === null ? null : ordinal.split('.').map(Number)
}

export function compareOrder(left: number[] | null, right: number[] | null): number {
  if (left && !right) return -1
  if (!left && right) return 1
  if (!left || !right) return 0
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1)
    if (difference !== 0) return difference
  }
  return 0
}

const naturally = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

interface Group {
  stem: string
  notes: string[]
  output: string[]
  plain: string[]
}

export function buildFolderModel(entries: FolderEntryName[]): FolderModel {
  const groups = new Map<string, Group>()
  const documentNotes: string[] = []
  const subdocuments: SubdocumentInfo[] = []

  for (const entry of [...entries].sort((a, b) => naturally(a.name, b.name))) {
    if (entry.kind === 'dir') {
      const { ordinal, title } = parseOrdinal(entry.name)
      subdocuments.push({ name: entry.name, ordinal, title: title || entry.name })
      continue
    }
    const { stem, role } = parseFileName(entry.name)
    const key = stem.toLowerCase()
    const group = groups.get(key) ?? { stem, notes: [], output: [], plain: [] }
    groups.set(key, group)
    group[role === 'plain' ? 'plain' : role].push(entry.name)
  }

  const sections: SectionInfo[] = []
  for (const group of groups.values()) {
    const { ordinal, separator, title } = parseOrdinal(group.stem)
    const isSection = ordinal !== null || group.notes.length > 0 || group.output.length > 0
    if (!isSection) {
      documentNotes.push(...group.plain)
      continue
    }
    // Prefer an explicit -notes file, then Markdown, then any other plain file.
    const plain = [...group.plain].sort((a, b) => Number(!a.endsWith('.md')) - Number(!b.endsWith('.md')))
    const notes = group.notes[0] ?? plain.shift() ?? null
    const output = group.output[0] ?? null
    documentNotes.push(...group.notes.slice(1), ...group.output.slice(1), ...plain.filter((name) => name !== notes))
    sections.push({
      stem: group.stem,
      ordinal,
      separator,
      title: title || group.stem,
      notes,
      output,
      notesName: notes ?? `${group.stem}-notes.md`,
      outputName: output ?? `${group.stem}-output.md`,
    })
  }

  sections.sort((a, b) => compareOrder(orderOf(a.ordinal), orderOf(b.ordinal)) || naturally(a.title, b.title))
  subdocuments.sort((a, b) => compareOrder(orderOf(a.ordinal), orderOf(b.ordinal)) || naturally(a.name, b.name))
  documentNotes.sort(naturally)
  return { sections, subdocuments, documentNotes }
}

// ---------------------------------------------------------------------------
// Rename planning. Every plan is a list of file renames inside one folder,
// validated against the folder's current names before anything is touched.

export interface RenameStep {
  from: string
  to: string
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** Returns an error message, or null when `title` is usable in a file name. */
export function validateTitle(title: string): string | null {
  if (!title.trim()) return 'The name cannot be empty.'
  if (/[<>:"/\\|?*]/.test(title) || [...title].some((char) => char.charCodeAt(0) < 32)) {
    return 'The name cannot contain < > : " / \\ | ? * or control characters.'
  }
  if (/[. ]$/.test(title)) return 'The name cannot end with a dot or a space.'
  if (WINDOWS_RESERVED.test(title.trim())) return `“${title.trim()}” is reserved by Windows.`
  return null
}

function sectionFiles(section: SectionInfo): string[] {
  return [section.notes, section.output].filter((name): name is string => name !== null)
}

function withStem(fileName: string, oldStem: string, newStem: string): string {
  return newStem + fileName.slice(oldStem.length)
}

function assertNoCollisions(steps: RenameStep[], existing: string[]): void {
  const leaving = new Set(steps.map((step) => step.from.toLowerCase()))
  const taken = new Set(existing.map((name) => name.toLowerCase()).filter((name) => !leaving.has(name)))
  const targets = new Set<string>()
  for (const step of steps) {
    const target = step.to.toLowerCase()
    if (taken.has(target) || targets.has(target)) throw new Error(`“${step.to}” already exists in this folder.`)
    targets.add(target)
  }
}

export function planRename(section: SectionInfo, newTitle: string, existing: string[]): RenameStep[] {
  const error = validateTitle(newTitle)
  if (error) throw new Error(error)
  const title = newTitle.trim()
  const newStem = section.ordinal === null ? title : `${section.ordinal}${section.separator || ' '}${title}`
  const steps = sectionFiles(section)
    .map((name) => ({ from: name, to: withStem(name, section.stem, newStem) }))
    .filter((step) => step.from !== step.to)
  assertNoCollisions(steps, existing)
  return steps
}

/** Exchanges the ordinals of two numbered sections, which moves each into the other's place. */
export function planSwap(first: SectionInfo, second: SectionInfo, existing: string[]): RenameStep[] {
  if (first.ordinal === null || second.ordinal === null) throw new Error('Only numbered sections can be reordered.')
  const stemFor = (section: SectionInfo, ordinal: string) => `${ordinal}${section.separator || ' '}${section.title}`
  const firstStem = stemFor(first, second.ordinal)
  const secondStem = stemFor(second, first.ordinal)
  const steps = [
    ...sectionFiles(first).map((name) => ({ from: name, to: withStem(name, first.stem, firstStem) })),
    ...sectionFiles(second).map((name) => ({ from: name, to: withStem(name, second.stem, secondStem) })),
  ].filter((step) => step.from !== step.to)
  assertNoCollisions(steps, existing)
  return steps
}

/** File name for a new section appended after the existing ones, matching sibling naming. */
export function planNewSection(model: FolderModel, title: string, existing: string[]): string {
  const error = validateTitle(title)
  if (error) throw new Error(error)
  const numbered = model.sections.filter((section) => section.ordinal !== null && !section.ordinal.includes('.'))
  const highest = Math.max(0, ...numbered.map((section) => Number(section.ordinal)))
  const next = numbered.length === 0 ? 1 : highest + 1
  const padded = numbered.find((section) => section.ordinal!.length > 1 && section.ordinal!.startsWith('0'))
  const ordinal = padded ? String(next).padStart(padded.ordinal!.length, '0') : String(next)

  const separators = numbered.map((section) => section.separator).filter(Boolean)
  const separator = separators.sort((a, b) =>
    separators.filter((s) => s === b).length - separators.filter((s) => s === a).length)[0] ?? ' '
  const usesSuffix = model.sections.some((section) => section.notes !== null && /-notes(\.[^.]+)?$/i.test(section.notes))
  const name = `${ordinal}${separator}${title.trim()}${usesSuffix ? '-notes' : ''}.md`
  if (existing.some((existingName) => existingName.toLowerCase() === name.toLowerCase())) {
    throw new Error(`“${name}” already exists in this folder.`)
  }
  return name
}
