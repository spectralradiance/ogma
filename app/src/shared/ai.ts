// AI configuration and run contracts shared by the main process and renderer.

export type AiMode = 'local' | 'cloud' | 'hybrid'
export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai_compat' | 'local_hf'
export type AiTask = 'analyze' | 'synthesize' | 'lexical' | 'structure' | 'chat' | 'agent'

export interface AiProfile {
  id: string
  label: string
  provider: AiProviderId
  /** Model id as the provider names it; empty until the user fills it in. */
  model: string
  params: {
    /** Claude: low | medium | high | xhigh | max. */
    effort?: string
    /** Local: '4bit' (default) or 'fp16'. */
    quant?: string
  }
}

export interface AiConfig {
  mode: AiMode
  profiles: AiProfile[]
  /** Ordered profile ids per task; the router tries them in order. */
  routing: Record<AiTask | 'default', string[]>
}

export const AI_TASKS: { id: AiTask; label: string; description: string }[] = [
  { id: 'synthesize', label: 'Draft output', description: 'Turn a section’s notes into finished output' },
  { id: 'analyze', label: 'Analyze', description: 'Tone, structure, readability and style' },
  { id: 'lexical', label: 'Word choice', description: 'Alternatives for a word in context' },
  { id: 'structure', label: 'Structure', description: 'Order, balance and gaps across the whole document’s outline' },
  { id: 'chat', label: 'Chat', description: 'A conversation about the focused text' },
  { id: 'agent', label: 'Agent', description: 'Chat that reads your files and suggests edits (needs Claude or an OpenAI-style model)' },
]

export const PROVIDERS: { id: AiProviderId; label: string; kind: 'cloud' | 'local'; keyName: string | null }[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'cloud', keyName: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', kind: 'cloud', keyName: 'OPENAI_API_KEY' },
  { id: 'gemini', label: 'Google Gemini', kind: 'cloud', keyName: 'GEMINI_API_KEY' },
  { id: 'openai_compat', label: 'OpenAI-compatible host', kind: 'cloud', keyName: 'OGMA_COMPAT_API_KEY' },
  { id: 'local_hf', label: 'Local model (GPU)', kind: 'local', keyName: null },
]

/** Secrets the app stores (encrypted) and passes to the sidecar as environment variables. */
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OGMA_COMPAT_API_KEY'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export const DEFAULT_AI_CONFIG: AiConfig = {
  mode: 'hybrid',
  profiles: [
    { id: 'claude', label: 'Claude Opus 5', provider: 'anthropic', model: 'claude-opus-5', params: {} },
    { id: 'local-qwen', label: 'Qwen 2.5 7B (local)', provider: 'local_hf', model: 'Qwen/Qwen2.5-7B-Instruct', params: { quant: '4bit' } },
    { id: 'openai', label: 'OpenAI', provider: 'openai', model: '', params: {} },
    { id: 'gemini', label: 'Gemini', provider: 'gemini', model: '', params: {} },
    { id: 'open-host', label: 'Open model host', provider: 'openai_compat', model: '', params: {} },
  ],
  routing: {
    synthesize: ['claude', 'gemini', 'openai', 'open-host', 'local-qwen'],
    analyze: ['local-qwen', 'claude', 'gemini', 'openai', 'open-host'],
    lexical: ['local-qwen', 'claude', 'gemini', 'openai', 'open-host'],
    structure: ['claude', 'gemini', 'openai', 'open-host', 'local-qwen'],
    chat: ['claude', 'gemini', 'openai', 'open-host', 'local-qwen'],
    agent: ['claude', 'openai', 'open-host'],
    default: ['claude', 'local-qwen'],
  },
}

/** Neutral content blocks: the sidecar translates them for each provider (sidecar/ogma_ai/ai_types.py). */
export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_call_id: string; content: string; is_error?: boolean }

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string | AiContentBlock[]
  /** The turn in the provider's own format, sent back to that provider unchanged (keeps Claude's thinking blocks). */
  native?: { provider: string; content: unknown[] }
}

export interface AiToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool's input. */
  input_schema: Record<string, unknown>
}

/** What a feature asks for; the main process renders the prompt template and adds routing. */
export interface AiRunRequest {
  task: AiTask | 'test'
  /** Values for the task's prompt template placeholders. */
  variables: Record<string, string>
  /** Earlier turns of a conversation, sent before the rendered user message (chat). */
  history?: AiMessage[]
  /**
   * Messages to send after the history instead of the rendered user message: an agent
   * continuing after tool calls. The template still supplies the system prompt.
   */
  continuation?: AiMessage[]
  /** Tools the model may call; the app runs them and starts the next run with the results. */
  tools?: AiToolSpec[]
  profileId?: string
  /** Use only profileId, never fall back to another model (connection tests). */
  profileOnly?: boolean
  mode?: AiMode
  maxTokens?: number
  /** File the run is about, recorded in the history. */
  source?: string | null
}

export type AiEvent =
  | { type: 'start'; profile: string; provider: string; provider_label: string; model: string; fallback: boolean; skipped: string[] }
  | { type: 'text'; text: string }
  | { type: 'usage'; input_tokens: number | null; output_tokens: number | null }
  | { type: 'done'; stop_reason: string | null }
  | { type: 'notice'; message: string }
  /** The model wants a tool run. input_error holds arguments that were not valid JSON. */
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; input_error?: string }
  /** The finished turn in the provider's own format, for AiMessage.native. */
  | { type: 'assistant_message'; provider: string; content: unknown[] }
  | { type: 'error'; kind: string; message: string; partial?: boolean }

export interface AiKeyStatus {
  name: SecretName
  set: boolean
}

export interface AiSettingsState {
  config: AiConfig
  keys: AiKeyStatus[]
  compatBaseUrl: string
  encryptionAvailable: boolean
  promptsDir: string
}

/** Fills in missing pieces of a stored config (new tasks, removed profiles) from the defaults. */
export function normalizeAiConfig(raw: unknown): AiConfig {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<AiConfig>
  const mode: AiMode = value.mode === 'local' || value.mode === 'cloud' || value.mode === 'hybrid' ? value.mode : DEFAULT_AI_CONFIG.mode
  const profiles = Array.isArray(value.profiles) && value.profiles.length > 0
    ? value.profiles.filter((profile) => profile && typeof profile.id === 'string' && PROVIDERS.some((p) => p.id === profile.provider))
      .map((profile) => ({ ...profile, label: profile.label || profile.id, model: profile.model ?? '', params: profile.params ?? {} }))
    : DEFAULT_AI_CONFIG.profiles
  const ids = new Set(profiles.map((profile) => profile.id))
  const routing = { ...DEFAULT_AI_CONFIG.routing }
  for (const task of Object.keys(routing) as (keyof AiConfig['routing'])[]) {
    const stored = value.routing?.[task]
    const list = Array.isArray(stored) ? stored : DEFAULT_AI_CONFIG.routing[task]
    routing[task] = list.filter((id) => ids.has(id))
  }
  return { mode, profiles, routing }
}
