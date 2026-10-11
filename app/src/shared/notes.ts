// Notes inside a single-file document: a Pandoc-style fenced div that opens with
// `::: notes` and closes with `:::`. Everything else is the output (the text itself).

export type LineRole = 'output' | 'notes' | 'open' | 'close'

const OPEN = /^[ \t]{0,3}:{3,}[ \t]*notes[ \t]*$/i
const CLOSE = /^[ \t]{0,3}:{3,}[ \t]*$/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

export const NOTES_OPEN_LINE = '::: notes'
export const NOTES_CLOSE_LINE = ':::'

/**
 * Classifies each line as output, a notes marker or notes text. A block that is
 * never closed runs to the end of the text, so notes being typed still look like
 * notes. Fenced code blocks are respected: a `::: notes` line inside one is code,
 * and a `:::` inside code within notes does not end the block.
 */
export function classifyLines(lines: readonly string[]): LineRole[] {
  const roles: LineRole[] = []
  let inNotes = false
  let fence: string | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      roles.push(inNotes ? 'notes' : 'output')
    } else if (fence !== null) {
      roles.push(inNotes ? 'notes' : 'output')
    } else if (!inNotes && OPEN.test(line)) {
      inNotes = true
      roles.push('open')
    } else if (inNotes && CLOSE.test(line)) {
      inNotes = false
      roles.push('close')
    } else {
      roles.push(inNotes ? 'notes' : 'output')
    }
  }
  return roles
}

/** The text without its notes blocks, and without the blank lines they leave behind. */
export function stripNotes(text: string): string {
  if (!/^[ \t]{0,3}:{3,}[ \t]*notes/im.test(text)) return text
  const lines = text.split('\n')
  const roles = classifyLines(lines)
  const kept: string[] = []
  lines.forEach((line, index) => {
    if (roles[index] === 'output') {
      kept.push(line)
    } else if (roles[index] === 'close' && kept.length > 0 && kept.at(-1)!.trim() === '') {
      kept.pop() // the blank line that separated the block from the text before it
    }
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}
