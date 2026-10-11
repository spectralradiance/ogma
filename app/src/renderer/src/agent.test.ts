import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AiEvent, AiRunRequest } from '../../shared/ai'
import { MATCH_END, MATCH_START } from '../../shared/ipc'
import { type AgentHost, AgentToolbox } from './agentTools'
import { chatStore, flattenTranscript } from './chatStore'

function fakeHost(files: Record<string, string>) {
  const edits: { path: string; oldText: string; newText: string; snapshot: boolean }[] = []
  const host: AgentHost = {
    openFiles: () => Object.entries(files).map(([path, text], index) => ({ path, text, focused: index === 0 })),
    read: async (path) => files[path] ?? null,
    outline: () => '# Piece\n1. First',
    search: async () => [{ path: 'C:\\w\\a.md', line: 3, snippet: `the ${MATCH_START}stars${MATCH_END} came` }],
    suggestEdit: (path, oldText, newText, _label, snapshot) => {
      if (!files[path].includes(oldText)) return { error: 'old_text was not found.' }
      edits.push({ path, oldText, newText, snapshot })
      return { count: 1 }
    },
  }
  return { host, edits }
}

describe('AgentToolbox', () => {
  it('reads long files in parts and says how to continue', async () => {
    const long = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')
    const { host } = fakeHost({ 'C:\\w\\a.md': long })
    const tools = new AgentToolbox(host, 'Agent')
    const first = await tools.run('read_file', { path: 'C:\\w\\a.md' })
    expect(first.content).toContain('Continue with start_line 401')
    const rest = await tools.run('read_file', { path: 'C:\\w\\a.md', start_line: 401 })
    expect(rest.content).toContain('line 500')
    expect((await tools.run('read_file', { path: 'C:\\w\\missing.md' })).isError).toBe(true)
  })

  it('edits only open files and saves a restore point once per file', async () => {
    const { host, edits } = fakeHost({ 'C:\\w\\a.md': 'The night was cold.' })
    const tools = new AgentToolbox(host, 'Agent')
    expect((await tools.run('suggest_edit', { path: 'C:\\w\\b.md', old_text: 'x', new_text: 'y' })).isError).toBe(true)
    expect((await tools.run('suggest_edit', { path: 'c:/w/a.md'.replace(/\//g, '\\'), old_text: 'cold', new_text: 'bitter' })).isError).toBe(false)
    await tools.run('suggest_edit', { path: 'C:\\w\\a.md', old_text: 'night', new_text: 'evening' })
    expect(edits.map((edit) => edit.snapshot)).toEqual([true, false])
    expect((await tools.run('suggest_edit', { path: 'C:\\w\\a.md' })).isError).toBe(true)
  })

  it('cleans search snippets and rejects unknown tools', async () => {
    const tools = new AgentToolbox(fakeHost({}).host, 'Agent')
    expect((await tools.run('search_workspace', { query: 'stars' })).content).toBe('C:\\w\\a.md:3 — the stars came')
    expect((await tools.run('delete_everything', {})).isError).toBe(true)
  })
})

describe('flattenTranscript', () => {
  it('keeps only text, merges neighbours and starts with the user', () => {
    expect(flattenTranscript([
      { role: 'assistant', content: 'stray' },
      { role: 'user', content: 'Fix it' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_call', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 't1', content: 'Body' }] },
      { role: 'assistant', content: 'Done.' },
    ])).toEqual([
      { role: 'user', content: 'Fix it' },
      { role: 'assistant', content: 'Looking.' },
      { role: 'user', content: '[Tool result]\nBody' },
      { role: 'assistant', content: 'Done.' },
    ])
  })
})

describe('chat agent loop', () => {
  const requests: AiRunRequest[] = []
  let listener: ((runId: string, event: AiEvent) => void) | null = null
  // The events each successive run streams back.
  let script: AiEvent[][] = []

  beforeEach(() => {
    requests.length = 0
    const ogma = {
      ai: {
        onEvent: (next: typeof listener) => {
          listener = next
          return () => {}
        },
        render: async (_task: string, variables: Record<string, string>) => ({ system: '', messages: [{ role: 'user', content: `Q: ${variables.message}` }] }),
        run: async (request: AiRunRequest) => {
          requests.push(structuredClone(request))
          const id = `run-${requests.length}`
          const events = script[requests.length - 1] ?? []
          setTimeout(() => events.forEach((event) => listener?.(id, event)), 0)
          return id
        },
        cancel: async () => {},
      },
    }
    ;(globalThis as unknown as { window: unknown }).window = { ogma }
  })

  afterEach(() => chatStore.clear())

  it('runs the tools a step asks for and continues with the results, replaying the native turn', async () => {
    const native = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'C:\\w\\a.md' } }]
    script = [
      [
        { type: 'start', profile: 'claude', provider: 'anthropic', provider_label: 'Anthropic', model: 'm', fallback: false, skipped: [] },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'C:\\w\\a.md' } },
        { type: 'assistant_message', provider: 'anthropic', content: native },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'It reads well.' }, { type: 'done', stop_reason: 'end_turn' }],
    ]
    const { host } = fakeHost({ 'C:\\w\\a.md': 'Body text' })
    await chatStore.send('Check a.md', { document: 'Piece' }, { agent: host })

    expect(requests).toHaveLength(2)
    expect(requests[0].task).toBe('agent')
    expect(requests[0].tools?.map((tool) => tool.name)).toContain('suggest_edit')
    expect(requests[0].history).toEqual([{ role: 'user', content: 'Q: Check a.md' }])
    // The second request resends the first exactly, then the assistant turn and the tool result.
    expect(requests[1].history?.slice(0, 1)).toEqual(requests[0].history)
    expect(requests[1].history?.[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'C:\\w\\a.md' } }],
      native: { provider: 'anthropic', content: native },
    })
    expect(requests[1].history?.[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_call_id: 't1', content: 'Body text', is_error: false }] })

    const turn = chatStore.snapshot().turns[1]
    expect(turn.status).toBe('done')
    expect(turn.parts).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', summary: 'Read a.md', isError: false },
      { type: 'text', text: 'It reads well.' },
    ])
    expect(chatStore.snapshot().busy).toBe(false)
  })

  it('does not run tools from a turn that was cut off', async () => {
    script = [[
      { type: 'tool_call', id: 't1', name: 'suggest_edit', input: { path: 'C:\\w\\a.md', old_text: 'Body', new_text: 'B' } },
      { type: 'done', stop_reason: 'max_tokens' },
    ]]
    const { host, edits } = fakeHost({ 'C:\\w\\a.md': 'Body text' })
    await chatStore.send('Edit it', {}, { agent: host })
    expect(requests).toHaveLength(1)
    expect(edits).toHaveLength(0)
  })

  it('sends plain chat without tools, as flattened text', async () => {
    script = [[{ type: 'text', text: 'Hi.' }, { type: 'done', stop_reason: 'end_turn' }], [{ type: 'done', stop_reason: 'end_turn' }]]
    await chatStore.send('Hello', {}, {})
    await chatStore.send('Again', {}, {})
    expect(requests[0].task).toBe('chat')
    expect(requests[0].tools).toBeUndefined()
    expect(requests[1].history).toEqual([
      { role: 'user', content: 'Q: Hello' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Q: Again' },
    ])
  })
})
