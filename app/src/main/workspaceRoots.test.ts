import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_AI_CONFIG } from '../shared/ai'
import { DEFAULT_PREFERENCES } from '../shared/preferences'
import { SettingsStore, parseSettings } from './settings'
import { addRoot, removeRoot } from './workspaceRoots'

describe('workspace roots', () => {
  it('ignores case and trailing separators on Windows', () => {
    const roots = addRoot(['C:\\Notes\\Poetry'], 'c:\\notes\\poetry\\', 'win32')
    expect(roots).toEqual(['C:\\Notes\\Poetry'])
    expect(removeRoot(roots, 'c:/notes/poetry', 'win32')).toEqual([])
  })

  it('is case-sensitive on POSIX', () => {
    expect(addRoot(['/notes/Poetry'], '/notes/poetry', 'linux')).toEqual(['/notes/Poetry', '/notes/poetry'])
  })
})

describe('settings', () => {
  it('drops malformed values', () => {
    const empty = { workspaceRoots: [], dictionaryPath: null, lexiconDir: null, ai: DEFAULT_AI_CONFIG, compatBaseUrl: '', preferences: DEFAULT_PREFERENCES }
    expect(parseSettings({ workspaceRoots: ['a', 3, '', null], dictionaryPath: 7 })).toEqual({ ...empty, workspaceRoots: ['a'] })
    expect(parseSettings('nonsense')).toEqual(empty)
  })

  it('persists updates and preserves a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogma-settings-'))
    const path = join(dir, 'settings.json')

    new SettingsStore(path).update({ workspaceRoots: ['D:\\writing'] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ workspaceRoots: ['D:\\writing'] })
    expect(new SettingsStore(path).get().workspaceRoots).toEqual(['D:\\writing'])

    writeFileSync(path, '{ not json')
    expect(new SettingsStore(path).get().workspaceRoots).toEqual([])
    expect(readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-'))).toBe(true)
  })
})
