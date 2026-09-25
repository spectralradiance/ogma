import { describe, expect, it } from 'vitest'

import { applyHunks, changeIndexes, diffLines } from './diff'
import { describeMetrics, measureText, plainText, syllables } from './readability'

describe('diffLines', () => {
  it('groups unchanged and changed paragraphs', () => {
    const before = 'Title\n\nOld paragraph.\n\nKept.'
    const after = 'Title\n\nNew paragraph.\nAnother.\n\nKept.'
    expect(diffLines(before, after)).toEqual([
      { kind: 'same', lines: ['Title', ''] },
      { kind: 'change', before: ['Old paragraph.'], after: ['New paragraph.', 'Another.'] },
      { kind: 'same', lines: ['', 'Kept.'] },
    ])
  })

  it('treats an empty original as one insertion', () => {
    expect(diffLines('', 'a\nb')).toEqual([{ kind: 'change', before: [], after: ['a', 'b'] }])
    expect(diffLines('same', 'same')).toEqual([{ kind: 'same', lines: ['same'] }])
  })

  it('applies only the accepted hunks', () => {
    const hunks = diffLines('one\ntwo\nthree', 'ONE\ntwo\nTHREE')
    const [first, second] = changeIndexes(hunks)
    expect(applyHunks(hunks, new Set([first]))).toBe('ONE\ntwo\nthree')
    expect(applyHunks(hunks, new Set([first, second]))).toBe('ONE\ntwo\nTHREE')
    expect(applyHunks(hunks, new Set())).toBe('one\ntwo\nthree')
  })
})

describe('readability', () => {
  it('counts syllables approximately', () => {
    expect(syllables('cat')).toBe(1)
    expect(syllables('constellation')).toBe(4)
    expect(syllables('wandering')).toBe(3)
    expect(syllables('the')).toBe(1)
  })

  it('ignores Markdown syntax', () => {
    expect(plainText('## Title\n- [x] **done** and `code` [link](http://x)')).toBe('Title\ndone and   link')
  })

  it('measures sentences, spread, reading ease and repetition', () => {
    const text = 'The star is bright. The star is old. The star is far away from here, much farther than it looks tonight.\n\nNew paragraph.'
    const metrics = measureText(text)
    expect(metrics).toMatchObject({ sentences: 4, paragraphs: 2, longSentences: 0 })
    expect(metrics.repeated).toEqual([{ word: 'star', count: 3 }])
    expect(metrics.readingEase).toBeGreaterThan(70)
    expect(metrics.sentenceSpread).toBeGreaterThan(2)
    expect(describeMetrics(metrics)).toContain('star ×3')
    expect(measureText('').words).toBe(0)
  })
})
