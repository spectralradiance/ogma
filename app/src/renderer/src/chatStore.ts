import type { AiEvent, AiMessage } from '../../shared/ai'
import { errorMessage } from './target'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** Assistant turns: which model answered, or why it failed. */
  provenance?: string
  error?: string | null
  status?: 'running' | 'done' | 'error' | 'cancelled'
  /** User turns: what was attached as context, for the bubble's caption. */
  context?: string
}

export interface ChatState {
  turns: ChatTurn[]
  runId: string | null
}

/** Earlier turns sent with each message; older ones are dropped to keep prompts reasonable. */
const HISTORY_TURNS = 30

// The conversation lives outside React so it survives switching side-panel drawers, and
// keeps streaming while the AI panel is closed. It lasts until the window reloads.
let state: ChatState = { turns: [], runId: null }
const listeners = new Set<() => void>()
// Events that arrive while run() has not yet returned its id, by run id.
let early: Map<string, AiEvent[]> | null = null
let subscribed = false
// Bumped by clear(), so a send that was still starting knows its conversation is gone.
let generation = 0

function set(next: ChatState) {
  state = next
  for (const listener of listeners) listener()
}

function updateLast(change: (turn: ChatTurn) => ChatTurn) {
  const turns = state.turns.slice()
  turns[turns.length - 1] = change(turns[turns.length - 1])
  set({ ...state, turns })
}

function apply(event: AiEvent) {
  switch (event.type) {
    case 'start':
      updateLast((turn) => ({
        ...turn,
        text: '',
        provenance: `${event.provider_label} · ${event.model || 'default model'}${event.fallback ? ' · fallback' : ''}`,
      }))
      return
    case 'text':
      updateLast((turn) => ({ ...turn, text: turn.text + event.text }))
      return
    case 'done':
      updateLast((turn) => ({ ...turn, status: 'done' }))
      set({ ...state, runId: null })
      return
    case 'error':
      updateLast((turn) => ({ ...turn, status: event.kind === 'cancelled' ? 'cancelled' : 'error', error: event.message }))
      set({ ...state, runId: null })
      return
    default:
  }
}

function ensureSubscribed() {
  if (subscribed) return
  subscribed = true
  window.ogma.ai.onEvent((runId, event) => {
    if (runId === state.runId) apply(event)
    else if (early) early.set(runId, [...(early.get(runId) ?? []), event])
  })
}

export const chatStore = {
  subscribe(listener: () => void): () => void {
    ensureSubscribed()
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  snapshot: (): ChatState => state,

  async send(message: string, variables: Record<string, string>, options: { profileId?: string; contextLabel?: string }) {
    if (state.runId || early) return
    // Turns come in user/assistant pairs; a pair whose reply failed is left out so the roles keep alternating.
    const history: AiMessage[] = []
    for (let index = 0; index + 1 < state.turns.length; index += 2) {
      const [question, answer] = [state.turns[index], state.turns[index + 1]]
      if (answer.status === 'error' || !answer.text.trim()) continue
      history.push({ role: 'user', content: question.text }, { role: 'assistant', content: answer.text })
    }
    history.splice(0, Math.max(0, history.length - HISTORY_TURNS))
    set({
      ...state,
      turns: [
        ...state.turns,
        { role: 'user', text: message, context: options.contextLabel },
        { role: 'assistant', text: '', status: 'running', error: null },
      ],
    })
    ensureSubscribed()
    const buffer = new Map<string, AiEvent[]>()
    early = buffer
    const started = generation
    try {
      const id = await window.ogma.ai.run({ task: 'chat', variables: { ...variables, message }, history, profileId: options.profileId })
      const buffered = buffer.get(id) ?? []
      if (early === buffer) early = null
      if (generation !== started) {
        void window.ogma.ai.cancel(id)
        return
      }
      set({ ...state, runId: id })
      for (const event of buffered) if (state.runId === id) apply(event)
    } catch (error) {
      if (early === buffer) early = null
      if (generation === started) updateLast((turn) => ({ ...turn, status: 'error', error: errorMessage(error) }))
    }
  },

  cancel() {
    if (state.runId) void window.ogma.ai.cancel(state.runId)
  },

  clear() {
    if (state.runId) void window.ogma.ai.cancel(state.runId)
    generation += 1
    early = null
    set({ turns: [], runId: null })
  },
}
