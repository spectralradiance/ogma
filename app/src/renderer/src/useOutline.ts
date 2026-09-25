import { useEffect, useMemo, useState } from 'react'

import { EMPTY_FILE, type FileOutline, outlineFile, type OutlineSection } from '../../shared/outline'
import { joinPath, samePath } from '../../shared/paths'
import type { Heading } from '../../shared/text'
import { onDiskChange, touchesFile, touchesFolder } from './changes'
import type { OpenTarget } from './target'

export type Outline =
  | { kind: 'document'; title: string; folder: string; sections: OutlineSection[] }
  | { kind: 'file'; title: string; path: string; file: FileOutline }

async function readOutline(path: string): Promise<FileOutline> {
  const document = await window.oisin.files.read(path, { allowMissing: true }).catch(() => null)
  return document && document.mtimeMs !== null ? outlineFile(document.text) : EMPTY_FILE
}

async function loadOutline(target: OpenTarget): Promise<Outline | null> {
  if (target.kind === 'file') {
    const name = target.path.split(/[\\/]/).at(-1) ?? target.path
    return { kind: 'file', title: name, path: target.path, file: await readOutline(target.path) }
  }
  const model = await window.oisin.folders.read(target.folder).catch(() => null)
  if (!model) return null
  const sections = await Promise.all(model.sections.map(async (section) => {
    const notesPath = joinPath(target.folder, section.notesName)
    const outputPath = joinPath(target.folder, section.outputName)
    const [notes, output] = await Promise.all([
      section.notes ? readOutline(notesPath) : EMPTY_FILE,
      section.output ? readOutline(outputPath) : EMPTY_FILE,
    ])
    return { stem: section.stem, ordinal: section.ordinal, title: section.title, notesPath, outputPath, notes, output }
  }))
  return { kind: 'document', title: target.title, folder: target.folder, sections }
}

const targetKey = (target: OpenTarget | null) => (target ? (target.kind === 'file' ? target.path : target.folder) : '')

/**
 * The open document's outline, read from disk and kept current: open editors
 * report their headings and word counts as you type, and changes on disk
 * (renames, merges, edits elsewhere) reload it.
 */
export function useOutline(
  target: OpenTarget | null,
  live: { headings: Record<string, Heading[]>; words: Record<string, number | undefined> },
  reloadToken: number,
): Outline | null {
  const key = targetKey(target)
  const [loaded, setLoaded] = useState<{ key: string; outline: Outline | null }>({ key: '', outline: null })
  const [diskToken, setDiskToken] = useState(0)

  useEffect(() => {
    if (!target) return
    let alive = true
    void loadOutline(target).then((outline) => {
      if (alive) setLoaded({ key: targetKey(target), outline })
    })
    return () => {
      alive = false
    }
    // Reload when a different document opens, not when the same one scrolls to another section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadToken, diskToken])

  useEffect(() => {
    if (!target) return
    return onDiskChange((paths) => {
      const affected = target.kind === 'file' ? touchesFile(paths, target.path) : touchesFolder(paths, target.folder)
      if (affected) setDiskToken((token) => token + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const { headings, words } = live
  return useMemo(() => {
    const outline = loaded.key === key ? loaded.outline : null
    if (!outline) return null
    const current = (path: string, file: FileOutline): FileOutline => {
      const liveKey = Object.keys(headings).find((candidate) => samePath(candidate, path))
      if (!liveKey) return file
      const count = words[liveKey] ?? file.words
      // An open editor for a file that is not created yet reports no text; it only exists once typed in.
      return { ...file, exists: file.exists || count > 0, headings: headings[liveKey], words: count }
    }
    if (outline.kind === 'file') return { ...outline, file: current(outline.path, outline.file) }
    return {
      ...outline,
      sections: outline.sections.map((section) => ({
        ...section,
        notes: current(section.notesPath, section.notes),
        output: current(section.outputPath, section.output),
      })),
    }
  }, [loaded, key, headings, words])
}
