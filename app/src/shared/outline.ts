// A document's outline as Markdown, for structure analysis and copying.

import type { SectionSummary } from './document'

/** The sections with their sizes, headings nested beneath. */
export function outlineMarkdown(title: string, sections: readonly SectionSummary[]): string {
  const lines = [`# ${title}`, '']
  const words = (count: number) => `${count} ${count === 1 ? 'word' : 'words'}`
  sections.filter((section) => section.title !== null).forEach((section, index) => {
    const notes = section.notesWords > 0 ? `, notes ${words(section.notesWords)}` : ', no notes'
    lines.push(`${index + 1}. ${section.title} (${section.hasText ? words(section.outputWords) : 'no text yet'}${notes})`)
    if (section.headings.length === 0) return
    const top = Math.min(...section.headings.map((heading) => heading.level))
    for (const heading of section.headings) lines.push(`${'   '.repeat(heading.level - top + 1)}- ${heading.text}`)
  })
  return `${lines.join('\n')}\n`
}
