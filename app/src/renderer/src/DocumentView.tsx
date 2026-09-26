import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

import type { FolderModel, SectionInfo } from '../../shared/ipc'
import { joinPath } from '../../shared/paths'
import { type Heading, type LeadingHeading, splitLeadingHeading } from '../../shared/text'
import type { WordInContext } from './editor/MarkdownEditor'
import { onDiskChange, touchesFolder } from './changes'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { ExportDialog } from './ExportDialog'
import { type PaneState, SectionHeader, type SectionLayout } from './SectionHeader'
import { StatsDialog } from './StatsDialog'
import { readPref, writePref } from './prefs'
import { type ActivePane, errorMessage, type OpenTarget, VIEW_MODES, type ViewMode } from './target'

export type Drawer = 'words' | 'ai'

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
  /** Runs a rename/move/merge, saving open editors first and reloading afterwards. */
  onSectionOperation: (folder: string, stem: string, operation: () => Promise<SectionInfo | null>) => Promise<void>
  callbacks: PaneCallbacks
  onOpenFile: (path: string) => void
}

/**
 * A double document shown whole: every section in order, laid out as one
 * column (output then notes), side by side, or output/notes only. Each block
 * is its own editor saving to its own file.
 */
const sameHeading = (left: LeadingHeading | null | undefined, right: LeadingHeading | null) =>
  (left ?? null) === right || (left != null && right !== null && left.level === right.level && left.text === right.text)

