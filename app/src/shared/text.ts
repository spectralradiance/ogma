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
