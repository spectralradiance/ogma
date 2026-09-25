import { useCallback, useEffect, useRef, useState } from 'react'

import type { SidecarStatus, WorkspaceState } from '../../shared/ipc'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { readPref, writePref } from './prefs'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState>({ roots: [] })
  const [openPath, setOpenPath] = useState<string | null>(() => readPref('openPath'))
  const [live, setLive] = useState(() => readPref('live') !== 'false')
  const [focusMode, setFocusMode] = useState(false)
  const [documentInfo, setDocumentInfo] = useState<DocumentInfo | null>(null)
  const pane = useRef<DocumentPaneHandle>(null)
  const dirty = useRef(false)
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

  const changeOpenPath = useCallback((path: string | null) => {
    setOpenPath(path)
    writePref('openPath', path)
    if (!path) setDocumentInfo(null)
  }, [])

  const openFile = async (path: string) => {
    if (path === openPath) return
    const saved = (await pane.current?.flush()) ?? true
    if (!saved && !window.confirm('The current file could not be saved. Open the other file anyway and lose those changes?')) {
      return
    }
    changeOpenPath(path)
  }

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
      if (!dirty.current || closing.current) return
      event.preventDefault()
      void (pane.current?.flush() ?? Promise.resolve(true)).then((saved) => {
        if (saved || window.confirm('Some changes could not be saved. Close anyway and lose them?')) {
          closing.current = true
          window.close()
        }
      })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value
  }, [])

  const addRoot = () => void window.oisin.workspace.addRoot().then(setWorkspace)
  const removeRoot = (path: string) => void window.oisin.workspace.removeRoot(path).then(setWorkspace)

  return (
    <div className={`shell${focusMode ? ' shell-focus' : ''}`}>
      {!focusMode && (
        <Sidebar roots={workspace.roots} openPath={openPath} onAdd={addRoot} onRemove={removeRoot} onOpen={(path) => void openFile(path)} />
      )}
      <main className="stage">
        {openPath ? (
          <DocumentPane
            key={openPath}
            ref={pane}
            path={openPath}
            live={live}
            focusMode={focusMode}
            onToggleLive={toggleLive}
            onToggleFocus={toggleFocus}
            onInfo={setDocumentInfo}
            onDirtyChange={onDirtyChange}
            onClose={() => changeOpenPath(null)}
          />
        ) : (
          <div className="placeholder">
            <h1 className="wordmark">Oisín</h1>
            <p>{workspace.roots.length > 0 ? 'Choose a file from the sidebar.' : 'Add a folder of notes to begin.'}</p>
          </div>
        )}
      </main>
      <StatusBar status={status} documentInfo={openPath ? documentInfo : null} />
    </div>
  )
}
