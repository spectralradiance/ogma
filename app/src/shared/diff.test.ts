import { describe, expect, it } from 'vitest'

import { applyEdits, diffWords, suggestEdits } from './diff'

describe('diffWords', () => {
  it('finds the changed words and merges changes split only by spaces', () => {
    const before = 'The quick brown fox jumps over the lazy dog.'
    const after = 'The slow red fox jumps over the lazy dog!'
    expect(diffWords(before, after)).toEqual([
      { from: 4, to: 15, insert: 'slow red' },
      { from: 43, to: 44, insert: '!' },
    ])
  })

  it('replaces a paragraph whole when little of it survives', () => {
    expect(diffWords('One two three four five.', 'Completely different words here now.')).toEqual([
      { from: 0, to: 24, insert: 'Completely different words here now.' },
    ])
  })

  it('keeps contractions as one word', () => {
    expect(diffWords("It isn't here yet.", "It wasn't here yet.")).toEqual([{ from: 3, to: 8, insert: "wasn't" }])
  })
})

describe('suggestEdits', () => {
  it('refines a changed paragraph and keeps whole-line insertions and deletions', () => {
    const before = 'First line.\nSecond line here.\nThird line.'
    const after = 'First line.\nSecond line there.\nNew line.\nThird line.'
    const edits = suggestEdits(before, after)
    expect(edits).toEqual([
      { from: 24, to: 28, insert: 'there' },
      { from: 30, to: 30, insert: 'New line.\n' },
    ])
    expect(applyEdits(before, edits)).toBe(after)
  })

  it('handles text at the very start and end', () => {
    for (const [before, after] of [
      ['', 'Fresh text.'],
      ['Gone.', ''],
      ['a\nb', 'a'],
      ['a', 'a\nb'],
      ['a\n', 'a\n\nc'],
      ['x\ny', 'w\nx\ny'],
    ]) {
      expect(applyEdits(before, suggestEdits(before, after))).toBe(after)
    }
  })

  it('always rebuilds the target text, with ordered non-overlapping edits', () => {
    const words = ['the', 'night', 'sky', 'stars', 'a', 'light', 'far', 'and', 'wander', 'cold']
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const paragraph = () => Array.from({ length: 1 + random(8) }, () => words[random(words.length)]).join(random(4) ? ' ' : ', ')
    const text = () => Array.from({ length: random(6) }, () => (random(5) ? paragraph() : '')).join('\n')
    for (let round = 0; round < 400; round += 1) {
      const before = text()
      const after = random(2) ? text() : before.replace(/sky|light/g, () => words[random(words.length)])
      const edits = suggestEdits(before, after)
      expect(applyEdits(before, edits)).toBe(after)
      edits.forEach((edit, index) => {
        expect(edit.from).toBeLessThanOrEqual(edit.to)
        if (index > 0) expect(edit.from).toBeGreaterThanOrEqual(edits[index - 1].to)
      })
    }
  })
})
