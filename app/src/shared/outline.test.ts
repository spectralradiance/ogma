import { describe, expect, it } from 'vitest'

import { leadSentence, outlineFile, outlineMarkdown, type OutlineSection, sectionHeadings } from './outline'

describe('leadSentence', () => {
  it('takes the first sentence of the first prose paragraph', () => {
    expect(leadSentence('# The Wandering Stars\n\nWatch the sky for a *few* weeks. Most of it holds still.')).toBe('Watch the sky for a few weeks.')
    expect(leadSentence('```\ncode.\n\nmore code.\n```\n\n- a [linked](x.md) note\n- another')).toBe('a linked note another')
    expect(leadSentence('## Only a heading')).toBe('')
    expect(leadSentence(`${'word '.repeat(60)}end.`, 20)).toHaveLength(20)
  })
})

describe('sectionHeadings', () => {
  it('leaves out the section heading on the first line, whatever it says', () => {
    const file = outlineFile('# Starrlight\n\ntext\n\n## Retrograde\n')
    expect(file.leading).toEqual({ level: 1, text: 'Starrlight' })
    expect(sectionHeadings(file).map((h) => h.text)).toEqual(['Retrograde'])
    expect(sectionHeadings(outlineFile('text\n\n## Retrograde\n')).map((h) => h.text)).toEqual(['Retrograde'])
  })
})

describe('outlineMarkdown', () => {
  const section = (ordinal: string, title: string, output: string | null, notes: string | null): OutlineSection => ({
    stem: `${ordinal} ${title}`, ordinal, title, notesPath: '', outputPath: '', output: outlineFile(output), notes: outlineFile(notes),
  })

  it('lists sections with sizes, nested headings and optional leads', () => {
    const sections = [
      section('01', 'Light', '# Light\n\nLight takes time. It travels.\n\n## Speed\n\n### Measuring\n', '## Sources\n'),
      section('02', 'Planets', null, 'wanderers against the stars'),
    ]
    expect(outlineMarkdown('Night Sky', sections, { notes: false, leads: false })).toBe([
      '# Night Sky',
      '',
      '1. 01 Light (output 8 words, notes 1 word)',
      '   - Speed',
      '      - Measuring',
      '2. 02 Planets (no output yet, notes 4 words, no section heading)',
      '',
    ].join('\n'))
    const full = outlineMarkdown('Night Sky', sections, { notes: true, leads: true })
    expect(full).toContain('   > Light takes time.')
    expect(full).toContain('   - (notes) Sources')
    expect(full).toContain('   > (notes) wanderers against the stars')
  })
})
