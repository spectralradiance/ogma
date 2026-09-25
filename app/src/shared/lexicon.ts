import type { LexiconEntry } from './ipc'

/**
 * Lexicon files are Markdown with a small front-matter block. Values are JSON
 * (strings and string arrays), which is also valid YAML, so the files stay
 * readable and editable in other tools:
 *
 *   ---
 *   word: "melancholy"
 *   tags: ["emotion", "mood"]
 *   ...
 *   ---
 *   Free-form notes.
 */

const FIELDS = ['word', 'definition', 'tags', 'synonyms', 'context', 'source', 'added'] as const

export function serializeLexiconEntry(entry: LexiconEntry): string {
  const lines = FIELDS.map((field) => `${field}: ${JSON.stringify(entry[field] ?? null)}`)
  const note = entry.note.trim()
  return `---\n${lines.join('\n')}\n---\n${note ? `${note}\n` : ''}`
}

function parseValue(raw: string): unknown {
  const value = raw.trim()
  try {
    return JSON.parse(value)
  } catch {
    // Hand-edited YAML: bare strings and [a, b] lists.
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    }
    return value.replace(/^["']|["']$/g, '')
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function parseLexiconFile(content: string): LexiconEntry | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (!match) return null
  const fields: Record<string, unknown> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) fields[line.slice(0, colon).trim()] = parseValue(line.slice(colon + 1))
  }
  const word = text(fields.word).trim()
  if (!word) return null
  return {
    word,
    definition: text(fields.definition),
    tags: strings(fields.tags),
    synonyms: strings(fields.synonyms),
    context: text(fields.context),
    source: text(fields.source) || null,
    added: text(fields.added),
    note: match[2].trim(),
  }
}

/** A safe file name for a word; lexicon words are unique case-insensitively. */
export function lexiconFileName(word: string): string {
  const safe = word.trim().replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '')
  return `${safe || '_'}.md`
}

/** Splits Aisling-style lists ("a, b; c") into items. */
export function splitList(value: string): string[] {
  return [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))]
}

/**
 * Aisling-style search: plain text matches word, definition, tags and synonyms;
 * `word:`, `def:`, `tag:` and `syn:` prefixes restrict to one field. All terms must match.
 */
export function matchesLexiconQuery(entry: LexiconEntry, query: string): boolean {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => {
    const [prefix, ...rest] = term.split(':')
    const value = rest.join(':')
    const has = (items: string[]) => items.some((item) => item.toLocaleLowerCase().includes(value))
    switch (rest.length > 0 ? prefix : '') {
      case 'word':
        return entry.word.toLocaleLowerCase().includes(value)
      case 'def':
      case 'definition':
        return entry.definition.toLocaleLowerCase().includes(value)
      case 'tag':
        return has(entry.tags)
      case 'syn':
      case 'synonym':
        return has(entry.synonyms)
      default:
        return [entry.word, entry.definition, entry.note, ...entry.tags, ...entry.synonyms]
          .some((field) => field.toLocaleLowerCase().includes(term))
    }
  })
}
