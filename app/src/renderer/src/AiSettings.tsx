import { useEffect, useRef, useState } from 'react'

import {
  AI_TASKS, type AiConfig, type AiEvent, type AiProfile, type AiProviderId, type AiSettingsState, type AiTask, PROVIDERS, type SecretName,
} from '../../shared/ai'
import type { ProviderStatus, SidecarStatus } from '../../shared/ipc'
import { AiServerSettings } from './AiServer'
import { errorMessage } from './target'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Modal } from './Modal'

type Tab = 'server' | 'keys' | 'profiles' | 'routing' | 'prompts'

const KEY_LABELS: Record<SecretName, string> = {
  ANTHROPIC_API_KEY: 'Anthropic (Claude)',
  OPENAI_API_KEY: 'OpenAI',
  GEMINI_API_KEY: 'Google Gemini',
  OGMA_COMPAT_API_KEY: 'OpenAI-compatible host (optional)',
}

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

interface AiSettingsProps {
  status: SidecarStatus | null
  onClose: () => void
}

export function AiSettings({ status, onClose }: AiSettingsProps) {
  const providers = status?.health?.providers ?? []
  const [tab, setTab] = useState<Tab>('server')
  const [state, setState] = useState<AiSettingsState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.ogma.ai.settings().then(setState)
  }, [])

  const guard = (promise: Promise<AiSettingsState>) => {
    setError(null)
    promise.then(setState, (reason: unknown) => setError(errorMessage(reason)))
  }
  const saveConfig = (config: AiConfig) => guard(window.ogma.ai.saveConfig(config))

  return (
    <Modal label="AI settings" className="settings" onClose={onClose}>
      <header className="modal-header">
        <h2>AI settings</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <nav className="lexical-tabs" role="tablist">
        {(['server', 'keys', 'profiles', 'routing', 'prompts'] as Tab[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {{ server: 'Server', keys: 'Keys', profiles: 'Models', routing: 'Routing', prompts: 'Prompts' }[id]}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {error && <p className="lexical-message status-error">{error}</p>}
        {tab === 'server' && <AiServerSettings status={status} />}
        {!state && tab !== 'server' && <p className="lexical-message">Loading…</p>}
        {state && tab === 'keys' && <KeysTab state={state} onChange={guard} />}
        {state && tab === 'profiles' && <ProfilesTab config={state.config} providers={providers} onSave={saveConfig} />}
        {state && tab === 'routing' && <RoutingTab config={state.config} onSave={saveConfig} />}
        {state && tab === 'prompts' && (
          <div className="settings-section">
            <p>Each AI task uses an editable Markdown template: the system prompt, a line <code>=== user ===</code>, then the message, with <code>{'{{placeholders}}'}</code> filled in. Delete a file to restore its default.</p>
            <p className="lexical-hint">{state.promptsDir}</p>
            <button type="button" onClick={() => void window.ogma.ai.openPrompts()}>Open prompts folder</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

function KeysTab({ state, onChange }: { state: AiSettingsState; onChange: (promise: Promise<AiSettingsState>) => void }) {
  const [drafts, setDrafts] = useState<Partial<Record<SecretName, string>>>({})
  const [baseUrl, setBaseUrl] = useState(state.compatBaseUrl)
  return (
    <div className="settings-section">
      {!state.encryptionAvailable && (
        <p className="lexical-message status-error">This system cannot encrypt secrets, so keys cannot be stored.</p>
      )}
      <p className="lexical-hint">Keys are encrypted with Windows (DPAPI) and only passed to the AI server on this computer. Saving restarts the AI server.</p>
      {state.keys.map((key) => (
        <div key={key.name} className="settings-row">
          <span className="settings-label">{KEY_LABELS[key.name]}</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={key.set ? 'Saved — type to replace' : 'Paste API key'}
            value={drafts[key.name] ?? ''}
            onChange={(event) => setDrafts((current) => ({ ...current, [key.name]: event.target.value }))}
          />
          <button type="button" disabled={!drafts[key.name]?.trim()} onClick={() => {
            onChange(window.ogma.ai.setKey(key.name, drafts[key.name] ?? ''))
            setDrafts((current) => ({ ...current, [key.name]: '' }))
          }}>Save</button>
          <button type="button" disabled={!key.set} onClick={() => onChange(window.ogma.ai.setKey(key.name, null))}>Clear</button>
          <span className={`dot ${key.set ? 'dot-online' : 'dot-stopped'}`} title={key.set ? 'Saved' : 'Not set'} />
        </div>
      ))}
      <div className="settings-row">
        <span className="settings-label">OpenAI-compatible base URL</span>
        <input value={baseUrl} placeholder="https://host.example/v1 or http://localhost:1234/v1" onChange={(event) => setBaseUrl(event.target.value)} />
        <button type="button" disabled={baseUrl === state.compatBaseUrl} onClick={() => onChange(window.ogma.ai.setCompatBaseUrl(baseUrl))}>Save</button>
      </div>
    </div>
  )
}

function ProfilesTab({ config, providers, onSave }: { config: AiConfig; providers: ProviderStatus[]; onSave: (config: AiConfig) => void }) {
  const update = (index: number, patch: Partial<AiProfile>) => {
    onSave({ ...config, profiles: config.profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile)) })
  }
  const add = () => {
    const id = `profile-${Date.now().toString(36)}`
    onSave({ ...config, profiles: [...config.profiles, { id, label: 'New model', provider: 'anthropic', model: '', params: {} }] })
  }
  const remove = (id: string) => {
    const routing = Object.fromEntries(Object.entries(config.routing).map(([task, ids]) => [task, ids.filter((item) => item !== id)])) as AiConfig['routing']
    onSave({ ...config, profiles: config.profiles.filter((profile) => profile.id !== id), routing })
  }
  const status = (provider: AiProviderId) => providers.find((item) => item.id === provider)

  return (
    <div className="settings-section">
      <p className="lexical-hint">A model profile is a provider plus a model id. Features never name a vendor; routing picks profiles per task.</p>
      <table className="settings-table">
        <thead>
          <tr><th>Name</th><th>Provider</th><th>Model id</th><th>Effort</th><th /></tr>
        </thead>
        <tbody>
          {config.profiles.map((profile, index) => {
            const health = status(profile.provider)
            return (
              <tr key={profile.id}>
                <td><DeferredInput value={profile.label} onCommit={(label) => update(index, { label })} /></td>
                <td>
                  <select value={profile.provider} onChange={(event) => update(index, { provider: event.target.value as AiProviderId })}>
                    {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                  </select>
                  {health && !health.configured && <div className="lexical-hint">{health.detail}</div>}
                </td>
                <td><DeferredInput value={profile.model} placeholder="required" onCommit={(model) => update(index, { model })} /></td>
                <td>
                  {profile.provider === 'anthropic' ? (
                    <select value={profile.params.effort ?? ''} onChange={(event) => update(index, { params: { ...profile.params, effort: event.target.value || undefined } })}>
                      {EFFORTS.map((effort) => <option key={effort} value={effort}>{effort || 'default'}</option>)}
                    </select>
                  ) : '—'}
                </td>
                <td className="settings-cell-actions">
                  <TestButton profileId={profile.id} />
                  <button type="button" className="icon-button" title="Remove profile" onClick={() => remove(profile.id)}><X size={14} aria-hidden="true" /></button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button type="button" onClick={add}>Add model</button>
    </div>
  )
}

/** A text input that saves on blur or Enter rather than on every keystroke. */
function DeferredInput({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value)
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(value)
  }
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim())
  }
  return (
    <input value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
  )
}

function TestButton({ profileId }: { profileId: string }) {
  const [result, setResult] = useState<string | null>(null)
  const runId = useRef<string | null>(null)
  const text = useRef('')

  useEffect(() => window.ogma.ai.onEvent((id, event: AiEvent) => {
    if (id !== runId.current) return
    if (event.type === 'text') text.current += event.text
    if (event.type === 'start') text.current = `${event.provider_label} · ${event.model}: `
    if (event.type === 'done') setResult(`✓ ${text.current.trim().slice(0, 60) || 'replied'}`)
    if (event.type === 'error') setResult(`✗ ${event.message}`)
  }), [])

  const test = () => {
    setResult('…')
    text.current = ''
    window.ogma.ai.run({ task: 'test', variables: {}, profileId, profileOnly: true, mode: 'hybrid', maxTokens: 16 }).then(
      (id) => { runId.current = id },
      (reason: unknown) => setResult(`✗ ${errorMessage(reason)}`),
    )
  }
  return (
    <span className="test-button">
      <button type="button" onClick={test}>Test</button>
      {result && <span className="lexical-hint" title={result}>{result}</span>}
    </span>
  )
}

function RoutingTab({ config, onSave }: { config: AiConfig; onSave: (config: AiConfig) => void }) {
  const byId = new Map(config.profiles.map((profile) => [profile.id, profile]))
  const tasks: { id: AiTask | 'default'; label: string; description: string }[] = [
    ...AI_TASKS,
    { id: 'default', label: 'Other', description: 'Anything without its own order, and connection tests' },
  ]
  const setOrder = (task: AiTask | 'default', ids: string[]) => onSave({ ...config, routing: { ...config.routing, [task]: ids } })

  return (
    <div className="settings-section">
      <p className="lexical-hint">
        Each task tries these models in order, skipping any that are not set up and falling back when one fails before writing anything.
        The mode filters the list: Local keeps only local models, Cloud only cloud ones. Current mode: <strong>{config.mode}</strong>.
      </p>
      {tasks.map((task) => {
        const order = config.routing[task.id] ?? []
        const unused = config.profiles.filter((profile) => !order.includes(profile.id))
        return (
          <div key={task.id} className="routing-task">
            <h3>{task.label} <span className="lexical-hint">{task.description}</span></h3>
            <ol className="routing-list">
              {order.map((id, index) => (
                <li key={id}>
                  <span>{byId.get(id)?.label ?? id}</span>
                  <button type="button" className="icon-button" disabled={index === 0} title="Earlier"
                    onClick={() => setOrder(task.id, swap(order, index, index - 1))}><ArrowUp size={14} aria-hidden="true" /></button>
                  <button type="button" className="icon-button" disabled={index === order.length - 1} title="Later"
                    onClick={() => setOrder(task.id, swap(order, index, index + 1))}><ArrowDown size={14} aria-hidden="true" /></button>
                  <button type="button" className="icon-button" title="Remove from this task"
                    onClick={() => setOrder(task.id, order.filter((item) => item !== id))}><X size={14} aria-hidden="true" /></button>
                </li>
              ))}
            </ol>
            {unused.length > 0 && (
              <select value="" onChange={(event) => event.target.value && setOrder(task.id, [...order, event.target.value])}>
                <option value="">Add a model…</option>
                {unused.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            )}
          </div>
        )
      })}
    </div>
  )
}

function swap(list: string[], from: number, to: number): string[] {
  const next = [...list]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}
