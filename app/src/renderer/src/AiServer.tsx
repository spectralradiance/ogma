import { useCallback, useEffect, useState } from 'react'

import { describeGpu, describeTorch, formatMegabytes } from '../../shared/format'
import type { SidecarState, SidecarStatus } from '../../shared/ipc'
import { CUDA_INDEXES, suggestCudaIndex } from '../../shared/torch'
import { readPref, writePref } from './prefs'
import { errorMessage } from './target'

export const SERVER_STATE_LABEL: Record<SidecarState, string> = {
  starting: 'AI server starting…',
  online: 'AI server online',
  error: 'AI server offline',
  stopped: 'AI server stopped',
  installing: 'Installing PyTorch…',
}

/** The AI server's state, hardware and local model, with controls to run it and install PyTorch. */
export function AiServer({ status }: { status: SidecarStatus | null }) {
  const [open, setOpen] = useState(() => readPref('aiServerOpen') !== 'false')
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [chosenIndex, setChosenIndex] = useState<string | null>(null)
  const state = status?.state ?? 'starting'
  const health = status?.health
  const installing = state === 'installing'
  const index = chosenIndex ?? suggestCudaIndex(health?.gpu.devices[0]?.driver_version)

  const refreshLogs = useCallback(() => {
    void window.oisin.sidecar.getLogs().then(setLogs)
  }, [])

  // Follow the log while it matters: during an install, or while the details are open.
  useEffect(() => {
    if (!installing && !details) return
    refreshLogs()
    if (!installing) return
    const timer = window.setInterval(refreshLogs, 1500)
    return () => window.clearInterval(timer)
  }, [installing, details, refreshLogs, state])

  const toggle = () => {
    writePref('aiServerOpen', String(!open))
    setOpen(!open)
  }

  const act = (action: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    action().catch((error: unknown) => setMessage(errorMessage(error))).finally(() => setBusy(false))
  }

  const installTorch = () => {
    const question = `Install PyTorch (${index}) into the AI server’s Python environment?\n\n`
      + 'This downloads about 3 GB and stops the AI server until it finishes. The local model needs it; cloud models do not.'
    if (window.confirm(question)) act(() => window.oisin.sidecar.installTorch(index))
  }

  const torch = health?.torch
  const needsTorch = torch !== undefined && torch.state === 'ready' && (!torch.installed || !torch.cuda_available || Boolean(torch.error))
  const hasGpu = (health?.gpu.devices.length ?? 0) > 0
  const loaded = health?.models_loaded ?? []

  return (
    <section className={`ai-server${open ? ' open' : ''}`} aria-label="AI server">
      <div className="ai-server-line">
        <button type="button" className="ai-server-toggle" onClick={toggle} aria-expanded={open} title={open ? 'Hide AI server details' : 'Show AI server details'}>
          <span className={`dot dot-${state}`} aria-hidden="true" />
          <span>{SERVER_STATE_LABEL[state]}</span>
          <span className="ai-server-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {(state === 'stopped' || state === 'error') && (
          <button type="button" onClick={() => act(() => window.oisin.sidecar.restart())} disabled={busy}>Start</button>
        )}
        {(state === 'online' || state === 'starting') && (
          <>
            <button type="button" onClick={() => act(() => window.oisin.sidecar.restart())} disabled={busy} title="Stop and start the AI server (picks up new keys and packages)">
              {busy ? '…' : 'Restart'}
            </button>
            <button type="button" onClick={() => act(() => window.oisin.sidecar.stop())} disabled={busy} title="Stop the AI server; AI features are unavailable until it is started">Stop</button>
          </>
        )}
      </div>

      {open && (
        <div className="ai-server-body">
          {status?.error && <p className="lexical-message status-error">{status.error}</p>}
          {message && <p className="lexical-message status-error">{message}</p>}

          {installing && (
            <>
              <p className="lexical-hint">Downloading and installing PyTorch and the local-model libraries. This can take several minutes.</p>
              <pre className="log ai-server-log">{logs.slice(-12).join('\n') || 'Starting pip…'}</pre>
            </>
          )}

          {health && (
            <dl className="facts ai-server-facts">
              <dt>GPU</dt>
              <dd>{describeGpu(health.gpu)}</dd>
              <dt>PyTorch</dt>
              <dd>
                {describeTorch(health.torch).replace(/^PyTorch:? ?/, '') || 'installed'}
                {torch?.error && <span className="ai-server-note" title={torch.error}> ({torch.error.split('\n')[0]})</span>}
              </dd>
              <dt>Local model</dt>
              <dd>
                {loaded.length > 0 ? (
                  <>
                    {loaded.join(', ')} · in GPU memory{' '}
                    <button type="button" className="link-button" disabled={busy}
                      onClick={() => act(() => window.oisin.ai.unloadLocal())} title="Free the GPU memory now; it reloads on next use">Unload</button>
                  </>
                ) : torch?.installed && torch.cuda_available ? 'not loaded (loads on first use)' : 'unavailable without PyTorch (CUDA)'}
              </dd>
              <dt>Cloud</dt>
              <dd>
                {health.providers.filter((provider) => provider.kind === 'cloud' && provider.configured).map((provider) => provider.label).join(', ')
                  || 'no keys set'}
              </dd>
            </dl>
          )}

          {needsTorch && hasGpu && !installing && (
            <div className="ai-server-install">
              <button type="button" onClick={installTorch} disabled={busy}>
                {torch?.installed ? 'Reinstall PyTorch with CUDA…' : 'Install PyTorch…'}
              </button>
              <select value={index} onChange={(event) => setChosenIndex(event.target.value)} aria-label="CUDA version"
                title="PyTorch build; the default is the newest your graphics driver supports">
                {CUDA_INDEXES.map((option) => <option key={option} value={option}>CUDA {option.slice(2, -1)}.{option.slice(-1)}</option>)}
              </select>
            </div>
          )}

          {!installing && (
            <button type="button" className="link-button ai-server-more" onClick={() => setDetails(!details)} aria-expanded={details}>
              {details ? 'Hide details' : 'More details and log'}
            </button>
          )}
          {details && !installing && (
            <>
              {health && (
                <dl className="facts">
                  <dt>Version</dt>
                  <dd>{health.version} · Python {health.python} · pid {health.pid}</dd>
                  <dt>Environment</dt>
                  <dd title={health.python_prefix}>{health.in_virtualenv ? 'virtual environment' : 'system Python (not a venv)'}</dd>
                  {health.gpu.devices.map((device) => (
                    <div key={device.index} className="fact-row">
                      <dt>GPU {device.index}</dt>
                      <dd>
                        {device.name} · {formatMegabytes(device.memory_used_mb)} used of {formatMegabytes(device.memory_total_mb)} · driver {device.driver_version}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {health && (
                <ul className="providers">
                  {health.providers.map((provider) => (
                    <li key={provider.id}>
                      <span className={`dot ${provider.configured ? 'dot-online' : 'dot-stopped'}`} aria-hidden="true" />
                      <span className="provider-label">{provider.label}</span>
                      <span className="provider-detail">{provider.configured ? 'ready' : provider.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="ai-server-log-head">
                Log <button type="button" className="link-button" onClick={refreshLogs}>refresh</button>
              </div>
              <pre className="log">{logs.slice(-80).join('\n') || 'No output yet.'}</pre>
            </>
          )}
        </div>
      )}
    </section>
  )
}
