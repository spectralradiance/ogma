import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, normalizePreferences } from './preferences'

describe('normalizePreferences', () => {
  it('fills defaults and clamps values', () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    const prefs = normalizePreferences({ appearance: { theme: 'dark', textSize: 99, lineHeight: 'x' }, export: { pageSize: 'Letter', margins: 'huge' } })
    expect(prefs.appearance).toMatchObject({ theme: 'dark', textSize: 28, lineHeight: DEFAULT_PREFERENCES.appearance.lineHeight })
    expect(prefs.export).toMatchObject({ pageSize: 'Letter', margins: 'normal' })
  })

  it('accepts font lists but nothing that could break out of CSS', () => {
    expect(normalizePreferences({ appearance: { textFont: "'Iowan Old Style', serif" } }).appearance.textFont).toBe("'Iowan Old Style', serif")
    expect(normalizePreferences({ appearance: { textFont: 'serif; } body { display: none' } }).appearance.textFont)
      .toBe(DEFAULT_PREFERENCES.appearance.textFont)
    expect(normalizePreferences({ appearance: { sourceFont: 'var(--font-serif)' } }).appearance.sourceFont).toBe('var(--font-serif)')
  })
})
