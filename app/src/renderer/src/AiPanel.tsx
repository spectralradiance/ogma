import { useCallback, useEffect, useRef, useState } from 'react'

import type { AiEvent, AiMode, AiSettingsState, AiTask } from '../../shared/ai'
import { PROVIDERS } from '../../shared/ai'
import type { ProviderStatus } from '../../shared/ipc'
import { describeMetrics, measureText, type TextMetrics } from '../../shared/readability'
import type { WordInContext } from './editor/MarkdownEditor'
import { SynthesisReview } from './SynthesisReview'
import { errorMessage } from './target'

export interface SectionMaterial {
  document: string
  section: string
  notes: string
  output: string
  documentNotes: string
}

/** What the AI panel can read from and write to, supplied by the app. */
export interface AiWorkspace {
  /** Short description of what is focused, for the panel header. */
  focus: { label: string; inSection: boolean } | null
  readActive(): { text: string; selection: string; document: string; section: string } | null
  readSection(): Promise<SectionMaterial | null>
  currentWord(): WordInContext | null
  applyOutput(text: string): boolean
  replaceWord(word: string): boolean
}

interface RunState {
  id: string
  task: AiTask
  status: 'running' | 'done' | 'error' | 'cancelled'
  text: string
  start: Extract<AiEvent, { type: 'start' }> | null
  notices: string[]
  error: string | null
  usage: { input: number | null; output: number | null } | null
  metrics?: TextMetrics
  material?: SectionMaterial
  word?: string
}

function reduce(state: RunState, event: AiEvent): RunState {
  switch (event.type) {
    case 'start':
      return { ...state, start: event, text: '' }
    case 'text':
      return { ...state, text: state.text + event.text }
    case 'usage':
      return { ...state, usage: { input: event.input_tokens, output: event.output_tokens } }
    case 'done':
      return { ...state, status: 'done' }
    case 'notice':
      return { ...state, notices: [...state.notices, event.message] }
    case 'error':
      return { ...state, status: event.kind === 'cancelled' ? 'cancelled' : 'error', error: event.message }
  }
}

/** Parses "word — note" lines from a word-choice run. */
export function parseSuggestions(text: string): { word: string; note: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, ''))
    .filter(Boolean)
    .map((line) => {
      const match = /^(.+?)\s+[—–-]\s+(.*)$/.exec(line) ?? /^(.+?):\s+(.*)$/.exec(line)
      return match ? { word: match[1].replace(/\*+/g, '').trim(), note: match[2].trim() } : { word: line.replace(/\*+/g, ''), note: '' }
    })
    .filter((suggestion) => suggestion.word.length > 0 && suggestion.word.length < 40)
}

const WORD_INSTRUCTIONS = [
  { id: 'vary', label: 'Alternatives', text: 'Offer varied alternatives that keep the meaning.' },
  { id: 'stronger', label: 'Stronger / more precise', text: 'Prefer stronger, more precise and concrete words than the original.' },
  { id: 'theme', label: 'Fits the theme', text: 'Prefer words that suit the theme and imagery of the paragraph.' },
] as const

const MODES: { id: AiMode; label: string; title: string }[] = [
  { id: 'local', label: 'Local', title: 'Only the model on this computer; nothing leaves the machine' },
  { id: 'hybrid', label: 'Hybrid', title: 'Each task uses its routing order (Settings → Routing)' },
  { id: 'cloud', label: 'Cloud', title: 'Only cloud providers' },
]

interface AiPanelProps {
  workspace: AiWorkspace
  providers: ProviderStatus[]
  onOpenSettings: () => void
  onClose: () => void
}