export function DocumentView({
  target, view, onView, reloadToken, flush, onSectionOperation, callbacks, onOpenFile, ...mode
}: DocumentViewProps) {
  const { folder } = target
  const [model, setModel] = useState<FolderModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [swapped, setSwapped] = useState(() => readPref('panesSwapped') === 'true')
  const [ratio, setRatio] = useState(readRatio)
  const [exporting, setExporting] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [paneStates, setPaneStates] = useState<Record<string, PaneState>>({})
  // Each output file's first-line heading: the section's heading (keyed by output path).
  const [leading, setLeading] = useState<Record<string, LeadingHeading | null>>({})
  const [layouts, setLayouts] = useState<Record<string, SectionLayout>>(() => {
    try {
      return JSON.parse(readPref(`sectionLayout:${folder}`) ?? '{}') as Record<string, SectionLayout>
    } catch {
      return {}
    }
  })
  const handles = useRef(new Map<string, DocumentPaneHandle>())
  const sections = useRef(new Map<string, HTMLElement>())
  const body = useRef<HTMLDivElement>(null)

  const load = useCallback(() => window.oisin.folders.read(folder).then(
    async (next) => {
      // Section headings for every section, including those whose output is not shown.
      const found = await Promise.all(next.sections.map(async (section): Promise<[string, LeadingHeading | null]> => {
        const path = joinPath(folder, section.outputName)
        if (!section.output) return [path, null]
        const document = await window.oisin.files.read(path, { allowMissing: true }).catch(() => null)
        return [path, document ? splitLeadingHeading(document.text).heading : null]
      }))
      setLeading(Object.fromEntries(found))
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

  const layoutOf = (section: SectionInfo): SectionLayout => layouts[section.stem.toLowerCase()] ?? {}
  const setLayout = (section: SectionInfo, layout: SectionLayout) => {
    setLayouts((current) => {
      const next = { ...current, [section.stem.toLowerCase()]: layout }
      writePref(`sectionLayout:${folder}`, JSON.stringify(next))
      return next
    })
  }
  const pathOf = (section: SectionInfo, role: Role) => joinPath(folder, role === 'notes' ? section.notesName : section.outputName)

  const block = (section: SectionInfo, role: Role, background = false) => {
    const path = pathOf(section, role)
    const copy = ROLE_COPY[role]
    const hidden = role === 'notes' ? layoutOf(section).hideNotes : layoutOf(section).hideOutput
    if (hidden) {
      return (
        <button key={path} type="button" className={`doc-hidden doc-${role}`}
          onClick={() => setLayout(section, { ...layoutOf(section), [role === 'notes' ? 'hideNotes' : 'hideOutput']: false })}>
          {copy.label} hidden — show
        </button>
      )
    }
    return (
      <DocumentPane
        key={path}
        ref={(handle) => {
          if (handle) handles.current.set(path, handle)
          else handles.current.delete(path)
          callbacks.bindPane(path, handle)
        }}
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
        onSaveState={(state, exists) => setPaneStates((current) => (
          current[path]?.state === state && current[path]?.exists === exists ? current : { ...current, [path]: { state, exists } }
        ))}
        onLeadingHeading={role === 'output'
          ? (heading) => setLeading((current) => (sameHeading(current[path], heading) ? current : { ...current, [path]: heading }))
          : undefined}
      />
    )
  }

  const setHeading = (section: SectionInfo, heading: LeadingHeading | null) => {
    void onSectionOperation(folder, section.stem, () => window.oisin.sections.setHeading(folder, section.stem, heading))
  }
  // New headings follow the level the document's other section headings use.
  const headingLevel = Object.values(leading).find((heading) => heading)?.level ?? 1

  const merge = (section: SectionInfo, direction: 'previous' | 'next') => {
    const list = model?.sections ?? []
    const index = list.indexOf(section)
    const [earlier, later] = direction === 'previous' ? [list[index - 1], section] : [section, list[index + 1]]
    if (!earlier || !later) return
    const question = `Merge “${later.title}” into “${earlier.title}”?\n\n`
      + `Its notes and output are added to the end of “${earlier.title}”'s, and its files go to the Recycle Bin. `
      + 'The files that change are backed up first.'
    if (!window.confirm(question)) return
    void onSectionOperation(folder, later.stem, () => window.oisin.sections.merge(folder, earlier.stem, later.stem))
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
        <button type="button" onClick={() => setShowStats(true)} title="Word counts per section, goal and daily progress">Stats</button>
        <button type="button" onClick={() => setExporting(true)} title="Export the document as PDF, HTML or Markdown">Export…</button>
        <ModeToggles {...mode} />
      </header>
      {exporting && <ExportDialog folder={folder} title={target.title} flush={flush} onClose={() => setExporting(false)} />}
      {showStats && (
        <StatsDialog
          folder={folder}
          title={target.title}
          onClose={() => setShowStats(false)}
          onOpenSection={(stem) => {
            setShowStats(false)
            sections.current.get(stem.toLowerCase())?.scrollIntoView({ block: 'start' })
          }}
        />
      )}

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
        {model?.sections.map((section, index) => (
          <article
            key={section.stem}
            className="doc-section"
            ref={(element) => {
              if (element) sections.current.set(section.stem.toLowerCase(), element)
              else sections.current.delete(section.stem.toLowerCase())
            }}
          >
            <SectionHeader
              section={section}
              notes={paneStates[pathOf(section, 'notes')]}
              output={paneStates[pathOf(section, 'output')]}
              layout={layoutOf(section)}
              previous={model.sections[index - 1] ?? null}
              next={model.sections[index + 1] ?? null}
              onLayout={(layout) => setLayout(section, layout)}
              onRename={(title) => void onSectionOperation(folder, section.stem, () => window.oisin.sections.rename(folder, section.stem, title))}
              onMove={(direction) => void onSectionOperation(folder, section.stem, () => window.oisin.sections.move(folder, section.stem, direction))}
              onMerge={(direction) => merge(section, direction)}
              onHistory={(role) => handles.current.get(pathOf(section, role))?.openHistory()}
              heading={leading[pathOf(section, 'output')] ?? null}
              onHeading={(on) => setHeading(section, on ? { level: headingLevel, text: section.title } : null)}
              onMatchHeading={(use) => {
                const heading = leading[pathOf(section, 'output')]
                if (!heading) return
                if (use === 'title') setHeading(section, { ...heading, text: section.title })
                else void onSectionOperation(folder, section.stem, () => window.oisin.sections.rename(folder, section.stem, heading.text))
              }}
            />
            {view === 'column' && (layoutOf(section).swapped ? (
              <>
                {block(section, 'notes', true)}
                {block(section, 'output')}
              </>
            ) : (
              <>
                {block(section, 'output')}
                {block(section, 'notes', true)}
              </>
            ))}
            {view === 'split' && (
              <div className="doc-row" style={{ gridTemplateColumns: columns }}>
                {block(section, layoutOf(section).swapped ? right : left)}
                <div className="doc-gutter" />
                {block(section, layoutOf(section).swapped ? left : right)}
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
