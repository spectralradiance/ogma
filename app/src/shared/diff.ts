/**
 * Line diff for reviewing AI drafts. Prose is mostly one paragraph per line,
 * so line hunks read as "this paragraph changed". Each change hunk can be
 * accepted or rejected independently.
 */

export type Hunk =
  | { kind: 'same'; lines: string[] }
  | { kind: 'change'; before: string[]; after: string[] }

export function diffLines(beforeText: string, afterText: string): Hunk[] {
  const before = beforeText === '' ? [] : beforeText.split('\n')
  const after = afterText === '' ? [] : afterText.split('\n')
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
