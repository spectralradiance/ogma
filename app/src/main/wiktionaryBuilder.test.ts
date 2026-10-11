import { describe, expect, it } from 'vitest'

import { toRow } from './wiktionaryBuilder'

describe('toRow', () => {
  it('keeps glosses, examples, pronunciations and related words', () => {
    const row = toRow(JSON.stringify({
      word: 'run',
      pos: 'verb',
      etymology_text: ' From Old English. ',
      sounds: [{ ipa: '/rʌn/' }, { ipa: '/rʌn/' }, {}],
      synonyms: [{ word: 'sprint' }],
      senses: [
        { glosses: ['To move quickly.'], examples: [{ text: 'I run daily.', english: 'Daily, I run.' }], synonyms: [{ word: 'jog' }, { word: 'sprint' }] },
        { glosses: [] },
      ],
    }))
    expect(row?.etymology).toBe('From Old English.')
    expect(row?.gloss).toBe('To move quickly.')
    expect(JSON.parse(row?.data ?? '{}')).toEqual({
      senses: [{ glosses: ['To move quickly.'], examples: [{ text: 'I run daily.', translation: 'Daily, I run.' }] }],
      ipa: ['/rʌn/'],
      synonyms: ['sprint', 'jog'],
      antonyms: [],
      derived: [],
      related: [],
    })
  })

  it('skips lines with nothing to define', () => {
    expect(toRow('not json')).toBeNull()
    expect(toRow(JSON.stringify({ word: 'x', pos: 'noun', senses: [{ glosses: [] }] }))).toBeNull()
    expect(toRow(JSON.stringify({ pos: 'noun', senses: [{ glosses: ['a'] }] }))).toBeNull()
  })
})
