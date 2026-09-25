import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SectionInfo, SidecarStatus, WorkspaceState } from '../../shared/ipc'
import type { Heading } from '../../shared/text'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { readPref, writePref } from './prefs'
import { ModeToggles, type PaneCallbacks, SectionView } from './SectionView'
import { StatusBar } from './StatusBar'
import { errorMessage, isOpenSection, type OpenTarget, type PaneId, parseTarget, sameTarget, sectionTarget } from './target'
import { WorkspaceTree } from './WorkspaceTree'

const PANE_LABEL: Record<PaneId, string> = { notes: 'Notes', output: 'Output', file: '' }

export function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState>({ roots: [] })
  const [target, setTarget] = useState<OpenTarget | null>(() => parseTarget(readPref('openTarget')))
  const [live, setLive] = useState(() => readPref('live') !== 'false')
  const [focusMode, setFocusMode] = useState(false)
  const [activePane, setActivePane] = useState<PaneId>(() => (target?.kind === 'file' ? 'file' : 'notes'))
  const [infos, setInfos] = useState<Partial<Record<PaneId, DocumentInfo | null>>>({})
  const [headings, setHeadings] = useState<Partial<Record<PaneId, Heading[]>>>({})
  const panes = useRef<Partial<Record<PaneId, DocumentPaneHandle | null>>>({})
  const dirtyPanes = useRef(new Set<PaneId>())
  const closing = useRef(false)

  useEffect(() => {
    let active = true
    let pushed = false
    // Subscribe first so a status pushed while the initial fetch is in flight is not overwritten.
    const unsubscribe = window.oisin.sidecar.onStatus((next) => {
      pushed = true
      setStatus(next)
    })
    void window.oisin.sidecar.getStatus().then((initial) => {
      if (active && !pushed) setStatus(initial)
    })
    void window.oisin.workspace.get().then((initial) => {
      if (active) setWorkspace(initial)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const flushAll = useCallback(async () => {
    const handles = Object.values(panes.current).filter((handle): handle is DocumentPaneHandle => Boolean(handle))
    return (await Promise.all(handles.map((handle) => handle.flush()))).every(Boolean)
  }, [])

  const changeTarget = useCallback((next: OpenTarget | null) => {
    setTarget(next)
    writePref('openTarget', next ? JSON.stringify(next) : null)
    setInfos({})
    setHeadings({})
    setActivePane(next?.kind === 'file' ? 'file' : 'notes')
  }, [])

  const open = useCallback(async (next: OpenTarget) => {
    if (sameTarget(target, next)) return
    const saved = await flushAll()
    if (!saved && !window.confirm('Some changes could not be saved. Open the other file anyway and lose them?')) return
    changeTarget(next)
  }, [target, flushAll, changeTarget])

  const runSectionOperation = useCallback(async (
    folder: string,
    stem: string,
    operation: () => Promise<SectionInfo | null>,
  ) => {
    const affectsOpen = isOpenSection(target, folder, stem)
    if (affectsOpen && !(await flushAll())) {
      window.alert('The open section has unsaved changes that could not be saved. Resolve that first.')
      return
    }
    try {
      const result = await operation()
      if (affectsOpen) changeTarget(result ? sectionTarget(folder, result) : null)
    } catch (error) {
      window.alert(errorMessage(error))
    }
  }, [target, flushAll, changeTarget])

  const toggleLive = useCallback(() => {
    setLive((value) => {
      writePref('live', String(!value))
      return !value
    })
  }, [])
  const toggleFocus = useCallback(() => setFocusMode((value) => !value), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault()
        event.stopPropagation()
        toggleLive()
      } else if (event.key === 'F8') {
        event.preventDefault()
        toggleFocus()
      } else if (event.key === 'Escape' && focusMode) {
        setFocusMode(false)
      }
    }
    // Capture phase so these win over CodeMirror's own bindings (Ctrl+/ toggles comments there).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleLive, toggleFocus, focusMode])

  useEffect(() => {
    // Hold the window open until pending edits are on disk.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyPanes.current.size === 0 || closing.current) return
      event.preventDefault()
      void flushAll().then((saved) => {
        if (saved || window.confirm('Some changes could not be saved. Close anyway and lose them?')) {
          closing.current = true
          window.close()
        }
      })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushAll])

  const callbacks = useMemo<PaneCallbacks>(() => ({
    bindPane: (pane, handle) => {
      panes.current[pane] = handle
    },
    onInfo: (pane, info) => setInfos((current) => ({ ...current, [pane]: info })),
    onHeadings: (pane, list) => setHeadings((current) => ({ ...current, [pane]: list })),
    onDirtyChange: (pane, dirty) => {
      if (dirty) dirtyPanes.current.add(pane)
      else dirtyPanes.current.delete(pane)
    },
    onActivePane: setActivePane,
  }), [])

  const addRoot = () => void window.oisin.workspace.addRoot().then(setWorkspace)
  const removeRoot = (path: string) => void window.oisin.workspace.removeRoot(path).then(setWorkspace)

  const outlinePane: PaneId = target?.kind === 'file' ? 'file' : activePane
  const outline = target ? { pane: outlinePane, headings: headings[outlinePane] ?? [] } : null
  const info = infos[target?.kind === 'file' ? 'file' : activePane] ?? null
  const mode = { live, focusMode, onToggleLive: toggleLive, onToggleFocus: toggleFocus }

  return (
    <div className={`shell${focusMode ? ' shell-focus' : ''}`}>
      {!focusMode && (
        <WorkspaceTree
          roots={workspace.roots}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          target={target}
          outline={outline}
          open={(next) => void open(next)}
          reveal={(line) => panes.current[outlinePane]?.revealLine(line)}
          runSectionOperation={runSectionOperation}
        />
      )}
      <main className="stage">
        {target?.kind === 'section' && (
          <SectionView key={`${target.notesPath}|${target.outputPath}`} target={target} callbacks={callbacks} {...mode} />
        )}
        {target?.kind === 'file' && (
          <DocumentPane
            key={target.path}
            ref={(handle) => callbacks.bindPane('file', handle)}
            path={target.path}
            live={live}
            focusMode={focusMode}
            headerActions={<ModeToggles {...mode} />}
            onInfo={(next) => callbacks.onInfo('file', next)}
            onHeadings={(list) => callbacks.onHeadings('file', list)}
            onDirtyChange={(dirty) => callbacks.onDirtyChange('file', dirty)}
            onClose={() => changeTarget(null)}
          />
        )}
        {!target && (
          <div className="placeholder">
            <h1 className="wordmark">Oisín</h1>
            <p>{workspace.roots.length > 0 ? 'Choose a section or file from the sidebar.' : 'Add a folder of notes to begin.'}</p>
          </div>
        )}
      </main>
      <StatusBar
        status={status}
        documentInfo={info}
        documentLabel={target?.kind === 'section' ? PANE_LABEL[activePane] : ''}
      />
    </div>
  )
}
