import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { Heading } from '../../shared/text'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { readPref, writePref } from './prefs'
import type { OpenTarget, PaneId } from './target'

interface ModeProps {
  live: boolean
  focusMode: boolean
  onToggleLive: () => void
  onToggleFocus: () => void
}

export function ModeToggles({ live, focusMode, onToggleLive, onToggleFocus }: ModeProps) {
  return (
    <div className="mode-toggles">
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

export interface PaneCallbacks {
  bindPane: (pane: PaneId, handle: DocumentPaneHandle | null) => void
  onInfo: (pane: PaneId, info: DocumentInfo | null) => void
  onHeadings: (pane: PaneId, headings: Heading[]) => void
  onDirtyChange: (pane: PaneId, dirty: boolean) => void
  onActivePane: (pane: PaneId) => void
}

type SectionTarget = Extract<OpenTarget, { kind: 'section' }>

const PANE_COPY = {
  notes: { label: 'Notes', placeholder: 'Working notes, research and fragments for this section…' },
  output: { label: 'Output', placeholder: 'The polished text of this section. The file is created when you start typing.' },
} as const

function readRatio(): number {
  const value = Number(readPref('paneRatio'))
  return value >= 0.2 && value <= 0.8 ? value : 0.5
}

/** Notes and output side by side, with a draggable splitter; either side can be collapsed or swapped. */
export function SectionView({ target, callbacks, ...mode }: ModeProps & { target: SectionTarget; callbacks: PaneCallbacks }) {
  const [ratio, setRatio] = useState(readRatio)
  const [swapped, setSwapped] = useState(() => readPref('panesSwapped') === 'true')
  const [collapsed, setCollapsed] = useState<'notes' | 'output' | null>(null)
  const panes = useRef<HTMLDivElement>(null)

  const [left, right]: ['notes' | 'output', 'notes' | 'output'] = swapped ? ['output', 'notes'] : ['notes', 'output']

  const toggleSwap = () => {
    setSwapped((value) => {
      writePref('panesSwapped', String(!value))
      return !value
    })
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = panes.current
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

  const columns = collapsed === left
    ? '32px 0 1fr'
    : collapsed === right
      ? '1fr 0 32px'
      : `${ratio}fr 6px ${1 - ratio}fr`

  const renderPane = (pane: 'notes' | 'output', side: 'left' | 'right') => {
    const copy = PANE_COPY[pane]
    if (collapsed === pane) {
      return (
        <button type="button" className="pane-strip" onClick={() => setCollapsed(null)} title={`Show ${copy.label.toLowerCase()}`}>
          <span>{copy.label}</span>
        </button>
      )
    }
    const path = pane === 'notes' ? target.notesPath : target.outputPath
    return (
      <DocumentPane
        key={path}
        ref={(handle) => callbacks.bindPane(pane, handle)}
        path={path}
        label={copy.label}
        allowMissing
        placeholder={copy.placeholder}
        live={mode.live}
        focusMode={mode.focusMode}
        onInfo={(info) => callbacks.onInfo(pane, info)}
        onHeadings={(headings) => callbacks.onHeadings(pane, headings)}
        onDirtyChange={(dirty) => callbacks.onDirtyChange(pane, dirty)}
        onFocus={() => callbacks.onActivePane(pane)}
        headerActions={(
          <button
            type="button"
            className="icon-button"
            onClick={() => setCollapsed(pane)}
            title={`Hide ${copy.label.toLowerCase()}`}
            aria-label={`Hide ${copy.label.toLowerCase()}`}
          >
            {side === 'left' ? '⟨' : '⟩'}
          </button>
        )}
      />
    )
  }

  return (
    <section className="section-view">
      <header className="section-header">
        <div className="section-title">
          {target.ordinal && <span className="section-ordinal">{target.ordinal}</span>}
          <h1>{target.title}</h1>
          <span className="section-document">{folderName(target.folder)}</span>
        </div>
        <button type="button" onClick={toggleSwap} title="Swap notes and output sides">⇄ Swap</button>
        <ModeToggles {...mode} />
      </header>
      <div className="panes" ref={panes} style={{ gridTemplateColumns: columns }}>
        {renderPane(left, 'left')}
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setRatio(0.5)
            writePref('paneRatio', '0.5')
          }}
          hidden={collapsed !== null}
          title="Drag to resize; double-click to reset"
        />
        {renderPane(right, 'right')}
      </div>
    </section>
  )
}
