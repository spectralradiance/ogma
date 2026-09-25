import { describe, expect, it } from 'vitest'

import { countWords, encodingLabel, extractHeadings, lineEndingLabel } from './text'

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

describe('extractHeadings', () => {
  it('lists ATX headings with plain text, skipping fenced code', () => {
    const text = '# The **First** Era\n\nbody\n\n```\n# not a heading\n```\n## [Sources](x) ##\n#nospace'
    expect(extractHeadings(text)).toEqual([
      { level: 1, text: 'The First Era', line: 1 },
      { level: 2, text: 'Sources', line: 8 },
    ])
  })
})
