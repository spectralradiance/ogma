import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_AI_CONFIG, normalizeAiConfig } from '../shared/ai'
import { parseSse } from './aiBridge'
import { DEFAULT_PROMPTS, PromptStore, renderTemplate } from './prompts'
import { type Cipher, SecretStore } from './secrets'

describe('parseSse', () => {
  it('returns complete events and keeps the unfinished tail', () => {
    const first = parseSse('data: {"type":"start","profile":"claude"}\n\ndata: {"type":"text","text":"Hel')
    expect(first.events).toEqual([{ type: 'start', profile: 'claude' }])
    const second = parseSse(`${first.rest}lo"}\n\n: comment\n\ndata: not json\n\n`)
    expect(second.events).toEqual([{ type: 'text', text: 'Hello' }])
    expect(second.rest).toBe('')
  })

  it('accepts CRLF separators', () => {
    expect(parseSse('data: {"type":"done","stop_reason":"end_turn"}\r\n\r\n').events).toHaveLength(1)
  })
})

describe('prompt templates', () => {
  it('split into system and user parts and fill placeholders', () => {
    const rendered = renderTemplate('Be {{ tone }}.\n=== user ===\nNotes:\n{{notes}}\n{{missing}}', { tone: 'terse', notes: '- one' })
    expect(rendered).toEqual({ system: 'Be terse.', messages: [{ role: 'user', content: 'Notes:\n- one' }] })
  })

  it('treat a template without a marker as the user message', () => {
    expect(renderTemplate('Just {{x}}', { x: 'this' })).toEqual({ system: '', messages: [{ role: 'user', content: 'Just this' }] })
  })

  it('every built-in template has a user part', () => {
    for (const template of Object.values(DEFAULT_PROMPTS)) {
      const rendered = renderTemplate(template, { message: 'Hello' })
      expect(rendered.system.length).toBeGreaterThan(0)
      expect(rendered.messages[0].content.length).toBeGreaterThan(0)
    }
  })

  it('are copied for editing without overwriting the user’s edits', async () => {
    const store = new PromptStore(path.join(await mkdtemp(path.join(tmpdir(), 'ogma-prompts-')), 'prompts'))
    await store.ensureDefaults()
    await writeFile(path.join(store.location, 'analyze.md'), 'Mine.\n=== user ===\n{{text}}')
    await store.ensureDefaults()
    expect(await store.template('analyze')).toBe('Mine.\n=== user ===\n{{text}}')
    expect(await store.template('synthesize')).toBe(DEFAULT_PROMPTS.synthesize)
  })
})

// Reversible stand-in for the OS cipher.
const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain)].map((byte) => byte ^ 0x5a)),
  decrypt: (encrypted) => Buffer.from([...encrypted].map((byte) => byte ^ 0x5a)).toString(),
}

describe('SecretStore', () => {
  it('stores keys encrypted, reports only whether they are set, and clears them', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-keys-')), 'keys.json')
    const store = new SecretStore(file, cipher)
    store.set('ANTHROPIC_API_KEY', '  sk-ant-secret  ')
    expect(await readFile(file, 'utf8')).not.toContain('sk-ant-secret')
    expect(store.status().find((entry) => entry.name === 'ANTHROPIC_API_KEY')?.set).toBe(true)
    expect(new SecretStore(file, cipher).env()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-secret' })
    store.set('ANTHROPIC_API_KEY', null)
    expect(new SecretStore(file, cipher).env()).toEqual({})
  })

  it('refuses to store keys when the OS cannot encrypt', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-keys-')), 'keys.json')
    const store = new SecretStore(file, { ...cipher, available: () => false })
    expect(() => store.set('OPENAI_API_KEY', 'sk-x')).toThrow(/cannot encrypt/)
  })
})

describe('normalizeAiConfig', () => {
  it('fills defaults and drops routing entries for removed profiles', () => {
    expect(normalizeAiConfig(undefined)).toEqual(DEFAULT_AI_CONFIG)
    const config = normalizeAiConfig({
      mode: 'cloud',
      profiles: [{ id: 'claude', label: '', provider: 'anthropic', model: 'claude-opus-5', params: {} }, { id: 'x', provider: 'nope' }],
      routing: { synthesize: ['claude', 'gone'] },
    })
    expect(config.mode).toBe('cloud')
    expect(config.profiles.map((profile) => profile.id)).toEqual(['claude'])
    expect(config.profiles[0].label).toBe('claude')
    expect(config.routing.synthesize).toEqual(['claude'])
    expect(config.routing.analyze).toEqual(['claude'])
    expect(config.routing.chat).toEqual(['claude'])
  })
})
