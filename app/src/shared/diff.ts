/**
 * Line diff for reviewing AI drafts. Prose is mostly one paragraph per line,
 * so line hunks read as "this paragraph changed". Each change hunk can be
 * accepted or rejected independently.
 */

export type Hunk =
  | { kind: 'same'; lines: string[] }
  | { kind: 'change'; before: string[]; after: string[] }

export function diffLines(beforeText: string, afterText: string): Hunk[] {
  return diffSequences(beforeText === '' ? [] : beforeText.split('\n'), afterText === '' ? [] : afterText.split('\n'))
}

function diffSequences(before: readonly string[], after: readonly string[]): Hunk[] {
  const rows = before.length
  const columns = after.length
  // lcs[i][j] = length of the longest common subsequence of before[i..] and after[j..]
  const lcs = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const hunks: Hunk[] = []
  const pushSame = (line: string) => {
    const last = hunks.at(-1)
    if (last?.kind === 'same') last.lines.push(line)
    else hunks.push({ kind: 'same', lines: [line] })
  }
  const pushChange = (side: 'before' | 'after', line: string) => {
    let last = hunks.at(-1)
    if (last?.kind !== 'change') {
      last = { kind: 'change', before: [], after: [] }
      hunks.push(last)
    }
    last[side].push(line)
  }

  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      pushSame(before[i])
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pushChange('before', before[i])
      i += 1
    } else {
      pushChange('after', after[j])
      j += 1
    }
  }
  while (i < rows) pushChange('before', before[i++])
  while (j < columns) pushChange('after', after[j++])
  return hunks
}

/** Rebuilds the text, taking `after` for accepted change hunks and `before` for the rest. */
export function applyHunks(hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const lines: string[] = []
  hunks.forEach((hunk, index) => {
    if (hunk.kind === 'same') lines.push(...hunk.lines)
    else lines.push(...(accepted.has(index) ? hunk.after : hunk.before))
  })
  return lines.join('\n')
}

export function changeIndexes(hunks: Hunk[]): number[] {
  return hunks.flatMap((hunk, index) => (hunk.kind === 'change' ? [index] : []))
}

/** One suggested change: replace before[from, to) with insert. Offsets are into the original text. */
export interface TextEdit {
  from: number
  to: number
  insert: string
}

// Words (with inner apostrophes), runs of whitespace, and single punctuation marks.
const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu
// Above this many token pairs a paragraph is replaced whole rather than diffed word by word.
const MAX_WORD_CELLS = 2_000_000
// Below this share of words in common, a paragraph reads better replaced whole than as confetti.
const MIN_WORD_OVERLAP = 0.4

const tokenize = (text: string) => text.match(TOKEN) ?? []

/**
 * Word-level edits turning `before` into `after`, or one whole replacement when the
 * two have too little in common. Edits separated only by whitespace are merged, so
 * "the quick fox" → "a slow fox" is one change rather than two.
 */
export function diffWords(before: string, after: string): TextEdit[] {
  if (before === after) return []
  const a = tokenize(before)
  const b = tokenize(after)
  const whole = [{ from: 0, to: before.length, insert: after }]
  if (a.length * b.length > MAX_WORD_CELLS) return whole

  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  // Walk the table into edits, tracking character offsets in `before`.
  const edits: TextEdit[] = []
  let shared = 0
  let i = 0
  let j = 0
  let offset = 0
  let open: TextEdit | null = null
  const close = () => {
    if (open) edits.push(open)
    open = null
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close()
      if (/\S/.test(a[i])) shared += 1
      offset += a[i].length
      i += 1
      j += 1
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      open ??= { from: offset, to: offset, insert: '' }
      offset += a[i].length
      open.to = offset
      i += 1
    } else {
      open ??= { from: offset, to: offset, insert: '' }
      open.insert += b[j]
      j += 1
    }
  }
  close()

  const words = Math.max(a.filter((token) => /\S/.test(token)).length, b.filter((token) => /\S/.test(token)).length)
  if (words > 0 && shared / words < MIN_WORD_OVERLAP) return whole

  const merged: TextEdit[] = []
  for (const edit of edits) {
    const last = merged.at(-1)
    const gap = last ? before.slice(last.to, edit.from) : null
    if (last && gap !== null && /^\s*$/.test(gap)) {
      last.insert += gap + edit.insert
      last.to = edit.to
    } else {
      merged.push({ ...edit })
    }
  }
  return merged
}

/**
 * The edits turning `before` into `after`, for showing as suggestions: paragraphs
 * (lines) are matched first, then a changed paragraph is refined word by word.
 * Edits are in order and never overlap.
 */
export function suggestEdits(before: string, after: string): TextEdit[] {
  if (before === after) return []
  // Each line with its own line break (the last has none), so a run of lines is an exact slice of the text.
  const chunks = (text: string) => (text === '' ? [] : text.split('\n').map((line, index, lines) => (index < lines.length - 1 ? `${line}\n` : line)))
  const edits: TextEdit[] = []
  let offset = 0
  for (const hunk of diffSequences(chunks(before), chunks(after))) {
    if (hunk.kind === 'same') {
      offset += hunk.lines.join('').length
      continue
    }
    const removed = hunk.before.join('')
    for (const edit of diffWords(removed, hunk.after.join(''))) edits.push({ from: offset + edit.from, to: offset + edit.to, insert: edit.insert })
    offset += removed.length
  }
  return edits
}

/** Applies non-overlapping edits (in any order) to the text they were computed against. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text
  for (const edit of [...edits].sort((x, y) => y.from - x.from)) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  }
  return result
}
