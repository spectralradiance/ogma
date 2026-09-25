import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { TextDocument, TextFormat } from '../../shared/ipc'
import { dirname } from '../../shared/paths'
import { countWords, extractHeadings, type Heading } from '../../shared/text'
import { onDiskChange, touchesFile } from './changes'
import { MarkdownEditor, type MarkdownEditorHandle } from './editor/MarkdownEditor'
import { errorMessage } from './target'

const AUTOSAVE_DELAY_MS = 1200
const STATS_DELAY_MS = 400

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Edited',
  saving: 'Saving…',
  conflict: 'Changed on disk',
  error: 'Save failed',
}

export interface DocumentInfo {
  words: number
  format: TextFormat
}

export interface DocumentPaneHandle {
  /** Saves pending edits. Resolves false if they could not be saved. */
  flush(): Promise<boolean>
  revealLine(line: number): void
}

interface DocumentPaneProps {
  ref?: Ref<DocumentPaneHandle>
  path: string
  /** Shown in the header, e.g. "Notes" or "Output". */
  label?: string
  /** Open an empty editor when the file does not exist; the first save creates it. */
  allowMissing?: boolean
  placeholder?: string
  live: boolean
  focusMode: boolean
  headerActions?: ReactNode
  onInfo: (info: DocumentInfo | null) => void
  onHeadings?: (headings: Heading[]) => void
  onDirtyChange: (dirty: boolean) => void
  onFocus?: () => void
  onClose?: () => void
}

interface DiskState {
  mtimeMs: number | null
  format: TextFormat
}

export function DocumentPane({
  ref, path, label, allowMissing = false, placeholder, live, focusMode, headerActions,
  onInfo, onHeadings, onDirtyChange, onFocus, onClose,
}: DocumentPaneProps) {
  const [loaded, setLoaded] = useState<{ document: TextDocument; generation: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exists, setExists] = useState(true)

  const editor = useRef<MarkdownEditorHandle>(null)
  const disk = useRef<DiskState | null>(null)
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
  const parent = useRef({ onInfo, onHeadings, onDirtyChange })
  useLayoutEffect(() => {
    parent.current = { onInfo, onHeadings, onDirtyChange }
  })

  const updateState = useCallback((next: SaveState) => {
    state.current = next
    setSaveState(next)
  }, [])

  const reportStats = useCallback((text: string, format: TextFormat) => {
    parent.current.onInfo({ words: countWords(text), format })
    parent.current.onHeadings?.(extractHeadings(text))
  }, [])

  const applyDocument = useCallback((document: TextDocument) => {
    disk.current = { mtimeMs: document.mtimeMs, format: document.format }
    version.current = 0
    savedVersion.current = 0
    setExists(document.mtimeMs !== null)
    setLoadError(null)
    setSaveError(null)
    updateState('saved')
    setLoaded((previous) => ({ document, generation: (previous?.generation ?? 0) + 1 }))
    reportStats(document.text, document.format)
  }, [reportStats, updateState])

  const load = useCallback(() => window.oisin.files.read(path, { allowMissing }).then(
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

  useEffect(() => () => {
    window.clearTimeout(autosaveTimer.current)
    window.clearTimeout(statsTimer.current)
  }, [])

  // Outside edits: reload silently when there is nothing unsaved, otherwise ask.
  useEffect(() => onDiskChange((paths) => {
    if (!touchesFile(paths, path)) return
    void (async () => {
      if (inFlight.current) await inFlight.current
      const document = await window.oisin.files.read(path, { allowMissing: true }).catch(() => null)
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
    const text = handle.getText()
    updateState('saving')
    const run = (async () => {
      try {
        const result = await window.oisin.files.write({
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
        parent.current.onInfo({ words: countWords(text), format: result.format })
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
    revealLine: (line) => editor.current?.revealLine(line),
  }), [save])

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
    <section className="document">
      <header className="document-header">
        <div className="document-title" title={path}>
          {label && <span className="document-label">{label}</span>}
          <span className="document-name">{fileName}</span>
          {!label && <span className="document-folder">{folderName(dirname(path))}</span>}
          {!exists && <span className="document-new" title="Created when you start typing">new</span>}
        </div>
        <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>
          {exists || saveState !== 'saved' ? SAVE_LABEL[saveState] : ''}
        </span>
        {headerActions}
      </header>

      {saveState === 'conflict' && (
        <div className="banner banner-warn" role="alert">
          <span>This file was changed outside Oisín while you had unsaved edits.</span>
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
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {loaded ? (
        <MarkdownEditor
          key={loaded.generation}
          ref={editor}
          path={path}
          initialText={loaded.document.text}
          placeholder={placeholder}
          live={live}
          focusMode={focusMode}
          onDocChanged={onDocChanged}
          onSave={() => void save()}
          onBlur={() => void save()}
          onFocus={onFocus}
        />
      ) : (
        <div className="document-message">Opening…</div>
      )}
    </section>
  )
}
