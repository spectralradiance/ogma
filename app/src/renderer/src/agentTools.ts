import type { AiToolSpec } from '../../shared/ai'
import { MATCH_END, MATCH_START, type SearchHit } from '../../shared/ipc'
import { samePath } from '../../shared/paths'
import { countWords } from '../../shared/text'

/**
 * The agent's tools. The model asks for them by name; the chat runs them here,
 * against the editors that are open, and sends the results back. Reading is
 * free; the only write is suggest_edit, which never changes text directly — it
 * becomes a suggestion in the editor for the writer to accept or reject.
 */

/** What the agent can reach, supplied by the app. */
export interface AgentHost {
  /** Files open in editors; their text includes unsaved edits. */
  openFiles(): { path: string; focused: boolean; text: string }[]
  /** A file's text: from its editor when open, else from disk (workspace files only). */
  read(path: string): Promise<string | null>
  /** The open document's outline as Markdown, or null when none is open. */
  outline(): string | null
  search(query: string): Promise<SearchHit[]>
  suggestEdit(path: string, oldText: string, newText: string, label: string, snapshot: boolean): { count: number } | { error: string }
}

export const AGENT_TOOLS: AiToolSpec[] = [
  {
    name: 'list_open_files',
    description: 'Lists the files open in the editor (the writer is looking at these), with word counts and which one has focus. Start here.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Reads a file\'s text, including edits the writer has not saved. Long files come back in parts: pass start_line to continue. Suggestions you made that are still waiting are not included.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path, as list_open_files or search_workspace gives it.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Defaults to 1.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_outline',
    description: 'The open document\'s outline: every section in order with its size, opening line and headings, and which sections still have only notes.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_workspace',
    description: 'Full-text search across every text file in the writer\'s workspace folders. Returns matching paragraphs with their file and line.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_edit',
    description: 'Suggests replacing old_text with new_text in an open file. It appears in the editor as a suggestion the writer accepts or rejects; the file does not change until then. old_text must match the file exactly and appear only once; use an empty old_text only for an empty file. A new suggestion on the same passage replaces your earlier one.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path of an open file.' },
        old_text: { type: 'string', description: 'The exact passage to replace, with enough context to be unique.' },
        new_text: { type: 'string', description: 'The replacement.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
]

/** Lines per read_file call, and a character cap for very long lines. */
const READ_LINES = 400
const READ_CHARS = 40_000
const SEARCH_RESULTS = 20

export interface ToolOutcome {
  content: string
  isError: boolean
  /** One line for the chat, e.g. "Read 02 Stars-output.md". */
  summary: string
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path
const fail = (summary: string, content: string): ToolOutcome => ({ content, isError: true, summary })

function stringField(input: Record<string, unknown>, name: string, required = true): string | null {
  const value = input[name]
  if (typeof value === 'string') return value
  return required ? null : ''
}

/** One agent run's tools: remembers which files already have a "Before AI" version. */
export class AgentToolbox {
  private readonly host: AgentHost
  private readonly label: string
  private readonly snapshotted = new Set<string>()

  constructor(host: AgentHost, label: string) {
    this.host = host
    this.label = label
  }

  async run(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'list_open_files': return this.listOpen()
        case 'read_file': return await this.readFile(input)
        case 'get_outline': return this.outline()
        case 'search_workspace': return await this.search(input)
        case 'suggest_edit': return this.suggestEdit(input)
        default: return fail(`Unknown tool ${name}`, `There is no tool named ${name}.`)
      }
    } catch (error) {
      return fail(`${name} failed`, error instanceof Error ? error.message : String(error))
    }
  }

  private listOpen(): ToolOutcome {
    const files = this.host.openFiles()
    if (!files.length) return { content: 'No files are open.', isError: false, summary: 'Listed open files' }
    const lines = files.map((file) => `${file.path} — ${countWords(file.text)} words${file.focused ? ' (focused)' : ''}`)
    return { content: lines.join('\n'), isError: false, summary: 'Listed open files' }
  }

  private async readFile(input: Record<string, unknown>): Promise<ToolOutcome> {
    const path = stringField(input, 'path')
    if (!path) return fail('Read failed', 'path is required.')
    const text = await this.host.read(path)
    if (text === null) return fail(`Could not read ${fileName(path)}`, `Could not read ${path}. Use a path from list_open_files or search_workspace.`)
    const lines = text.split('\n')
    const start = Math.max(1, Math.floor(Number(input.start_line) || 1))
    if (start > lines.length && lines.length > 0) return fail(`Read ${fileName(path)}`, `The file has only ${lines.length} lines.`)
    let end = Math.min(lines.length, start - 1 + READ_LINES)
    let body = lines.slice(start - 1, end).join('\n')
    if (body.length > READ_CHARS) {
      body = body.slice(0, READ_CHARS)
      end = start - 1 + body.split('\n').length
    }
    const more = end < lines.length ? `\n\n[Lines ${start}–${end} of ${lines.length}. Continue with start_line ${end + 1}.]` : ''
    const header = start > 1 || more ? `[${path}, lines ${start}–${end} of ${lines.length}]\n` : ''
    return { content: header + (body || '(empty file)') + more, isError: false, summary: `Read ${fileName(path)}` }
  }

  private outline(): ToolOutcome {
    const outline = this.host.outline()
    return outline
      ? { content: outline, isError: false, summary: 'Read the outline' }
      : fail('No outline', 'No document of sections is open, so there is no outline.')
  }

  private async search(input: Record<string, unknown>): Promise<ToolOutcome> {
    const query = stringField(input, 'query')?.trim()
    if (!query) return fail('Search failed', 'query is required.')
    const hits = (await this.host.search(query)).slice(0, SEARCH_RESULTS)
    const summary = `Searched “${query}”`
    if (!hits.length) return { content: 'No matches.', isError: false, summary }
    const clean = (snippet: string) => snippet.split(MATCH_START).join('').split(MATCH_END).join('').replace(/\s+/g, ' ').trim()
    return { content: hits.map((hit) => `${hit.path}:${hit.line} — ${clean(hit.snippet)}`).join('\n'), isError: false, summary }
  }

  private suggestEdit(input: Record<string, unknown>): ToolOutcome {
    const path = stringField(input, 'path')
    const oldText = stringField(input, 'old_text')
    const newText = stringField(input, 'new_text')
    if (!path || oldText === null || newText === null) return fail('Edit failed', 'path, old_text and new_text are all required.')
    const open = this.host.openFiles().find((file) => samePath(file.path, path))
    if (!open) return fail(`Could not edit ${fileName(path)}`, `${path} is not open. Only open files can be edited; ask the writer to open it.`)
    const first = !this.snapshotted.has(open.path.toLowerCase())
    const result = this.host.suggestEdit(open.path, oldText, newText, this.label, first)
    if ('error' in result) return fail(`Edit in ${fileName(path)} failed`, result.error)
    if (result.count === 0) return { content: 'new_text is the same as old_text, so nothing was suggested.', isError: false, summary: `No change in ${fileName(path)}` }
    this.snapshotted.add(open.path.toLowerCase())
    return {
      content: `Suggested (${result.count} change${result.count === 1 ? '' : 's'}); waiting for the writer to accept or reject.`,
      isError: false,
      summary: `Suggested an edit in ${fileName(path)}`,
    }
  }
}
