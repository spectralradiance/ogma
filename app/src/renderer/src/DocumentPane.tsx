import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { TextDocument, TextFormat } from '../../shared/ipc'
import { dirname } from '../../shared/paths'
import { replaceSectionOutput, type SectionSummary, sectionAtLine, splitSections, splitWordCounts, summarizeSections } from '../../shared/document'
import { extractHeadings, type Heading, type LeadingHeading, splitLeadingHeading } from '../../shared/text'
import { onDiskChange, touchesFile } from './changes'
import { MarkdownEditor, type MarkdownEditorHandle, type WordInContext } from './editor/MarkdownEditor'
import type { NotesView } from './editor/notesBlocks'
import { HistoryDialog } from './HistoryDialog'
import { errorMessage } from './target'
import { History, X } from 'lucide-react'

const AUTOSAVE_DELAY_MS = 1200
const STATS_DELAY_MS = 400

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

export const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Edited',
  saving: 'Saving…',
  conflict: 'Changed on disk',
  error: 'Save failed',
}

export interface DocumentInfo {
  /** Words outside notes blocks: the text itself. */
  words: number
  /** Words inside notes blocks. */
  notesWords: number
  format: TextFormat
}

/** The section at the cursor of a single-file document. */
export interface CurrentSection {
  index: number
  title: string | null
  output: string
  notes: string
}

export interface DocumentPaneHandle {
  /** Saves pending edits. Resolves false if they could not be saved. */
  flush(): Promise<boolean>
  revealLine(line: number): void
  currentWord(): WordInContext | null
  replaceWord(replacement: string): boolean
  getText(): string
  getSelection(): string
  replaceAll(text: string): void
  /** The section the cursor is in (a heading and the text under it). */
  currentSection(): CurrentSection | null
  /**
   * Shows `text` as suggested changes to the whole file (or to section `index`'s output),
   * after saving the current text as a "Before AI" version in History. Returns how many
   * changes were suggested, or null if that section no longer exists.
   */
  propose(text: string, label: string, index?: number | null): number | null
  openHistory(): void
}

interface DocumentPaneProps {
  ref?: Ref<DocumentPaneHandle>
  path: string
  /** Shown in the header, e.g. "Notes" or "Output". */
  label?: string
  /** Open an empty editor when the file does not exist; the first save creates it. */
  allowMissing?: boolean
  placeholder?: string
  /** A block inside the document view: small header, editor grows with its content. */
  compact?: boolean
  className?: string
  live: boolean
  focusMode: boolean
  /** Single-file documents: show the text alone, the notes alone, or both. */
  notesView?: NotesView
  onShowNotes?: () => void
  headerActions?: ReactNode
  onInfo: (info: DocumentInfo | null) => void
  onHeadings?: (headings: Heading[]) => void
  /** The document's sections (split at its headings) with their sizes, as you type. */
  onSections?: (sections: SectionSummary[]) => void
  onDirtyChange: (dirty: boolean) => void
  onFocus?: () => void
  onSelectWord?: (word: WordInContext) => void
  /** Reports the save state (and whether the file exists yet), for headers drawn by the parent. */
  onSaveState?: (state: SaveState, exists: boolean) => void
  /**
   * Keep a heading on the file's first line out of the editor (it is the section's
   * heading, shown by the parent) and report it. It is written back unchanged on save.
   */
  onLeadingHeading?: (heading: LeadingHeading | null) => void
  onClose?: () => void
}

interface DiskState {
  mtimeMs: number | null
  format: TextFormat
}

