import type { LineEnding, TextEncodingName } from './ipc'

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

const ENCODING_LABELS: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
}

export function encodingLabel(encoding: TextEncodingName): string {
  return ENCODING_LABELS[encoding]
}

export function lineEndingLabel(eol: LineEnding): string {
  return eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF'
}

export interface Heading {
  level: number
  text: string
  /** 1-based line number. */
  line: number
}

/** ATX headings outside fenced code blocks, for the outline. */
export function extractHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  text.split('\n').forEach((line, index) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading && heading[2]) {
      const plain = heading[2].replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      headings.push({ level: heading[1].length, text: plain, line: index + 1 })
    }
  })
  return headings
}

const WORD_AT = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu

/** The word touching `offset` in `line`, if any. */
export function wordAt(line: string, offset: number): { word: string; from: number; to: number } | null {
  for (const match of line.matchAll(WORD_AT)) {
    const from = match.index
    const to = from + match[0].length
    if (offset >= from && offset <= to) return { word: match[0], from, to }
  }
  return null
}

/** Whether `text` is a single word (possibly with an apostrophe or hyphen). */
export function isSingleWord(text: string): boolean {
  return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(text)
}

/** The sentence around [from, to) within a paragraph, trimmed of Markdown markers. */
export function sentenceAround(paragraph: string, from: number, to: number): string {
  const before = paragraph.slice(0, from)
  const after = paragraph.slice(to)
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? ')) + 1
  const endMatch = /[.!?](\s|$)/.exec(after)
  const end = endMatch ? to + endMatch.index + 1 : paragraph.length
  return paragraph.slice(start, end).replace(/^[\s>#*-]+/, '').replace(/[*_`]+/g, '').trim()
}

/** Gives `replacement` the capitalization pattern of `original` (Word → Word, WORD → WORD). */
export function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toLocaleUpperCase()) return replacement.toLocaleUpperCase()
  const first = original.charAt(0)
  if (first && first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) {
    return replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1)
  }
  return replacement
}

export interface LeadingHeading {
  level: number
  text: string
}

/**
 * Splits off a heading on a file's first non-blank line: in a double document
 * that heading is the section's heading, shown on the section line rather than
 * in the editor. `head` is the heading line and the blank lines after it, so
 * `head + body` is always the original text.
 */
export function splitLeadingHeading(text: string): { head: string; body: string; heading: LeadingHeading | null } {
  const match = /^(?:[ \t]*\r?\n)*[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)(?:[ \t]*(?:\r?\n|$))*/.exec(text)
  if (!match || !match[2].trim()) return { head: '', body: text, heading: null }
  return { head: match[0], body: text.slice(match[0].length), heading: { level: match[1].length, text: match[2].trim() } }
}

/** Replaces or adds (at `level`) the leading heading, or removes it when `heading` is null. */
export function withLeadingHeading(text: string, heading: LeadingHeading | null): string {
  const { body } = splitLeadingHeading(text)
  if (!heading) return body
  return body.trim() ? `${'#'.repeat(heading.level)} ${heading.text}\n\n${body}` : `${'#'.repeat(heading.level)} ${heading.text}\n`
}
