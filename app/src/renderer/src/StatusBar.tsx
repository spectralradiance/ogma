import { useCallback, useEffect, useState } from 'react'

import { describeGpu, describeProviders, describeTorch, formatMegabytes } from '../../shared/format'
import type { SidecarState, SidecarStatus } from '../../shared/ipc'
import { encodingLabel, lineEndingLabel } from '../../shared/text'
import type { DocumentInfo } from './DocumentPane'

const STATE_LABEL: Record<SidecarState, string> = {
  starting: 'AI server starting…',
  online: 'AI server online',
  error: 'AI server offline',
  stopped: 'AI server stopped',
}

interface StatusBarProps {
  status: SidecarStatus | null
  documentInfo: DocumentInfo | null
  /** Which pane the document info describes, e.g. "Notes". */
  documentLabel?: string
  /** Net words written today across all files. */
  todayWords?: number | null
}

export function StatusBar({ status, documentInfo, documentLabel, todayWords }: StatusBarProps) {
  const [open, setOpen] = useState(false)
  const state = status?.state ?? 'starting'
  const health = status?.health

  return (
    <footer className="statusbar">
      <button
        type="button"
        className="status-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="AI server details"
      >
        <span className={`dot dot-${state}`} aria-hidden="true" />
        <span>{STATE_LABEL[state]}</span>
      </button>
      {health && (
        <>
          <span className="status-item">{describeGpu(health.gpu)}</span>
          <span className="status-item">{describeTorch(health.torch)}</span>
          <span className="status-item">{describeProviders(health.providers)}</span>
        </>
      )}
      {!health && status?.error && <span className="status-item status-error">{status.error}</span>}
      {todayWords !== undefined && todayWords !== null && todayWords !== 0 && (
        <span className="status-item status-today" title="Net words written today, all files">
          Today {todayWords > 0 ? '+' : ''}{todayWords.toLocaleString()}
        </span>
      )}
      {documentInfo && (
        <span className="status-document">
          {documentLabel && <span className="status-pane">{documentLabel}</span>}
          <span>{documentInfo.words.toLocaleString()} {documentInfo.words === 1 ? 'word' : 'words'}</span>
          <span title="File encoding">{encodingLabel(documentInfo.format.encoding)}</span>
          <span title="Line endings">
            {lineEndingLabel(documentInfo.format.eol)}{documentInfo.format.mixedEol ? ' (mixed)' : ''}
          </span>
        </span>
      )}
      {open &&<SidecarDetails status={status} onClose={() => setOpen(false)} />}
    </footer>
  )
}

function SidecarDetails({ status, onClose }: { status: SidecarStatus | null; onClose: () => void }) {
  const [logs, setLogs] = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)
  const health = status?.health

  const refreshLogs = useCallback(() => {
    void window.oisin.sidecar.getLogs().then(setLogs)
  }, [])

  useEffect(() => {
    refreshLogs()
  }, [refreshLogs, status?.state])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const restart = () => {
    setRestarting(true)
    void window.oisin.sidecar.restart().finally(() => setRestarting(false))
  }

  return (
    <section className="details" role="dialog" aria-label="AI server details">
      <header className="details-header">
        <h2>AI server</h2>
        <div className="details-actions">
          <button type="button" onClick={restart} disabled={restarting}>
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
      </header>

      {status?.error && <p className="status-error">{status.error}</p>}

      {health && (
        <>
          <dl className="facts">
            <dt>Version</dt>
            <dd>{health.version} · Python {health.python} · pid {health.pid}</dd>
            <dt>Environment</dt>
            <dd title={health.python_prefix}>
              {health.in_virtualenv ? 'virtual environment' : 'system Python (not a venv)'} · {health.python_prefix}
            </dd>
            <dt>PyTorch</dt>
            <dd>{describeTorch(health.torch)}</dd>
            {health.gpu.devices.map((device) => (
              <div key={device.index} className="fact-row">
                <dt>GPU {device.index}</dt>
                <dd>
                  {device.name} · {formatMegabytes(device.memory_used_mb)} used of{' '}
                  {formatMegabytes(device.memory_total_mb)} · driver {device.driver_version}
                </dd>
              </div>
            ))}
            {health.gpu.devices.length === 0 && (
              <>
                <dt>GPU</dt>
                <dd>{describeGpu(health.gpu)}</dd>
              </>
            )}
          </dl>

          <h3>Providers</h3>
          <ul className="providers">
            {health.providers.map((provider) => (
              <li key={provider.id}>
                <span className={`dot ${provider.configured ? 'dot-online' : 'dot-stopped'}`} aria-hidden="true" />
                <span className="provider-label">{provider.label}</span>
                <span className="provider-detail">{provider.configured ? 'ready' : provider.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>
        Log <button type="button" className="link-button" onClick={refreshLogs}>refresh</button>
      </h3>
      <pre className="log">{logs.slice(-80).join('\n') || 'No output yet.'}</pre>
    </section>
  )
}
