import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { TextDocument, TextFormat } from '../../shared/ipc'
import { dirname } from '../../shared/paths'
import { countWords } from '../../shared/text'
import { MarkdownEditor, type MarkdownEditorHandle } from './editor/MarkdownEditor'

const AUTOSAVE_DELAY_MS = 1200
const WORD_COUNT_DELAY_MS = 400

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
}

interface DocumentPaneProps {
  ref?: Ref<DocumentPaneHandle>
  path: string
  live: boolean
  focusMode: boolean
  onToggleLive: () => void
  onToggleFocus: () => void
  onInfo: (info: DocumentInfo | null) => void
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Strip Electron's "Error invoking remote method 'files:read': Error: " prefix.
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

export function DocumentPane({
  ref, path, live, focusMode, onToggleLive, onToggleFocus, onInfo, onDirtyChange, onClose,
}: DocumentPaneProps) {
  const [loaded, setLoaded] = useState<{ document: TextDocument; generation: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const editor = useRef<MarkdownEditorHandle>(null)
  const disk = useRef<{ mtimeMs: number; format: TextFormat } | null>(null)
  const state = useRef<SaveState>('saved')
  const version = useRef(0)
  const savedVersion = useRef(0)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const autosaveTimer = useRef<number | undefined>(undefined)
  const wordTimer = useRef<number | undefined>(undefined)
  // Lets save() reschedule itself for edits made while it was writing.
  const saveLater = useRef<() => void>(() => {})

  const updateState = useCallback((next: SaveState) => {
    state.current = next
    setSaveState(next)
  }, [])

  const load = useCallback(() => window.oisin.files.read(path).then(
    (document) => {
      disk.current = { mtimeMs: document.mtimeMs, format: document.format }
      version.current = 0
      savedVersion.current = 0
      setLoadError(null)
      setSaveError(null)
      updateState('saved')
      setLoaded((previous) => ({ document, generation: (previous?.generation ?? 0) + 1 }))
      onInfo({ words: countWords(document.text), format: document.format })
    },
    (error: unknown) => {
      setLoadError(errorMessage(error))
      onInfo(null)
    },
  ), [path, onInfo, updateState])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    onDirtyChange(saveState !== 'saved')
  }, [saveState, onDirtyChange])

  useEffect(() => () => {
    window.clearTimeout(autosaveTimer.current)
    window.clearTimeout(wordTimer.current)
  }, [])

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
        setSaveError(null)
        if (result.notice) setNotice(result.notice)
        onInfo({ words: countWords(text), format: result.format })
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
  }, [path, onInfo, updateState])

  useImperativeHandle(ref, () => ({ flush: () => save() }), [save])

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
    window.clearTimeout(wordTimer.current)
    wordTimer.current = window.setTimeout(() => {
      const format = disk.current?.format
      if (editor.current && format) onInfo({ words: countWords(editor.current.getText()), format })
    }, WORD_COUNT_DELAY_MS)
  }, [onInfo, updateState])

  const reloadFromDisk = () => {
    if (window.confirm('Discard your unsaved changes and load the version on disk?')) void load()
  }

  const fileName = folderName(path)
  const folder = folderName(dirname(path))

  if (loadError) {
    return (
      <section className="document">
        <div className="document-message">
          <h2>Couldn’t open {fileName}</h2>
          <p>{loadError}</p>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    )
  }

  return (
    <section className="document">
      <header className="document-header">
        <div className="document-title" title={path}>
          <span className="document-name">{fileName}</span>
          <span className="document-folder">{folder}</span>
        </div>
        <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>
          {SAVE_LABEL[saveState]}
        </span>
        <div className="document-actions">
          <div className="segmented" role="group" aria-label="Editing mode">
            <button type="button" aria-pressed={live} onClick={live ? undefined : onToggleLive} title="Live rendering (Ctrl+/)">
              Live
            </button>
            <button type="button" aria-pressed={!live} onClick={live ? onToggleLive : undefined} title="Markdown source (Ctrl+/)">
              Source
            </button>
          </div>
          <button type="button" aria-pressed={focusMode} onClick={onToggleFocus} title="Focus mode (F8)">
            Focus
          </button>
        </div>
      </header>

      {saveState === 'conflict' && (
        <div className="banner banner-warn" role="alert">
          <span>This file was changed outside Oisín since you opened it.</span>
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
          live={live}
          focusMode={focusMode}
          onDocChanged={onDocChanged}
          onSave={() => void save()}
          onBlur={() => void save()}
        />
      ) : (
        <div className="document-message">Opening…</div>
      )}
    </section>
  )
}