export function AiPanel({ workspace, providers, onOpenSettings, onClose }: AiPanelProps) {
  const [settings, setSettings] = useState<AiSettingsState | null>(null)
  const [profileId, setProfileId] = useState('')
  const [instruction, setInstruction] = useState<(typeof WORD_INSTRUCTIONS)[number]['id']>('vary')
  const [run, setRun] = useState<RunState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [review, setReview] = useState(false)
  const log = useRef(new Map<string, AiEvent[]>())
  const current = useRef<string | null>(null)

  const refreshSettings = useCallback(() => window.oisin.ai.settings().then(setSettings), [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  // Events can arrive before run() resolves with the id, so every run's events are kept.
  useEffect(() => window.oisin.ai.onEvent((runId, event) => {
    const events = log.current.get(runId) ?? []
    events.push(event)
    log.current.set(runId, events)
    if (runId === current.current) setRun((state) => (state && state.id === runId ? reduce(state, event) : state))
  }), [])

  const start = async (task: AiTask, variables: Record<string, string>, extra: Partial<RunState>) => {
    setMessage(null)
    setReview(false)
    try {
      const id = await window.oisin.ai.run({ task, variables, profileId: profileId || undefined })
      current.current = id
      const initial: RunState = { id, task, status: 'running', text: '', start: null, notices: [], error: null, usage: null, ...extra }
      setRun((log.current.get(id) ?? []).reduce(reduce, initial))
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const draftOutput = async () => {
    const material = await workspace.readSection()
    if (!material) {
      setMessage('Click into a section’s notes or output first.')
      return
    }
    if (!material.notes.trim()) {
      setMessage('This section’s notes are empty, so there is nothing to draft from.')
      return
    }
    void start('synthesize', { ...material }, { material })
  }

  const analyze = () => {
    const active = workspace.readActive()
    if (!active) {
      setMessage('Click into a document first.')
      return
    }
    const text = active.selection.trim() || active.text
    if (!text.trim()) {
      setMessage('There is no text to analyze.')
      return
    }
    const metrics = measureText(text)
    void start('analyze', {
      document: active.document,
      section: active.section ? `Section: ${active.section}` : '',
      text,
      metrics: describeMetrics(metrics),
    }, { metrics })
  }

  const suggestWords = () => {
    const found = workspace.currentWord()
    if (!found) {
      setMessage('Put the cursor on a word (or select one) first.')
      return
    }
    const chosen = WORD_INSTRUCTIONS.find((option) => option.id === instruction) ?? WORD_INSTRUCTIONS[0]
    void start('lexical', { word: found.word, sentence: found.context, paragraph: found.context, instruction: chosen.text }, { word: found.word })
  }

  const setMode = (mode: AiMode) => {
    if (!settings) return
    void window.oisin.ai.saveConfig({ ...settings.config, mode }).then(setSettings)
  }

  const configured = (providerId: string) => providers.find((provider) => provider.id === providerId)?.configured ?? false
  const mode = settings?.config.mode ?? 'hybrid'
  const profiles = (settings?.config.profiles ?? []).filter((profile) => {
    const kind = PROVIDERS.find((provider) => provider.id === profile.provider)?.kind
    return mode === 'hybrid' || (mode === 'local' ? kind === 'local' : kind === 'cloud')
  })
  const running = run?.status === 'running'
  const provenance = run?.start
    ? `${run.start.provider_label} · ${run.start.model || 'default model'}${run.start.fallback ? ' · fallback' : ''}`
    : ''

  return (
    <aside className="lexical-panel ai-panel" aria-label="AI">
      <header className="lexical-header ai-header">
        <strong>AI</strong>
        <div className="segmented" role="group" aria-label="AI mode">
          {MODES.map((option) => (
            <button key={option.id} type="button" aria-pressed={mode === option.id} title={option.title} onClick={() => setMode(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" onClick={onOpenSettings} title="AI settings: keys, models, routing, prompts" aria-label="AI settings">⚙</button>
        <button type="button" className="icon-button" onClick={onClose} title="Close" aria-label="Close">×</button>
      </header>

      <div className="lexical-body">
        <label className="ai-field">
          Model
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">Automatic (routing order)</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}{configured(profile.provider) ? '' : ' — not set up'}
              </option>
            ))}
          </select>
        </label>
        <p className="lexical-hint">{workspace.focus ? `Working on: ${workspace.focus.label}` : 'Click into a document to work on it.'}</p>

        <div className="ai-actions">
          <button type="button" onClick={() => void draftOutput()} disabled={running || !workspace.focus?.inSection}
            title="Write this section’s output from its notes; you review every change before it is applied">
            Draft output from notes
          </button>
          <button type="button" onClick={analyze} disabled={running} title="Selection, or the whole focused file">
            Analyze
          </button>
          <div className="ai-word-row">
            <button type="button" onClick={suggestWords} disabled={running} title="For the word at the cursor">Word choice</button>
            <select value={instruction} onChange={(event) => setInstruction(event.target.value as typeof instruction)} aria-label="Kind of suggestions">
              {WORD_INSTRUCTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        </div>

        {message && <p className="lexical-message">{message}</p>}

        {run && (
          <section className="ai-result">
            <div className="ai-provenance">
              {run.start ? provenance : running ? 'Starting…' : ''}
              {running && <button type="button" className="link-button" onClick={() => void window.oisin.ai.cancel(run.id)}>Cancel</button>}
            </div>
            {run.start && run.start.skipped.length > 0 && (
              <p className="lexical-hint" title={run.start.skipped.join('\n')}>Skipped: {run.start.skipped.map((entry) => entry.split(':')[0]).join(', ')}</p>
            )}
            {run.notices.map((notice, index) => <p key={index} className="lexical-hint">{notice}</p>)}

            {run.task === 'analyze' && run.metrics && <MetricsTable metrics={run.metrics} />}

            {run.task === 'lexical' ? (
              <div className="chips ai-suggestions">
                {parseSuggestions(run.text).map((suggestion) => (
                  <span key={suggestion.word} className="chip" title={suggestion.note}>
                    <button type="button" onClick={() => setMessage(suggestion.note || suggestion.word)}>{suggestion.word}</button>
                    <button type="button" className="chip-replace" title={`Replace “${run.word}” with “${suggestion.word}”`}
                      onClick={() => setMessage(workspace.replaceWord(suggestion.word) ? null : 'Put the cursor back on the word to replace it.')}>↵</button>
                  </span>
                ))}
              </div>
            ) : (
              run.text && <div className="ai-text">{run.text}</div>
            )}

            {run.task === 'synthesize' && run.status === 'done' && run.material && run.text.trim() && (
              <button type="button" className="primary" onClick={() => setReview(true)}>Review changes…</button>
            )}
            {run.error && <p className="lexical-message status-error">{run.error}</p>}
            {run.usage && (run.usage.input !== null || run.usage.output !== null) && (
              <p className="lexical-hint">{run.usage.input ?? '?'} tokens in · {run.usage.output ?? '?'} out</p>
            )}
          </section>
        )}
      </div>

      {review && run?.material && (
        <SynthesisReview
          title={run.material.section}
          before={run.material.output}
          after={run.text.trim() + '\n'}
          provenance={provenance}
          onClose={() => setReview(false)}
          onApply={(text) => {
            setReview(false)
            setMessage(workspace.applyOutput(text)
              ? 'Applied to the output. It saves automatically; Ctrl+Z in the output undoes it.'
              : 'The output editor is no longer open, so nothing was applied.')
          }}
        />
      )}
    </aside>
  )
}

function MetricsTable({ metrics }: { metrics: TextMetrics }) {
  const rows: [string, string][] = [
    ['Words / sentences', `${metrics.words} / ${metrics.sentences}`],
    ['Average sentence', `${metrics.averageSentenceWords} words (spread ${metrics.sentenceSpread})`],
    ['Long sentences', String(metrics.longSentences)],
    ['Reading ease', `${metrics.readingEase} (grade ${metrics.gradeLevel})`],
  ]
  if (metrics.repeated.length) rows.push(['Repeated', metrics.repeated.map((item) => `${item.word} ×${item.count}`).join(', ')])
  return (
    <dl className="facts ai-metrics">
      {rows.map(([label, value]) => (
        <div key={label} className="fact-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
