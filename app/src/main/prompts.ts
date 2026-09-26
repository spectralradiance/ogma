import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AiMessage, AiRunRequest } from '../shared/ai'

/**
 * Prompt templates are Markdown files the user can edit, one per task, copied
 * from these defaults on first use. A template is the system prompt, then a
 * line "=== user ===", then the user message. {{name}} placeholders are filled
 * from the run's variables; unknown names become empty.
 */

const USER_MARKER = /^=== user ===\s*$/m

export const DEFAULT_PROMPTS: Record<AiRunRequest['task'], string> = {
  synthesize: `You help a writer turn working notes into finished prose. The writer keeps two files per section: notes (the background: fragments, facts, questions, TODOs) and output (the foreground: the finished text).

Write the complete output for the section in Markdown, in the writer's own voice as shown in their existing output and the document outline. Use every idea in the notes that belongs in finished text; drop TODOs, questions to self and anything the notes mark as uncertain unless the notes resolve it. Keep what already works in the current output rather than rewriting it for its own sake. Do not add facts that are not in the notes or outline.

Reply with the section's output text only — no preamble, no commentary, no code fences, and no heading for the section's title (the app adds that).

=== user ===
Document: {{document}}
Section: {{section}}

## Document notes (outline, sources)
{{documentNotes}}

## Section notes
{{notes}}

## Current output (may be empty)
{{output}}
`,
  analyze: `You are a careful editor. Give the writer specific, practical feedback on the passage: tone, structure, clarity and readability, and style (rhythm, repetition, word choice). Quote short phrases when pointing at something. Say what works as well as what to change. Do not rewrite the whole passage.

Measured figures for the passage are included; use them where they help, but do not just repeat them.

Reply in Markdown with the headings: Tone, Structure, Readability, Style, and Suggestions (a short bulleted list, most useful first).

=== user ===
Document: {{document}}
{{section}}

Measured: {{metrics}}

## Passage
{{text}}
`,
  lexical: `You suggest alternative words for a writer. Given a word and the sentence it appears in, suggest replacements that fit that sentence's meaning, register and rhythm. {{instruction}}

Reply with 6 to 10 options, one per line, in the form: word — a few words on how it differs. No numbering, no other text.

=== user ===
Word: {{word}}
Sentence: {{sentence}}
Paragraph: {{paragraph}}
`,
  structure: `You are a structural editor. The writer keeps a piece as a sequence of sections; each section has notes (the background) and output (the finished text). You are given the outline of the whole piece: every section in order with its size, its opening line, and the headings inside it.

Comment on the organization, not the sentences: the order and flow of the sections, their balance (sizes relative to their importance), gaps or missing steps, repetition or overlap between sections, sections that could be merged or split, the consistency of titles and headings, and which sections still have only notes. Refer to sections by number and title. Be concrete and brief.

Reply in Markdown with the headings: Overview, Order and flow, Balance, Gaps and overlaps, Headings, and Suggestions (a short bulleted list, most useful first).

=== user ===
Document: {{document}}

## Outline
{{outline}}
`,
  test: `Reply with the single word OK.

=== user ===
Connection test.
`,
}

export function renderTemplate(template: string, variables: Record<string, string>): { system: string; messages: AiMessage[] } {
  const fill = (text: string) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => variables[name] ?? '').trim()
  const [system, user] = USER_MARKER.test(template) ? template.split(USER_MARKER) : ['', template]
  return { system: fill(system), messages: [{ role: 'user', content: fill(user ?? '') }] }
}

export class PromptStore {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get location(): string {
    return this.directory
  }

  /** Writes any missing default templates so they can be edited; never overwrites the user's. */
  async ensureDefaults(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    for (const [task, template] of Object.entries(DEFAULT_PROMPTS)) {
      await writeFile(path.join(this.directory, `${task}.md`), template, { flag: 'wx' }).catch(() => {})
    }
  }

  async template(task: AiRunRequest['task']): Promise<string> {
    try {
      const text = await readFile(path.join(this.directory, `${task}.md`), 'utf8')
      if (text.trim()) return text
    } catch {
      // fall back to the built-in default
    }
    return DEFAULT_PROMPTS[task]
  }
}
