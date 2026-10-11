import { useCallback, useEffect, useState } from 'react'

import { describeGpu, describeTorch, formatMegabytes } from '../../shared/format'
import type { SidecarState, SidecarStatus } from '../../shared/ipc'
import { CUDA_INDEXES, suggestCudaIndex } from '../../shared/torch'
import { errorMessage } from './target'

export const SERVER_STATE_LABEL: Record<SidecarState, string> = {
  starting: 'AI server starting…',
  online: 'AI server online',
  error: 'AI server offline',
  stopped: 'AI server stopped',
  installing: 'Installing PyTorch…',
}

/** One line for the AI panel: the server's state, and a way to its settings tab. */
export function AiServerLine({ status, onOpen }: { status: SidecarStatus | null; onOpen: () => void }) {
  const state = status?.state ?? 'starting'
  const torch = status?.health?.torch
  const note = state !== 'online'
    ? status?.error ?? ''
    : torch?.state === 'pending' ? 'checking PyTorch…'
      : torch?.installed && torch.cuda_available ? 'local model available' : 'cloud only (no PyTorch)'
  return (
    <button type="button" className="ai-server-line" onClick={onOpen} title="AI server, GPU and PyTorch settings">
      <span className={`dot dot-${state}`} aria-hidden="true" />
      <span>{SERVER_STATE_LABEL[state]}</span>
      {note && <span className="ai-server-note">· {note}</span>}
    </button>
  )
}

/** The AI settings' Server tab: state, hardware and local model, with controls to run it and install PyTorch. */
export function AiServerSettings({ status }: { status: SidecarStatus | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [chosenIndex, setChosenIndex] = useState<string | null>(null)
  const state = status?.state ?? 'starting'
  const health = status?.health
  const installing = state === 'installing'
  const index = chosenIndex ?? suggestCudaIndex(health?.gpu.devices[0]?.driver_version)

  const refreshLogs = useCallback(() => {
    void window.ogma.sidecar.getLogs().then(setLogs)
  }, [])

  // Refresh on every state change, and follow the log while installing.
  useEffect(() => {
    refreshLogs()
    if (!installing) return
    const timer = window.setInterval(refreshLogs, 1500)
    return () => window.clearInterval(timer)
  }, [installing, refreshLogs, status])

  const act = (action: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    action().catch((error: unknown) => setMessage(errorMessage(error))).finally(() => setBusy(false))
  }

  const installTorch = () => {
    const question = `Install PyTorch (${index}) into the AI server’s Python environment?\n\n`
      + 'This downloads about 3 GB and stops the AI server until it finishes. The local model needs it; cloud models do not.'
    if (window.confirm(question)) act(() => window.ogma.sidecar.installTorch(index))
  }

  const torch = health?.torch
  const needsTorch = torch !== undefined && torch.state === 'ready' && (!torch.installed || !torch.cuda_available || Boolean(torch.error))
  const hasGpu = (health?.gpu.devices.length ?? 0) > 0
  const loaded = health?.models_loaded ?? []

  return (
    <div className="settings-section ai-server">
      <div className="ai-server-head">
        <span className={`dot dot-${state}`} aria-hidden="true" />
        <strong>{SERVER_STATE_LABEL[state]}</strong>
        <span className="ai-server-actions">
          {(state === 'stopped' || state === 'error') && (
            <button type="button" onClick={() => act(() => window.ogma.sidecar.restart())} disabled={busy}>Start</button>
          )}
          {(state === 'online' || state === 'starting') && (
            <>
              <button type="button" onClick={() => act(() => window.ogma.sidecar.restart())} disabled={busy}
                title="Stop and start the AI server (picks up new keys and packages)">Restart</button>
              <button type="button" onClick={() => act(() => window.ogma.sidecar.stop())} disabled={busy}
                title="Stop the AI server; AI features are unavailable until it is started">Stop</button>
            </>
          )}
        </span>
      </div>
      {status?.error && <p className="lexical-message status-error">{status.error}</p>}
      {message && <p className="lexical-message status-error">{message}</p>}

      {installing && (
        <p className="lexical-hint">Downloading and installing PyTorch and the local-model libraries. This can take several minutes.</p>
      )}

      {health && (
        <dl className="facts">
          <dt>GPU</dt>
          <dd>
            {describeGpu(health.gpu)}
            {health.gpu.devices[0] && <span className="ai-server-muted"> · {formatMegabytes(health.gpu.devices[0].memory_used_mb)} used · driver {health.gpu.devices[0].driver_version}</span>}
          </dd>
          <dt>PyTorch</dt>
          <dd>
            {describeTorch(health.torch).replace(/^PyTorch:? ?/, '') || 'installed'}
            {torch?.error && <span className="status-error" title={torch.error}> ({torch.error.split('\n')[0]})</span>}
            {needsTorch && hasGpu && !installing && (
              <span className="ai-server-install">
                <button type="button" onClick={installTorch} disabled={busy}>
                  {torch?.installed ? 'Reinstall with CUDA…' : 'Install PyTorch…'}
                </button>
                <select value={index} onChange={(event) => setChosenIndex(event.target.value)} aria-label="CUDA version"
                  title="PyTorch build; the default is the newest your graphics driver supports">
                  {CUDA_INDEXES.map((option) => <option key={option} value={option}>CUDA {option.slice(2, -1)}.{option.slice(-1)}</option>)}
                </select>
              </span>
            )}
          </dd>
          <dt>Local model</dt>
          <dd>
            {loaded.length > 0 ? (
              <>
                {loaded.join(', ')} · in GPU memory{' '}
                <button type="button" className="link-button" disabled={busy}
                  onClick={() => act(() => window.ogma.ai.unloadLocal())} title="Free the GPU memory now; it reloads on next use">Unload</button>
              </>
            ) : torch?.installed && torch.cuda_available ? 'none loaded (loads on first use, unloads when idle)' : 'unavailable without PyTorch (CUDA)'}
          </dd>
          <dt>Server</dt>
          <dd>
            {health.version} · Python {health.python} · {health.in_virtualenv ? 'virtual environment' : 'system Python (not a venv)'} · pid {health.pid}
          </dd>
        </dl>
      )}

      {health && (
        <>
          <h3 className="settings-subhead">Providers</h3>
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

      <h3 className="settings-subhead">
        Log <button type="button" className="link-button" onClick={refreshLogs}>refresh</button>
      </h3>
      <pre className="log">{logs.slice(-80).join('\n') || 'No output yet.'}</pre>
    </div>
  )
}
