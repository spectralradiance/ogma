import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

import type { FolderModel, SectionInfo } from '../../shared/ipc'
import { joinPath } from '../../shared/paths'
import type { Heading } from '../../shared/text'
import type { WordInContext } from './editor/MarkdownEditor'
import { onDiskChange, touchesFolder } from './changes'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { ExportDialog } from './ExportDialog'
import { readPref, writePref } from './prefs'
import { type ActivePane, errorMessage, type OpenTarget, VIEW_MODES, type ViewMode } from './target'

export type Drawer = 'words' | 'ai'

interface ModeProps {
  live: boolean
  focusMode: boolean
  drawer: Drawer | null
  onToggleLive: () => void
  onToggleFocus: () => void
  onToggleDrawer: (drawer: Drawer) => void
}

export function ModeToggles({ live, focusMode, drawer, onToggleLive, onToggleFocus, onToggleDrawer }: ModeProps) {
  return (
    <div className="mode-toggles">
      <div className="segmented" role="group" aria-label="Side panel">
        <button type="button" aria-pressed={drawer === 'words'} onClick={() => onToggleDrawer('words')}
          title="Dictionary, thesaurus and lexicon (Ctrl+D looks up the word at the cursor)">
          Words
        </button>
        <button type="button" aria-pressed={drawer === 'ai'} onClick={() => onToggleDrawer('ai')}
          title="Draft output from notes, analyze, word choice (Ctrl+J)">
          AI
        </button>
      </div>
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
  )
}

/** How each editor reports back to the app; panes are identified by file path. */
export interface PaneCallbacks {
  bindPane: (path: string, handle: DocumentPaneHandle | null) => void
  onInfo: (path: string, info: DocumentInfo | null) => void
  onHeadings: (path: string, headings: Heading[]) => void
  onDirtyChange: (path: string, dirty: boolean) => void
  onActivePane: (active: ActivePane) => void
  onSelectWord: (path: string, word: WordInContext) => void
}

type DocumentTarget = Extract<OpenTarget, { kind: 'document' }>
type Role = 'notes' | 'output'

const ROLE_COPY: Record<Role, { label: string; placeholder: string }> = {
  notes: { label: 'Notes', placeholder: 'Background: working notes, research and fragments…' },
  output: { label: 'Output', placeholder: 'Foreground: the finished text of this section. Created when you start typing.' },
}

function readRatio(): number {
  const value = Number(readPref('paneRatio'))
  return value >= 0.2 && value <= 0.8 ? value : 0.5
}

interface DocumentViewProps extends ModeProps {
  target: DocumentTarget
  view: ViewMode
  onView: (view: ViewMode) => void
  /** Changes when the app renamed or moved something here, so the folder is re-read. */
  reloadToken: number
  /** Saves every open editor. */
  flush: () => Promise<boolean>
  callbacks: PaneCallbacks
  onOpenFile: (path: string) => void
}

/**
 * A double document shown whole: every section in order, laid out as one
 * column (output then notes), side by side, or output/notes only. Each block
 * is its own editor saving to its own file.
 */
