import { useEffect, useState } from 'react'

import type { ExportOptions, ExportOutcome } from '../../shared/ipc'
import { errorMessage } from './target'

interface ExportDialogProps {
  folder: string
  title: string
  /** Saves open editors first, so the export includes the latest text. */
  flush: () => Promise<boolean>
  onClose: () => void
}

export function ExportDialog({ folder, title, flush, onClose }: ExportDialogProps) {
  const [options, setOptions] = useState<ExportOptions>({ format: 'pdf', content: 'output', includeTitle: true })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start from the defaults in Settings → Export.
  useEffect(() => {
    void window.oisin.preferences.get().then((preferences) => setOptions((current) => ({
      ...current, format: preferences.export.format, includeTitle: preferences.export.includeTitle,
    })))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!(await flush())) throw new Error('Some edits could not be saved; resolve that before exporting.')
      const result = await window.oisin.exports.document(folder, title, options)
      if (result) setOutcome(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal export-dialog" role="dialog" aria-label="Export document">
        <header className="modal-header">
          <h2>Export · {title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="settings-body">
          <div className="settings-section">
            <fieldset className="export-choice">
              <legend>Content</legend>
              <label><input type="radio" checked={options.content === 'output'} onChange={() => setOptions({ ...options, content: 'output' })} /> Output (the finished text)</label>
              <label><input type="radio" checked={options.content === 'notes'} onChange={() => setOptions({ ...options, content: 'notes' })} /> Notes</label>
            </fieldset>
            <fieldset className="export-choice">
              <legend>Format</legend>
              <label><input type="radio" checked={options.format === 'pdf'} onChange={() => setOptions({ ...options, format: 'pdf' })} /> PDF</label>
              <label><input type="radio" checked={options.format === 'html'} onChange={() => setOptions({ ...options, format: 'html' })} /> HTML page</label>
              <label><input type="radio" checked={options.format === 'md'} onChange={() => setOptions({ ...options, format: 'md' })} /> Markdown</label>
            </fieldset>
            <label>
              <input type="checkbox" checked={options.includeTitle} onChange={(event) => setOptions({ ...options, includeTitle: event.target.checked })} />
              {' '}Start with the document title
            </label>
            <p className="lexical-hint">
              Sections are joined in order; a section without a heading continues the one before (notes exports give every section its title).
              Empty sections are left out. Fonts, page size and margins are in Settings → Export.
            </p>
            {error && <p className="lexical-message status-error">{error}</p>}
            {outcome && (
              <p className="lexical-message">
                Exported {outcome.sections} section{outcome.sections === 1 ? '' : 's'} to {outcome.path}
                {outcome.skipped.length > 0 && <> (left out, nothing written yet: {outcome.skipped.join(', ')})</>}.{' '}
                <button type="button" className="link-button" onClick={() => void window.oisin.exports.showInFolder(outcome.path)}>Show in folder</button>
              </p>
            )}
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export…'}</button>
        </footer>
      </section>
    </div>
  )
}
