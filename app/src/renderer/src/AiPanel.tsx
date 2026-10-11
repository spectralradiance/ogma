import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { AiEvent, AiMode, AiSettingsState, AiTask } from '../../shared/ai'
import { PROVIDERS } from '../../shared/ai'
import type { SidecarStatus } from '../../shared/ipc'
import { describeMetrics, measureText, type TextMetrics } from '../../shared/readability'
import type { WordInContext } from './editor/MarkdownEditor'
import { AiServerLine } from './AiServer'
import { chatStore } from './chatStore'
import { readPref, writePref } from './prefs'
import { SynthesisReview } from './SynthesisReview'
import { errorMessage } from './target'
import { Settings } from 'lucide-react'

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
  /** The open double document's outline, for structure analysis. */
  outline: { title: string; sections: number; markdown(): string } | null
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

/** Focused text attached to a chat message, capped to keep prompts reasonable. */
const CHAT_CONTEXT_CHARS = 24_000

type PanelView = 'tools' | 'chat'

interface AiPanelProps {
  workspace: AiWorkspace
  status: SidecarStatus | null
  onOpenSettings: () => void
}

export function AiPanel({ workspace, status, onOpenSettings }: AiPanelProps) {
  const providers = status?.health?.providers ?? []
  const [settings, setSettings] = useState<AiSettingsState | null>(null)
  const [profileId, setProfileId] = useState('')
  const [instruction, setInstruction] = useState<(typeof WORD_INSTRUCTIONS)[number]['id']>('vary')
  const [run, setRun] = useState<RunState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [review, setReview] = useState(false)
  const [view, setViewState] = useState<PanelView>(() => (readPref('aiView') === 'chat' ? 'chat' : 'tools'))
  const log = useRef(new Map<string, AiEvent[]>())
  const current = useRef<string | null>(null)

  const refreshSettings = useCallback(() => window.ogma.ai.settings().then(setSettings), [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  // Events can arrive before run() resolves with the id, so every run's events are kept.
  useEffect(() => window.ogma.ai.onEvent((runId, event) => {
    const events = log.current.get(runId) ?? []
    events.push(event)
    log.current.set(runId, events)
    if (runId === current.current) setRun((state) => (state && state.id === runId ? reduce(state, event) : state))
  }), [])

  const start = async (task: AiTask, variables: Record<string, string>, extra: Partial<RunState>) => {
    setMessage(null)
    setReview(false)
    try {
      const id = await window.ogma.ai.run({ task, variables, profileId: profileId || undefined })
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

  const analyzeStructure = () => {
    const outline = workspace.outline
    if (!outline) {
      setMessage('Open a document of sections to analyze its structure.')
      return
    }
    void start('structure', { document: outline.title, outline: outline.markdown() }, {})
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

  const setView = (next: PanelView) => {
    writePref('aiView', next)
    setViewState(next)
  }

  const setMode = (mode: AiMode) => {
    if (!settings) return
    void window.ogma.ai.saveConfig({ ...settings.config, mode }).then(setSettings)
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

  const serverLine = <AiServerLine status={status} onOpen={onOpenSettings} />
  const modelField = (
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
  )

  return (
    <div className="lexical-panel ai-panel" aria-label="AI">
      <header className="lexical-header ai-header">
        <div className="segmented" role="group" aria-label="AI mode">
          {MODES.map((option) => (
            <button key={option.id} type="button" aria-pressed={mode === option.id} title={option.title} onClick={() => setMode(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button ai-settings-button" onClick={onOpenSettings} title="AI settings: keys, models, routing, prompts" aria-label="AI settings"><Settings size={14} aria-hidden="true" /> Settings</button>
      </header>

      <div className="lexical-tabs" role="tablist" aria-label="AI view">
        {(['tools', 'chat'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
            {id === 'tools' ? 'Tools' : 'Chat'}
          </button>
        ))}
      </div>

      {view === 'chat' ? (
        <AiChat workspace={workspace} profileId={profileId} top={<>{serverLine}{modelField}</>} />
      ) : (
        <div className="lexical-body">
          {serverLine}
          {modelField}
          <p className="lexical-hint">{workspace.focus ? `Working on: ${workspace.focus.label}` : 'Click into a document to work on it.'}</p>

          <div className="ai-actions">
            <button type="button" onClick={() => void draftOutput()} disabled={running || !workspace.focus?.inSection}
              title="Write this section’s output from its notes; you review every change before it is applied">
              Draft output from notes
            </button>
            <button type="button" onClick={analyze} disabled={running} title="Selection, or the whole focused file">
              Analyze
            </button>
            <button type="button" onClick={analyzeStructure} disabled={running || !workspace.outline}
              title="Order, balance and gaps across every section, from the document’s outline, sizes and opening lines">
              Analyze structure
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
                {running && <button type="button" className="link-button" onClick={() => void window.ogma.ai.cancel(run.id)}>Cancel</button>}
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
      )}

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
    </div>
  )
}

function AiChat({ workspace, profileId, top }: { workspace: AiWorkspace; profileId: string; top: ReactNode }) {
  const chat = useSyncExternalStore(chatStore.subscribe, chatStore.snapshot)
  const [draft, setDraft] = useState('')
  const [attach, setAttach] = useState(true)
  const log = useRef<HTMLDivElement>(null)
  const last = chat.turns[chat.turns.length - 1]
  const busy = last?.status === 'running'

  // Follow the reply as it streams in.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [chat.turns])

  const send = () => {
    const message = draft.trim()
    if (!message || busy) return
    const active = workspace.readActive()
    const variables = { document: active?.document ?? '', section: active?.section ? `Section: ${active.section}` : '', context: '' }
    let contextLabel: string | undefined
    if (attach && active) {
      const selected = active.selection.trim()
      const text = selected || active.text
      if (text.trim()) {
        const capped = text.length > CHAT_CONTEXT_CHARS ? `${text.slice(0, CHAT_CONTEXT_CHARS)}\n[…cut for length]` : text
        variables.context = `## ${selected ? 'Selected passage' : 'Focused text'}\n${capped}`
        contextLabel = selected ? 'with the selection' : `with ${workspace.focus?.label ?? 'the focused text'}`
      }
    }
    setDraft('')
    void chatStore.send(message, variables, { profileId: profileId || undefined, contextLabel })
  }

  return (
    <div className="ai-chat">
      <div className="ai-chat-log" ref={log}>
        {top}
        {chat.turns.length === 0 && (
          <p className="lexical-hint">
            Ask about the text you are working on: feedback, ideas, wording. With “Attach focused text” on, each message
            includes the selection, or the whole focused file.
          </p>
        )}
        {chat.turns.map((turn, index) => (
          <div key={index} className={`ai-chat-turn ai-chat-${turn.role}`}>
            {turn.role === 'user' ? (
              <>
                <div className="ai-chat-bubble">{turn.text}</div>
                {turn.context && <span className="ai-chat-meta">{turn.context}</span>}
              </>
            ) : (
              <>
                <span className="ai-chat-meta">
                  {turn.provenance ?? (turn.status === 'running' ? 'Starting…' : '')}
                  {turn.status === 'cancelled' && ' · stopped'}
                </span>
                {turn.text && <div className="ai-text">{turn.text}</div>}
                {turn.status === 'error' && turn.error && <p className="lexical-message status-error">{turn.error}</p>}
              </>
            )}
          </div>
        ))}
      </div>
      <form className="ai-chat-composer" onSubmit={(event) => { event.preventDefault(); send() }}>
        <textarea
          value={draft}
          rows={3}
          placeholder="Message… (Enter to send, Shift+Enter for a new line)"
          aria-label="Chat message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="ai-chat-controls">
          <label className="ai-chat-attach" title="Send the selection, or the whole focused file, with each message">
            <input type="checkbox" checked={attach} onChange={(event) => setAttach(event.target.checked)} />
            Attach focused text
          </label>
          {chat.turns.length > 0 && <button type="button" className="link-button" onClick={() => chatStore.clear()}>New chat</button>}
          {busy
            ? <button type="button" onClick={() => chatStore.cancel()}>Stop</button>
            : <button type="submit" className="primary" disabled={!draft.trim()}>Send</button>}
        </div>
      </form>
    </div>
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
