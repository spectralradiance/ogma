import { describe, expect, it } from 'vitest'

import {
  countWords, encodingLabel, extractHeadings, isSingleWord, lineEndingLabel, matchCase, sentenceAround, splitLeadingHeading, withLeadingHeading, wordAt,
} from './text'

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

describe('word helpers', () => {
  it('find the word at an offset, keeping apostrophes and hyphens', () => {
    expect(wordAt('the star-stuff’s glow', 6)).toEqual({ word: 'star-stuff’s', from: 4, to: 16 })
    expect(wordAt('a  b', 2)).toBeNull()
    expect(isSingleWord('melancholy')).toBe(true)
    expect(isSingleWord('two words')).toBe(false)
  })

  it('extract the sentence around a word', () => {
    const paragraph = '> First sentence. The **deep** melancholy settled! Last one'
    const from = paragraph.indexOf('melancholy')
    expect(sentenceAround(paragraph, from, from + 10)).toBe('The deep melancholy settled!')
  })

  it('match the case of the replaced word', () => {
    expect(matchCase('Gloomy', 'sad')).toBe('Sad')
    expect(matchCase('GLOOMY', 'sad')).toBe('SAD')
    expect(matchCase('gloomy', 'sad')).toBe('sad')
  })
})

describe('splitLeadingHeading', () => {
  it('splits a first-line heading and its blank lines off the body', () => {
    const text = '\n# Starlight and Time ##\n\n\nLight is fast.\n\n## Later\n'
    const { head, body, heading } = splitLeadingHeading(text)
    expect(heading).toEqual({ level: 1, text: 'Starlight and Time' })
    expect(body).toBe('Light is fast.\n\n## Later\n')
    expect(head + body).toBe(text)
    expect(splitLeadingHeading('# Only')).toEqual({ head: '# Only', body: '', heading: { level: 1, text: 'Only' } })
    expect(splitLeadingHeading('#hashtag first\n').heading).toBeNull()
    expect(splitLeadingHeading('Text\n# Not first\n').heading).toBeNull()
    expect(splitLeadingHeading('# A\r\n\r\nbody').body).toBe('body')
  })

  it('replaces, adds and removes the leading heading', () => {
    expect(withLeadingHeading('# Old\n\nBody.\n', { level: 1, text: 'New' })).toBe('# New\n\nBody.\n')
    expect(withLeadingHeading('Body.\n', { level: 2, text: 'Title' })).toBe('## Title\n\nBody.\n')
    expect(withLeadingHeading('', { level: 1, text: 'Title' })).toBe('# Title\n')
    expect(withLeadingHeading('# Old\n\nBody.\n', null)).toBe('Body.\n')
  })
})
