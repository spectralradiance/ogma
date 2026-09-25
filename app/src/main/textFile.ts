import type { LineEnding, TextEncodingName, TextFormat } from '../shared/ipc'

/**
 * Decoding and encoding that round-trips the user's original files byte for byte.
 *
 * The editor always works on text with "\n" line breaks; the detected encoding,
 * BOM and line ending are carried alongside it and restored on save. Old notes
 * written on Windows are often cp1252, so bytes that are not valid UTF-8 fall back
 * to windows-1252 rather than being mangled into replacement characters.
 */

export class BinaryFileError extends Error {
  constructor() {
    super('This looks like a binary file, not text.')
  }
}

export interface DecodedText {
  text: string
  format: TextFormat
}

export interface EncodedText {
  bytes: Uint8Array
  format: TextFormat
  /** Set when the file could not be saved in its original format. */
  notice: string | null
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const SNIFF_BYTES = 8192

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

// windows-1252 differs from Latin-1 only in 0x80-0x9F. Node's TextDecoder silently
// decodes "windows-1252" as Latin-1 in some builds, so the table is spelled out.
// The five undefined bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to the matching C1
// control characters, as the WHATWG decoder does, so they still round-trip.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
]

function cp1252CodePoint(byte: number): number {
  return byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte
}

let cp1252Reverse: Map<number, number> | null = null
function cp1252Table(): Map<number, number> {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map()
    for (let byte = 0; byte < 256; byte += 1) cp1252Reverse.set(cp1252CodePoint(byte), byte)
  }
  return cp1252Reverse
}

function decodeCp1252(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(cp1252CodePoint(byte))
  return text
}

function encodeCp1252(text: string): Uint8Array | null {
  const table = cp1252Table()
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const byte = table.get(text.charCodeAt(index))
    if (byte === undefined) return null
    bytes[index] = byte
  }
  return bytes
}

function encodeUtf16(text: string, bigEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    const high = unit >> 8
    const low = unit & 0xff
    bytes[index * 2] = bigEndian ? high : low
    bytes[index * 2 + 1] = bigEndian ? low : high
  }
  return bytes
}

function concat(prefix: number[], body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(prefix.length + body.length)
  bytes.set(prefix, 0)
  bytes.set(body, prefix.length)
  return bytes
}

export function detectLineEndings(text: string): { eol: LineEnding; mixed: boolean } {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = text.match(/(?<!\r)\n/g)?.length ?? 0
  const cr = text.match(/\r(?!\n)/g)?.length ?? 0
  const kinds = [crlf, lf, cr].filter((count) => count > 0).length
  let eol: LineEnding = '\n'
  if (crlf > lf && crlf >= cr) eol = '\r\n'
  else if (cr > lf && cr > crlf) eol = '\r'
  return { eol, mixed: kinds > 1 }
}

function decodeBody(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (startsWith(bytes, UTF8_BOM)) {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3)), encoding: 'utf-8-bom' }
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return { text: new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return { text: new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) throw new BinaryFileError()
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { text: decodeCp1252(bytes), encoding: 'windows-1252' }
  }
}

export function decodeText(bytes: Uint8Array): DecodedText {
  const { text, encoding } = decodeBody(bytes)
  const { eol, mixed } = detectLineEndings(text)
  return {
    text: text.replace(/\r\n?/g, '\n'),
    format: { encoding, eol, mixedEol: mixed },
  }
}

export function encodeText(text: string, format: TextFormat): EncodedText {
  const body = format.eol === '\n' ? text : text.replace(/\n/g, format.eol)
  const saved: TextFormat = { ...format, mixedEol: false }
  const notices: string[] = []
  if (format.mixedEol) {
    notices.push(`Mixed line endings were normalized to ${format.eol === '\r\n' ? 'CRLF' : format.eol === '\r' ? 'CR' : 'LF'}.`)
  }

  let bytes: Uint8Array
  switch (format.encoding) {
    case 'utf-8':
      bytes = new TextEncoder().encode(body)
      break
    case 'utf-8-bom':
      bytes = concat(UTF8_BOM, new TextEncoder().encode(body))
      break
    case 'utf-16le':
      bytes = concat([0xff, 0xfe], encodeUtf16(body, false))
      break
    case 'utf-16be':
      bytes = concat([0xfe, 0xff], encodeUtf16(body, true))
      break
    case 'windows-1252': {
      const encoded = encodeCp1252(body)
      if (encoded) {
        bytes = encoded
      } else {
        bytes = new TextEncoder().encode(body)
        saved.encoding = 'utf-8'
        notices.push('The text contains characters that Windows-1252 cannot store, so the file was saved as UTF-8.')
      }
      break
    }
  }
  return { bytes, format: saved, notice: notices.length > 0 ? notices.join(' ') : null }
}
