import { useCallback, useEffect, useMemo, useState } from 'react'

import { diffLines } from '../../shared/diff'
import { folderName } from '../../shared/format'
import type { SnapshotEntry } from '../../shared/ipc'
import { errorMessage } from './target'

interface HistoryDialogProps {
  path: string
  /** The editor's current text. */
  current: () => string
  /** Puts a version into the editor as one undoable edit. */
  onRestore: (text: string) => void
  onClose: () => void
}

function when(iso: string): string {
  const date = new Date(iso)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? `Today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function HistoryDialog({ path, current, onRestore, onClose }: HistoryDialogProps) {
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null)
  const [selected, setSelected] = useState<{ id: string; text: string } | null>(null)
  const [label, setLabel] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [now] = useState(current)

  const refresh = useCallback(() => window.oisin.history.list(path).then(setEntries, (reason: unknown) => setMessage(errorMessage(reason))), [path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = (id: string) => {
    window.oisin.history.read(path, id).then((text) => setSelected({ id, text }), (reason: unknown) => setMessage(errorMessage(reason)))
  }

  const saveSnapshot = () => {
    window.oisin.history.snapshot(path, current(), label).then(() => {
      setLabel('')
      setMessage('Snapshot saved.')
      void refresh()
    }, (reason: unknown) => setMessage(errorMessage(reason)))
  }

  // Changes from the selected version to now: red is what the version had, green is what is there now.
  const hunks = useMemo(() => (selected ? diffLines(selected.text, now) : []), [selected, now])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal history" role="dialog" aria-label={`History of ${folderName(path)}`}>
        <header className="modal-header">
          <div>
            <h2>History · {folderName(path)}</h2>
            <p className="modal-subtitle">Saved automatically at most every 10 minutes while you edit, plus any snapshots you take.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="history-body">
          <aside className="history-list">
            <div className="history-snapshot">
              <input value={label} placeholder="Label (optional)" onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') saveSnapshot() }} />
              <button type="button" onClick={saveSnapshot}>Save snapshot</button>
            </div>
            {entries?.length === 0 && <p className="lexical-message">No versions yet. They appear as you save.</p>}
            <ul>
              {entries?.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className={selected?.id === entry.id ? 'selected' : ''} onClick={() => choose(entry.id)}>
                    <strong>{entry.label ?? when(entry.at)}</strong>
                    <span>{entry.label ? `${when(entry.at)} · ` : ''}{entry.words.toLocaleString()} words</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <div className="review-body history-diff">
            {message && <p className="lexical-message">{message}</p>}
            {!selected && <p className="lexical-message">Choose a version to compare it with the text as it is now.</p>}
            {selected && hunks.every((hunk) => hunk.kind === 'same') && <p className="lexical-message">This version is the same as the current text.</p>}
            {selected && hunks.map((hunk, index) => hunk.kind === 'same' ? (
              <div key={index} className="review-same">{hunk.lines.join('\n') || ' '}</div>
            ) : (
              <div key={index} className="review-change kept">
                <div className="review-change-body">
                  {hunk.before.length > 0 && <div className="review-before" title="In this version, not now">{hunk.before.join('\n') || ' '}</div>}
                  {hunk.after.length > 0 && <div className="review-after" title="Now, not in this version">{hunk.after.join('\n') || ' '}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <footer className="modal-footer">
          <span className="lexical-hint history-legend">Red: only in this version · Green: only in the current text</span>
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="primary" disabled={!selected} onClick={() => selected && onRestore(selected.text)}>
            Restore this version
          </button>
        </footer>
      </section>
    </div>
  )
}
