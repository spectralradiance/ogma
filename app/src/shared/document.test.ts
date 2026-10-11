import { describe, expect, it } from 'vitest'

import {
  demoteHeadings, planNotes, replaceSectionOutput, sectionAtLine, sectionLevel, splitSections, splitWordCounts, summarizeSections,
} from './document'
import { classifyLines, stripNotes } from './notes'
import { extractHeadings } from './text'

const SAMPLE = [
  'Before any section.',
  '',
  '::: notes',
  'Overall: keep it short.',
  ':::',
  '',
  '# Stars',
  '',
  'Stars are far away suns.',
  '',
  '::: notes',
  '# not a section',
  'check distances',
  ':::',
  '',
  '# Planets',
  '',
  'Planets wander.',
  '',
  '## Mars',
  '',
  'Red.',
].join('\n')

describe('classifyLines', () => {
  it('marks notes blocks and leaves code fences alone', () => {
    expect(classifyLines(['a', '::: notes', 'b', ':::', 'c'])).toEqual(['output', 'open', 'notes', 'close', 'output'])
    expect(classifyLines(['```', '::: notes', '```', 'x'])).toEqual(['output', 'output', 'output', 'output'])
    expect(classifyLines(['::: notes', '```', ':::', '```', 'still notes', ':::'])).toEqual(['open', 'notes', 'notes', 'notes', 'notes', 'close'])
  })

  it('runs an unclosed block to the end', () => {
    expect(classifyLines(['::: notes', 'typing…'])).toEqual(['open', 'notes'])
  })

  it('accepts longer fences and CRLF', () => {
    expect(classifyLines([':::: Notes\r', 'x\r', '::::\r'])).toEqual(['open', 'notes', 'close'])
  })
})

describe('stripNotes', () => {
  it('removes blocks and the blank lines around them', () => {
    expect(stripNotes('one\n\n::: notes\nsecret\n:::\n\ntwo')).toBe('one\n\ntwo')
  })

  it('leaves text without notes untouched', () => {
    expect(stripNotes('a\n\n\n\nb')).toBe('a\n\n\n\nb')
  })
})

describe('headings', () => {
  it('ignores headings inside notes', () => {
    expect(extractHeadings(SAMPLE).map((heading) => heading.text)).toEqual(['Stars', 'Planets', 'Mars'])
  })
})

describe('sectionLevel', () => {
  it('splits at # headings', () => {
    expect(sectionLevel(extractHeadings(SAMPLE))).toBe(1)
    expect(sectionLevel(extractHeadings('# A\n\n## a1'))).toBe(1)
  })

  it('falls back to the shallowest level when there is no #', () => {
    expect(sectionLevel(extractHeadings('## A\n\n### a1'))).toBe(2)
  })

  it('defaults to 1 with no headings', () => {
    expect(sectionLevel([])).toBe(1)
  })
})

describe('splitSections', () => {
  const sections = splitSections(SAMPLE)

  it('splits at # headings, with text before the first as a preamble', () => {
    expect(sections.map((section) => section.title)).toEqual([null, 'Stars', 'Planets'])
    expect(sections[0]).toMatchObject({ output: 'Before any section.', notes: 'Overall: keep it short.' })
  })

  it('separates output from notes', () => {
    const stars = sections[1]
    expect(stars.output).toBe('Stars are far away suns.')
    expect(stars.notes).toBe('# not a section\ncheck distances')
    expect(stars.outputWords).toBe(6)
    expect(stars.notesWords).toBe(5)
  })

  it('keeps deeper headings inside their section', () => {
    expect(sections[2].headings.map((heading) => heading.text)).toEqual(['Mars'])
    expect(sections[2].output).toContain('Red.')
  })

  it('records where each section sits', () => {
    expect(sections.map((section) => [section.line, section.endLine])).toEqual([[0, 6], [7, 15], [16, 22]])
    expect(sectionAtLine(sections, 9)).toBe(1)
    expect(sectionAtLine(sections, 20)).toBe(2)
  })

  it('handles text with no headings', () => {
    expect(splitSections('just words')).toMatchObject([{ title: null, output: 'just words' }])
  })

  it('summarizes without the text', () => {
    expect(summarizeSections(SAMPLE)[1]).toEqual({
      title: 'Stars', level: 1, line: 7, endLine: 15, hasText: true, outputWords: 6, notesWords: 5, headings: [],
    })
  })
})

describe('splitWordCounts', () => {
  it('counts output and notes apart', () => {
    expect(splitWordCounts('one two\n::: notes\nthree four five\n:::\nsix')).toEqual({ output: 3, notes: 3 })
  })
})

describe('planNotes', () => {
  it('adds a block at the end of the section, before the next heading', () => {
    const plan = planNotes('## A\n\ntext\n\n## B\n\nmore', 3)
    expect(plan.kind).toBe('insert')
    if (plan.kind !== 'insert') return
    const next = `${'## A\n\ntext\n\n## B\n\nmore'.slice(0, plan.offset)}${plan.insert}${'## A\n\ntext\n\n## B\n\nmore'.slice(plan.offset)}`
    expect(next).toBe('## A\n\ntext\n\n::: notes\n\n:::\n\n## B\n\nmore')
    expect(next.slice(plan.cursor - 1, plan.cursor + 1)).toBe('\n\n')
  })

  it('appends to the end of the document', () => {
    const plan = planNotes('## A\n\ntext', 1)
    expect(plan).toMatchObject({ kind: 'insert', offset: 10 })
    if (plan.kind === 'insert') expect(plan.insert.endsWith(':::\n')).toBe(true)
  })

  it('jumps into existing notes instead', () => {
    expect(planNotes(SAMPLE, 9)).toEqual({ kind: 'jump', line: 12 })
  })
})

describe('replaceSectionOutput', () => {
  it('replaces the text and keeps the heading and notes', () => {
    const next = replaceSectionOutput(SAMPLE, 1, 'Stars burn.')!
    const stars = splitSections(next)[1]
    expect(stars.title).toBe('Stars')
    expect(stars.output).toBe('Stars burn.')
    expect(stars.notes).toBe('# not a section\ncheck distances')
    expect(splitSections(next)).toHaveLength(3)
    expect(splitSections(next)[2].output).toContain('Planets wander.')
  })

  it('returns null for a missing section', () => {
    expect(replaceSectionOutput(SAMPLE, 9, 'x')).toBeNull()
  })
})

describe('demoteHeadings', () => {
  it('moves every heading down so none is above the given level', () => {
    expect(demoteHeadings('# A\n\ntext\n\n## B', 2)).toBe('## A\n\ntext\n\n### B')
    expect(demoteHeadings('### A', 2)).toBe('### A')
    expect(demoteHeadings('no headings', 2)).toBe('no headings')
  })
})