export function DocumentView({ target, view, onView, reloadToken, flush, callbacks, onOpenFile, ...mode }: DocumentViewProps) {
  const { folder } = target
  const [model, setModel] = useState<FolderModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [swapped, setSwapped] = useState(() => readPref('panesSwapped') === 'true')
  const [ratio, setRatio] = useState(readRatio)
  const [exporting, setExporting] = useState(false)
  const sections = useRef(new Map<string, HTMLElement>())
  const body = useRef<HTMLDivElement>(null)

  const load = useCallback(() => window.oisin.folders.read(folder).then(
    (next) => {
      setModel(next)
      setError(null)
    },
    (reason: unknown) => setError(errorMessage(reason)),
  ), [folder])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  useEffect(() => onDiskChange((paths) => {
    if (touchesFolder(paths, folder)) void load()
  }), [folder, load])

  // Scroll to the requested section, and again once its editors have laid out.
  useEffect(() => {
    if (!model || !target.focusStem) return
    const scroll = () => sections.current.get(target.focusStem!.toLowerCase())?.scrollIntoView({ block: 'start' })
    scroll()
    const timer = window.setTimeout(scroll, 300)
    return () => window.clearTimeout(timer)
  }, [model, target.focusStem, target.nonce])

  const toggleSwap = () => {
    setSwapped((value) => {
      writePref('panesSwapped', String(!value))
      return !value
    })
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = body.current
    if (!container) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = container.getBoundingClientRect()
    let latest = ratio
    const move = (moveEvent: PointerEvent) => {
      latest = Math.min(0.8, Math.max(0.2, (moveEvent.clientX - rect.left) / rect.width))
      setRatio(latest)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      writePref('paneRatio', String(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const block = (section: SectionInfo, role: Role, background = false) => {
    const path = joinPath(folder, role === 'notes' ? section.notesName : section.outputName)
    const copy = ROLE_COPY[role]
    return (
      <DocumentPane
        key={path}
        ref={(handle) => callbacks.bindPane(path, handle)}
        path={path}
        label={copy.label}
        compact
        allowMissing
        placeholder={copy.placeholder}
        className={`doc-block doc-${role}${background ? ' doc-background' : ''}`}
        live={mode.live}
        focusMode={mode.focusMode}
        onInfo={(info) => callbacks.onInfo(path, info)}
        onHeadings={(list) => callbacks.onHeadings(path, list)}
        onDirtyChange={(dirty) => callbacks.onDirtyChange(path, dirty)}
        onFocus={() => callbacks.onActivePane({
          path,
          folder,
          stem: section.stem,
          section: {
            title: section.title,
            notesPath: joinPath(folder, section.notesName),
            outputPath: joinPath(folder, section.outputName),
          },
        })}
        onSelectWord={(word) => callbacks.onSelectWord(path, word)}
      />
    )
  }

  const [left, right]: [Role, Role] = swapped ? ['output', 'notes'] : ['notes', 'output']
  const columns = `${ratio}fr 6px ${1 - ratio}fr`

  return (
    <section className="document-view">
      <header className="section-header">
        <div className="section-title">
          {target.ordinal && <span className="section-ordinal">{target.ordinal}</span>}
          <h1>{target.title}</h1>
        </div>
        <div className="segmented" role="group" aria-label="Document view">
          {VIEW_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={view === option.id}
              onClick={() => onView(option.id)}
              title={option.title}
            >
              {option.label}
            </button>
          ))}
        </div>
        {view === 'split' && (
          <button type="button" onClick={toggleSwap} title="Swap notes and output sides">⇄</button>
        )}
        <button type="button" onClick={() => setExporting(true)} title="Export the document as PDF, HTML or Markdown">Export…</button>
        <ModeToggles {...mode} />
      </header>
      {exporting && <ExportDialog folder={folder} title={target.title} flush={flush} onClose={() => setExporting(false)} />}

      {model && model.documentNotes.length > 0 && (
        <nav className="document-notes" aria-label="Document notes">
          <span>Document notes:</span>
          {model.documentNotes.map((name) => (
            <button key={name} type="button" className="link-button" onClick={() => onOpenFile(joinPath(folder, name))}>
              {name}
            </button>
          ))}
        </nav>
      )}

      <div className={`document-body view-${view}`} ref={body}>
        {error && <div className="document-message">{error}</div>}
        {model && model.sections.length === 0 && (
          <div className="document-message">
            This folder has no sections yet. Add one with + in the sidebar, or open its files individually.
          </div>
        )}
        {view === 'split' && model && model.sections.length > 0 && (
          <div className="doc-columns" style={{ gridTemplateColumns: columns }}>
            <span className="doc-column-label">{ROLE_COPY[left].label}</span>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startDrag}
              onDoubleClick={() => {
                setRatio(0.5)
                writePref('paneRatio', '0.5')
              }}
              title="Drag to resize; double-click to reset"
            />
            <span className="doc-column-label">{ROLE_COPY[right].label}</span>
          </div>
        )}
        {model?.sections.map((section) => (
          <article
            key={section.stem}
            className="doc-section"
            ref={(element) => {
              if (element) sections.current.set(section.stem.toLowerCase(), element)
              else sections.current.delete(section.stem.toLowerCase())
            }}
          >
            <h2 className="doc-section-title">
              {section.ordinal && <span className="section-ordinal">{section.ordinal}</span>}
              {section.title}
            </h2>
            {view === 'column' && (
              <>
                {block(section, 'output')}
                {block(section, 'notes', true)}
              </>
            )}
            {view === 'split' && (
              <div className="doc-row" style={{ gridTemplateColumns: columns }}>
                {block(section, left)}
                <div className="doc-gutter" />
                {block(section, right)}
              </div>
            )}
            {view === 'output' && block(section, 'output')}
            {view === 'notes' && block(section, 'notes')}
          </article>
        ))}
      </div>
    </section>
  )
}
