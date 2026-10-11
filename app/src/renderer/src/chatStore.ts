import type { AiContentBlock, AiEvent, AiMessage, AiRunRequest } from '../../shared/ai'
import { AGENT_TOOLS, type AgentHost, AgentToolbox } from './agentTools'
import { errorMessage } from './target'

/** A piece of an assistant turn: what it said, or a tool it used. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; summary: string; isError: boolean }

export interface ChatTurn {
  role: 'user' | 'assistant'
  /** User turns: the message. */
  text: string
  /** Assistant turns: text and tool steps in the order they happened. */
  parts: ChatPart[]
  /** Assistant turns: which model answered. */
  provenance?: string
  error?: string | null
  status?: 'running' | 'done' | 'error' | 'cancelled'
  /** User turns: what was attached as context, for the bubble's caption. */
  context?: string
  /** User turns: sent in agent mode. */
  agent?: boolean
}

export interface ChatState {
  turns: ChatTurn[]
  /** A message is being answered (including between an agent's steps). */
  busy: boolean
}

/** An agent stops after this many model steps in one answer, in case it loops. */
const MAX_STEPS = 30

// The conversation lives outside React so it survives switching side-panel drawers, and
// keeps streaming while the AI panel is closed. It lasts until the window reloads.
let state: ChatState = { turns: [], busy: false }
const listeners = new Set<() => void>()
/**
 * The conversation as the model sees it: user messages as rendered from the prompt
 * template, assistant turns with their tool calls and provider-native form, and tool
 * results. Only ever appended to, so each request resends exactly what came before
 * (Claude rejects thinking blocks whose earlier history was edited).
 */
let transcript: AiMessage[] = []

/** Handlers for runs in flight, by id, plus events that arrived before their run's id was known. */
const handlers = new Map<string, (event: AiEvent) => void>()
let early: Map<string, AiEvent[]> | null = null
let subscribed = false
let currentRun: string | null = null
let stopRequested = false
// Bumped by clear(), so work still in flight knows its conversation is gone.
let generation = 0

function set(next: Partial<ChatState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function updateLast(change: (turn: ChatTurn) => ChatTurn) {
  const turns = state.turns.slice()
  turns[turns.length - 1] = change(turns[turns.length - 1])
  set({ turns })
}

function appendText(turn: ChatTurn, text: string): ChatTurn {
  const parts = turn.parts.slice()
  const last = parts.at(-1)
  if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + text }
  else parts.push({ type: 'text', text })
  return { ...turn, parts }
}

function ensureSubscribed() {
  if (subscribed) return
  subscribed = true
  window.ogma.ai.onEvent((runId, event) => {
    const handler = handlers.get(runId)
    if (handler) handler(event)
    else if (early) early.set(runId, [...(early.get(runId) ?? []), event])
  })
}

/** Neutral text of a message, for providers that cannot take tool blocks. */
function textOf(message: AiMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? `[Tool result]\n${block.content}` : ''))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The transcript as plain alternating text, for an ordinary chat run: tool calls and
 * native turns are dropped and same-role neighbours merged.
 */
export function flattenTranscript(messages: readonly AiMessage[]): AiMessage[] {
  const flat: AiMessage[] = []
  for (const message of messages) {
    const text = textOf(message).trim()
    if (!text) continue
    const last = flat.at(-1)
    if (last && last.role === message.role) last.content = `${last.content as string}\n\n${text}`
    else flat.push({ role: message.role, content: text })
  }
  while (flat[0]?.role === 'assistant') flat.shift()
  return flat
}

interface StepResult {
  text: string
  calls: Extract<AiEvent, { type: 'tool_call' }>[]
  native: AiMessage['native']
  stopReason: string | null
  /** Set when the run failed or was cancelled. */
  failure: { kind: string; message: string } | null
}

/** Runs one model step, streaming its text into the last turn, and resolves when it ends. */
async function step(request: AiRunRequest, started: number): Promise<StepResult> {
  ensureSubscribed()
  const result: StepResult = { text: '', calls: [], native: undefined, stopReason: null, failure: null }
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const handle = (event: AiEvent) => {
    if (generation !== started) return
    switch (event.type) {
      case 'start':
        updateLast((turn) => ({
          ...turn,
          provenance: turn.provenance ?? `${event.provider_label} · ${event.model || 'default model'}${event.fallback ? ' · fallback' : ''}`,
        }))
        return
      case 'text':
        result.text += event.text
        updateLast((turn) => appendText(turn, event.text))
        return
      case 'tool_call':
        result.calls.push(event)
        return
      case 'assistant_message':
        result.native = { provider: event.provider, content: event.content }
        return
      case 'done':
        result.stopReason = event.stop_reason
        finish()
        return
      case 'error':
        result.failure = { kind: event.kind, message: event.message }
        finish()
        return
      default:
    }
  }

  const buffer = new Map<string, AiEvent[]>()
  early = buffer
  let id: string
  try {
    id = await window.ogma.ai.run(request)
  } catch (error) {
    if (early === buffer) early = null
    return { ...result, failure: { kind: 'bad_request', message: errorMessage(error) } }
  }
  if (early === buffer) early = null
  handlers.set(id, handle)
  currentRun = id
  if (stopRequested || generation !== started) void window.ogma.ai.cancel(id)
  for (const event of buffer.get(id) ?? []) handle(event)
  await finished
  handlers.delete(id)
  if (currentRun === id) currentRun = null
  return result
}

