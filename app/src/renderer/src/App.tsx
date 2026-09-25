import { useEffect, useState } from 'react'

import type { SidecarStatus, WorkspaceState } from '../../shared/ipc'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState>({ roots: [] })

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

  const addRoot = () => void window.oisin.workspace.addRoot().then(setWorkspace)
  const removeRoot = (path: string) => void window.oisin.workspace.removeRoot(path).then(setWorkspace)

  return (
    <div className="shell">
      <Sidebar roots={workspace.roots} onAdd={addRoot} onRemove={removeRoot} />
      <main className="stage">
        <div className="placeholder">
          <h1 className="wordmark">Oisín</h1>
          <p>{workspace.roots.length > 0 ? 'The editor arrives in Phase 1.' : 'Add a folder of notes to begin.'}</p>
        </div>
      </main>
      <StatusBar status={status} />
    </div>
  )
}
