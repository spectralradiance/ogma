// AI configuration and run contracts shared by the main process and renderer.

export type AiMode = 'local' | 'cloud' | 'hybrid'
export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai_compat' | 'local_hf'
export type AiTask = 'analyze' | 'synthesize' | 'lexical' | 'structure'

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
    default: ['claude', 'local-qwen'],
  },
}

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What a feature asks for; the main process renders the prompt template and adds routing. */
export interface AiRunRequest {
  task: AiTask | 'test'
  /** Values for the task's prompt template placeholders. */
  variables: Record<string, string>
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
