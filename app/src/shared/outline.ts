// A double document's outline: its sections in order, each with its headings and size.

import { countWords, extractHeadings, type Heading } from './text'

export interface FileOutline {
  exists: boolean
  words: number
  headings: Heading[]
  /** The first sentence of the first paragraph, for summaries. */
  lead: string
}

export interface OutlineSection {
  stem: string
  ordinal: string | null
  title: string
  notesPath: string
  outputPath: string
  notes: FileOutline
  output: FileOutline
}

export const EMPTY_FILE: FileOutline = { exists: false, words: 0, headings: [], lead: '' }

export function outlineFile(text: string | null): FileOutline {
  if (text === null) return EMPTY_FILE
  return { exists: true, words: countWords(text), headings: extractHeadings(text), lead: leadSentence(text) }
}

const plain = (text: string) => text
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2')
  .replace(/\s+/g, ' ')
  .trim()

/** The first sentence of the first prose paragraph (headings, code, rules and tables skipped), at most `limit` characters. */
export function leadSentence(text: string, limit = 160): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  let fenced = false
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()
    const fences = (trimmed.match(/^\s*(```|~~~)/gm) ?? []).length
    if (fenced || fences > 0) {
      if (fences % 2 === 1) fenced = !fenced
      continue
    }
    if (!trimmed || /^(#{1,6}\s|---|\*\*\*|\||<)/.test(trimmed)) continue
    const prose = plain(trimmed.replace(/^([-*+]|\d+[.)])\s+/gm, '').replace(/^>\s?/gm, ''))
    if (!prose) continue
    const sentence = /^.+?[.!?…](?=\s|$)/.exec(prose)?.[0] ?? prose
    return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence
  }
  return ''
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** A section's headings, without a first heading that only repeats the section title. */
export function sectionHeadings(title: string, file: FileOutline): Heading[] {
  const [first, ...rest] = file.headings
  if (first && normalized(first.text) === normalized(title)) return rest
  return file.headings
}

export interface OutlineOptions {
  /** Include the notes files' headings too. */
  notes: boolean
  /** Add each section's opening sentence (for analysis). */
  leads: boolean
}

/** The outline as Markdown: one numbered entry per section with its size, headings nested beneath. */
export function outlineMarkdown(title: string, sections: OutlineSection[], options: OutlineOptions): string {
  const lines = [`# ${title}`, '']
  sections.forEach((section, index) => {
    const words = (count: number) => `${count} ${count === 1 ? 'word' : 'words'}`
    const size = [
      section.output.exists ? `output ${words(section.output.words)}` : 'no output yet',
      section.notes.exists ? `notes ${words(section.notes.words)}` : 'no notes',
    ].join(', ')
    lines.push(`${index + 1}. ${section.ordinal ? `${section.ordinal} ` : ''}${section.title} (${size})`)
    const lead = section.output.lead || (options.leads ? section.notes.lead : '')
    if (options.leads && lead) lines.push(`   > ${section.output.lead ? '' : '(notes) '}${lead}`)
    const add = (headings: Heading[], prefix: string) => {
      const top = Math.min(...headings.map((heading) => heading.level))
      for (const heading of headings) lines.push(`${'   '.repeat(heading.level - top + 1)}- ${prefix}${heading.text}`)
    }
    const output = sectionHeadings(section.title, section.output)
    if (output.length) add(output, '')
    const notes = options.notes ? sectionHeadings(section.title, section.notes) : []
    if (notes.length) add(notes, '(notes) ')
  })
  return `${lines.join('\n')}\n`
}