interface SendOptions {
  profileId?: string
  contextLabel?: string
  /** Let the model use tools (read files, search, suggest edits). */
  agent?: AgentHost | null
}

export const chatStore = {
  subscribe(listener: () => void): () => void {
    ensureSubscribed()
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  snapshot: (): ChatState => state,

  async send(message: string, variables: Record<string, string>, options: SendOptions) {
    if (state.busy) return
    const started = generation
    const task = options.agent ? 'agent' : 'chat'
    stopRequested = false
    set({
      busy: true,
      turns: [
        ...state.turns,
        { role: 'user', text: message, parts: [], context: options.contextLabel, agent: Boolean(options.agent) },
        { role: 'assistant', text: '', parts: [], status: 'running', error: null },
      ],
    })

    const finish = (status: ChatTurn['status'], error: string | null = null) => {
      if (generation !== started) return
      updateLast((turn) => ({ ...turn, status, error }))
      set({ busy: false })
    }

    let rendered: { system: string; messages: AiMessage[] }
    try {
      rendered = await window.ogma.ai.render(task, { ...variables, message })
    } catch (error) {
      finish('error', errorMessage(error))
      return
    }
    if (generation !== started) return
    transcript = [...transcript, ...rendered.messages]

    const toolbox = options.agent ? new AgentToolbox(options.agent, 'Agent') : null
    for (let count = 0; count < MAX_STEPS; count += 1) {
      const history = toolbox ? transcript : flattenTranscript(transcript)
      const result = await step({
        task,
        variables: { ...variables, message },
        history,
        continuation: [],
        tools: toolbox ? AGENT_TOOLS : undefined,
        profileId: options.profileId,
      }, started)
      if (generation !== started) return

      // What the model said this step joins the transcript, even when cut short.
      const blocks: AiContentBlock[] = []
      if (result.text.trim()) blocks.push({ type: 'text', text: result.text })
      const runnable = toolbox && !result.failure && result.stopReason === 'tool_use' ? result.calls : []
      for (const call of runnable) blocks.push({ type: 'tool_call', id: call.id, name: call.name, input: call.input })
      if (blocks.length) {
        transcript = [...transcript, {
          role: 'assistant',
          content: runnable.length ? blocks : result.text,
          ...(result.native && !result.failure ? { native: result.native } : {}),
        }]
      }

      if (result.failure) {
        finish(result.failure.kind === 'cancelled' ? 'cancelled' : 'error', result.failure.kind === 'cancelled' ? null : result.failure.message)
        return
      }
      if (!runnable.length || !toolbox) {
        finish('done')
        return
      }

      // Run every call, then answer them all in one message.
      const results: AiContentBlock[] = []
      for (const call of runnable) {
        const outcome = call.input_error !== undefined
          ? { content: `The arguments were not valid JSON: ${call.input_error}`, isError: true, summary: `${call.name} had bad arguments` }
          : await toolbox.run(call.name, call.input)
        if (generation !== started) return
        results.push({ type: 'tool_result', tool_call_id: call.id, content: outcome.content, is_error: outcome.isError })
        updateLast((turn) => ({ ...turn, parts: [...turn.parts, { type: 'tool', summary: outcome.summary, isError: outcome.isError }] }))
      }
      transcript = [...transcript, { role: 'user', content: results }]
      if (stopRequested) {
        finish('cancelled')
        return
      }
    }
    finish('error', `Stopped after ${MAX_STEPS} steps. Ask it to continue if it was not finished.`)
  },

  cancel() {
    stopRequested = true
    if (currentRun) void window.ogma.ai.cancel(currentRun)
  },

  clear() {
    if (currentRun) void window.ogma.ai.cancel(currentRun)
    generation += 1
    early = null
    currentRun = null
    handlers.clear()
    transcript = []
    set({ turns: [], busy: false })
  },
}
