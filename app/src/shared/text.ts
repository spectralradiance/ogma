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
