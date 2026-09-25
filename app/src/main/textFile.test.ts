import { describe, expect, it } from 'vitest'

import type { TextFormat } from '../shared/ipc'
import { BinaryFileError, decodeText, detectLineEndings, encodeText } from './textFile'

function roundTrip(bytes: Uint8Array): Uint8Array {
  const decoded = decodeText(bytes)
  return encodeText(decoded.text, decoded.format).bytes
}

const utf8 = (text: string) => new TextEncoder().encode(text)

describe('decodeText / encodeText round trip', () => {
  const cases: Record<string, Uint8Array> = {
    'UTF-8 with LF': utf8('# Title\n\nŌisín — café\n'),
    'UTF-8 with CRLF': utf8('line one\r\nline two\r\n'),
    'UTF-8 with BOM': Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('bom text\r\n')]),
    'cp1252 smart quotes': Uint8Array.from([0x49, 0x92, 0x6d, 0x20, 0xe9, 0x0d, 0x0a, 0x93, 0x78, 0x94]),
    'cp1252 undefined bytes': Uint8Array.from([0x41, 0x81, 0x8d, 0x8f, 0x90, 0x9d]),
    'UTF-16 LE with BOM': Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x0d, 0x00, 0x0a, 0x00]),
    'UTF-16 BE with BOM': Uint8Array.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]),
    'empty file': new Uint8Array(),
    'no trailing newline': utf8('last line'),
  }

  for (const [name, bytes] of Object.entries(cases)) {
    it(`is byte-identical for ${name}`, () => {
      expect(Buffer.from(roundTrip(bytes)).equals(Buffer.from(bytes))).toBe(true)
    })
  }
})

describe('decodeText', () => {
  it('normalizes line breaks for the editor and records the original', () => {
    const decoded = decodeText(utf8('a\r\nb\r\n'))
    expect(decoded.text).toBe('a\nb\n')
    expect(decoded.format).toEqual({ encoding: 'utf-8', eol: '\r\n', mixedEol: false })
  })

  it('falls back to windows-1252 for invalid UTF-8', () => {
    const decoded = decodeText(Uint8Array.from([0x49, 0x92, 0x6d]))
    expect(decoded.text).toBe('I’m')
    expect(decoded.format.encoding).toBe('windows-1252')
  })

  it('refuses binary files', () => {
    expect(() => decodeText(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toThrow(BinaryFileError)
  })
})

describe('encodeText', () => {
  it('writes edits back with the original line ending', () => {
    const format: TextFormat = { encoding: 'utf-8', eol: '\r\n', mixedEol: false }
    expect(new TextDecoder().decode(encodeText('a\nb\n', format).bytes)).toBe('a\r\nb\r\n')
  })

  it('upgrades cp1252 to UTF-8 when a character cannot be stored, and says so', () => {
    const format: TextFormat = { encoding: 'windows-1252', eol: '\n', mixedEol: false }
    const encoded = encodeText('ōm', format)
    expect(encoded.format.encoding).toBe('utf-8')
    expect(new TextDecoder().decode(encoded.bytes)).toBe('ōm')
    expect(encoded.notice).toMatch(/UTF-8/)
  })

  it('normalizes mixed line endings to the dominant one and reports it', () => {
    const decoded = decodeText(utf8('a\r\nb\r\nc\n'))
    expect(decoded.format).toMatchObject({ eol: '\r\n', mixedEol: true })
    const encoded = encodeText(decoded.text, decoded.format)
    expect(new TextDecoder().decode(encoded.bytes)).toBe('a\r\nb\r\nc\r\n')
    expect(encoded.format.mixedEol).toBe(false)
    expect(encoded.notice).toMatch(/CRLF/)
  })
})

describe('detectLineEndings', () => {
  it('defaults to LF for single-line text', () => {
    expect(detectLineEndings('no breaks')).toEqual({ eol: '\n', mixed: false })
  })
})