export function DocumentPane({
  ref, path, label, allowMissing = false, placeholder, compact = false, className, live, focusMode, notesView, onShowNotes, headerActions,
  onInfo, onHeadings, onSections, onDirtyChange, onFocus, onSelectWord, onSaveState, onLeadingHeading, onClose,
}: DocumentPaneProps) {
  const [loaded, setLoaded] = useState<{ document: TextDocument; generation: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exists, setExists] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)

  const editor = useRef<MarkdownEditorHandle>(null)
  const disk = useRef<DiskState | null>(null)
  // The section heading held back from the editor: text written before the editor's text on save.
  const head = useRef('')
  const splitsHeading = onLeadingHeading !== undefined
  const headLines = () => head.current.split('\n').length - 1
  const state = useRef<SaveState>('saved')
  const version = useRef(0)
  const savedVersion = useRef(0)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const autosaveTimer = useRef<number | undefined>(undefined)
  const statsTimer = useRef<number | undefined>(undefined)
  // Lets save() reschedule itself for edits made while it was writing.
  const saveLater = useRef<() => void>(() => {})

  // The parent's latest callbacks, read through a ref so that their identity
  // changing on every parent render does not re-run the file load.
  const parent = useRef({ onInfo, onHeadings, onSections, onDirtyChange, onSaveState, onLeadingHeading })
  useLayoutEffect(() => {
    parent.current = { onInfo, onHeadings, onSections, onDirtyChange, onSaveState, onLeadingHeading }
  })

  const updateState = useCallback((next: SaveState) => {
    state.current = next
    setSaveState(next)
  }, [])

  /** Stats for the whole file (heading included), so they match what is on disk. */
  const reportStats = useCallback((body: string, format: TextFormat) => {
    const text = head.current + body
    const counts = splitWordCounts(text)
    parent.current.onInfo({ words: counts.output, notesWords: counts.notes, format })
    parent.current.onHeadings?.(extractHeadings(text))
    parent.current.onSections?.(summarizeSections(text))
  }, [])

  const applyDocument = useCallback((loadedDocument: TextDocument) => {
    const split = splitsHeading ? splitLeadingHeading(loadedDocument.text) : { head: '', body: loadedDocument.text, heading: null }
    head.current = split.head
    parent.current.onLeadingHeading?.(split.heading)
    const document = { ...loadedDocument, text: split.body }
    disk.current = { mtimeMs: document.mtimeMs, format: document.format }
    version.current = 0
    savedVersion.current = 0
    setExists(document.mtimeMs !== null)
    setLoadError(null)
    setSaveError(null)
    updateState('saved')
    setLoaded((previous) => ({ document, generation: (previous?.generation ?? 0) + 1 }))
    reportStats(document.text, document.format)
  }, [reportStats, updateState, splitsHeading])

  const load = useCallback(() => window.ogma.files.read(path, { allowMissing }).then(
    applyDocument,
    (error: unknown) => {
      setLoadError(errorMessage(error))
      parent.current.onInfo(null)
    },
  ), [path, allowMissing, applyDocument])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    parent.current.onDirtyChange(saveState !== 'saved')
  }, [saveState])

  useEffect(() => {
    parent.current.onSaveState?.(saveState, exists)
  }, [saveState, exists])

  useEffect(() => () => {
    window.clearTimeout(autosaveTimer.current)
    window.clearTimeout(statsTimer.current)
  }, [])

  // Outside edits: reload silently when there is nothing unsaved, otherwise ask.
  useEffect(() => onDiskChange((paths) => {
    if (!touchesFile(paths, path)) return
    void (async () => {
      if (inFlight.current) await inFlight.current
      const document = await window.ogma.files.read(path, { allowMissing: true }).catch(() => null)
      const known = disk.current
      if (!document || !known || document.mtimeMs === known.mtimeMs) return // our own save, or no change
      if (state.current === 'saved') applyDocument(document)
      else updateState('conflict')
    })()
  }), [path, applyDocument, updateState])

  const save = useCallback(async (force = false): Promise<boolean> => {
    window.clearTimeout(autosaveTimer.current)
    if (inFlight.current) await inFlight.current
    const handle = editor.current
    const meta = disk.current
    if (!handle || !meta) return state.current === 'saved'
    if (!force && version.current === savedVersion.current) return true
    if (!force && state.current === 'conflict') return false

    const target = version.current
    const text = head.current + handle.getText()
    updateState('saving')
    const run = (async () => {
      try {
        const result = await window.ogma.files.write({
          path, text, format: meta.format, expectedMtimeMs: meta.mtimeMs, force,
        })
        if (!result.ok) {
          updateState('conflict')
          return false
        }
        disk.current = { mtimeMs: result.mtimeMs, format: result.format }
        savedVersion.current = target
        setExists(true)
        setSaveError(null)
        if (result.notice) setNotice(result.notice)
        const counts = splitWordCounts(text)
        parent.current.onInfo({ words: counts.output, notesWords: counts.notes, format: result.format })
        if (version.current === target) {
          updateState('saved')
        } else {
          updateState('dirty')
          saveLater.current()
        }
        return true
      } catch (error) {
        setSaveError(errorMessage(error))
        updateState('error')
        return false
      }
    })()
    inFlight.current = run
    try {
      return await run
    } finally {
      inFlight.current = null
    }
  }, [path, updateState])

  useImperativeHandle(ref, () => ({
    flush: () => save(),
    // Lines are the file's; the editor starts after the held-back heading.
    revealLine: (line) => editor.current?.revealLine(Math.max(1, line - headLines())),
    currentWord: () => editor.current?.currentWord() ?? null,
    replaceWord: (replacement) => editor.current?.replaceWord(replacement) ?? false,
    getText: () => editor.current?.getText() ?? '',
    getSelection: () => editor.current?.getSelection() ?? '',
    replaceAll: (text) => editor.current?.replaceAll(text),
    currentSection: () => {
      const handle = editor.current
      if (!handle) return null
      const sections = splitSections(handle.getText())
      const index = sectionAtLine(sections, handle.cursorLine())
      const section = sections[index]
      return section ? { index, title: section.title, output: section.output, notes: section.notes } : null
    },
    propose: (text, label, index = null) => {
      const handle = editor.current
      if (!handle) return null
      const current = handle.getText()
      const next = index === null ? text : replaceSectionOutput(current, index, text)
      if (next === null) return null
      const count = handle.propose(next, label)
      // A restore point from before the AI touched anything, in case the writer accepts and regrets it.
      if (count > 0 && (head.current + current).trim()) {
        void window.ogma.history.snapshot(path, head.current + current, `Before AI: ${label}`).catch(() => {})
      }
      return count
    },
    openHistory: () => setHistoryOpen(true),
  }), [save, path])

  useEffect(() => {
    saveLater.current = () => {
      window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS)
    }
  }, [save])

  const onDocChanged = useCallback(() => {
    version.current += 1
    if (state.current === 'saved' || state.current === 'error') updateState('dirty')
    if (state.current === 'conflict') {
      window.clearTimeout(autosaveTimer.current)
    } else {
      saveLater.current()
    }
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => {
      const format = disk.current?.format
      if (editor.current && format) reportStats(editor.current.getText(), format)
    }, STATS_DELAY_MS)
  }, [reportStats, updateState])

  const reloadFromDisk = () => {
    if (window.confirm('Discard your unsaved changes and load the version on disk?')) void load()
  }

  const fileName = folderName(path)

  if (loadError) {
    return (
      <section className="document">
        <div className="document-message">
          <h2>Couldn’t open {fileName}</h2>
          <p>{loadError}</p>
          {onClose && <button type="button" onClick={onClose}>Close</button>}
        </div>
      </section>
    )
  }

  return (
    <section className={`document${compact ? ' document-compact' : ''}${className ? ` ${className}` : ''}`}>
      {!compact && <header className="document-header">
        <div className="document-title" title={path}>
          {label && <span className="document-label">{label}</span>}
          {!compact && <span className="document-name">{fileName}</span>}
          {!label && <span className="document-folder">{folderName(dirname(path))}</span>}
          {!exists && <span className="document-new" title="Created when you start typing">new</span>}
        </div>
        <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>
          {exists || saveState !== 'saved' ? SAVE_LABEL[saveState] : ''}
        </span>
        {exists && (
          <button type="button" className="icon-button history-button" onClick={() => setHistoryOpen(true)} title="History: earlier versions of this file" aria-label="History"><History size={14} aria-hidden="true" /></button>
        )}
        {headerActions}
      </header>}
      {historyOpen && (
        <HistoryDialog
          path={path}
          current={() => head.current + (editor.current?.getText() ?? '')}
          onRestore={(text) => {
            setHistoryOpen(false)
            const split = splitsHeading ? splitLeadingHeading(text) : { head: '', body: text, heading: null }
            head.current = split.head
            parent.current.onLeadingHeading?.(split.heading)
            editor.current?.replaceAll(split.body)
            setNotice('Restored an earlier version. It saves automatically; Ctrl+Z undoes it.')
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {saveState === 'conflict' && (
        <div className="banner banner-warn" role="alert">
          <span>This file was changed outside Ogma while you had unsaved edits.</span>
          <button type="button" onClick={reloadFromDisk}>Load disk version</button>
          <button type="button" onClick={() => void save(true)}>Keep mine</button>
        </div>
      )}
      {saveState === 'error' && saveError && (
        <div className="banner banner-error" role="alert">
          <span>Couldn’t save: {saveError}</span>
          <button type="button" onClick={() => void save()}>Retry</button>
        </div>
      )}
      {notice && (
        <div className="banner banner-info" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} aria-hidden="true" /></button>
        </div>
      )}

      {loaded ? (
        <MarkdownEditor
          key={loaded.generation}
          ref={editor}
          path={path}
          initialText={loaded.document.text}
          placeholder={placeholder}
          autoHeight={compact}
          live={live}
          focusMode={focusMode}
          notesView={notesView}
          onShowNotes={onShowNotes}
          onDocChanged={onDocChanged}
          onSave={() => void save()}
          onBlur={() => void save()}
          onFocus={onFocus}
          onSelectWord={onSelectWord}
        />
      ) : (
        <div className="document-message">Opening…</div>
      )}
    </section>
  )
}
