import { describe, expect, it } from 'vitest'

import { summarizeSections } from './document'
import { outlineMarkdown } from './outline'

describe('outlineMarkdown', () => {
  it('lists sections with their sizes and nested headings', () => {
    const sections = summarizeSections([
      '::: notes', 'plan', ':::', '',
      '# First Light', '', 'Dusk comes.', '', '## The first star', '', 'Venus.', '',
      '# Constellations', '', '::: notes', 'patterns', ':::',
    ].join('\n'))
    expect(outlineMarkdown('Night Sky', sections)).toBe([
      '# Night Sky',
      '',
      '1. First Light (8 words, no notes)',
      '   - The first star',
      '2. Constellations (no text yet, notes 1 word)',
      '',
    ].join('\n'))
  })
})
