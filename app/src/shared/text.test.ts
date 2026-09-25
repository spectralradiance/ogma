import { describe, expect, it } from 'vitest'

import { countWords, encodingLabel, lineEndingLabel } from './text'

describe('countWords', () => {
  it('counts words, keeping contractions and hyphenations whole', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('# The first era\n\nIt’s a well-known *story*.')).toBe(7)
    expect(countWords('Oisín agus Niamh — 1.2 nucleosynthesis')).toBe(6)
  })
})

describe('labels', () => {
  it('names encodings and line endings', () => {
    expect(encodingLabel('windows-1252')).toBe('Windows-1252')
    expect(lineEndingLabel('\r\n')).toBe('CRLF')
    expect(lineEndingLabel('\n')).toBe('LF')
  })
})
