import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { DailyWords, DocumentStats } from '../shared/ipc'
import { hasNotes, splitWordCounts } from '../shared/document'
import { countWords } from '../shared/text'
import { readTextDocument } from './fileService'
import { parseFileName, parseOrdinal } from './sections'
import { readFolder } from './workspaceService'

interface StatsFile {
  /** Net words changed per local day, split by role. */
  days: Record<string, { notes: number; output: number }>
  /** Output word goal per document folder (lower-cased path on Windows). */
  goals: Record<string, number>
}

export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function roleOf(file: string): 'notes' | 'output' {
  return parseFileName(path.basename(file)).role === 'output' ? 'output' : 'notes'
}

/**
 * Whether a file keeps its notes inline (a single-file document): a plain Markdown
 * file that is not numbered like a section, or any file that has notes blocks.
 * Its words are split by those blocks instead of by the file's name.
 */
export function usesInlineNotes(file: string, ...texts: (string | null)[]): boolean {
  const { stem, role } = parseFileName(path.basename(file))
  if (role !== 'plain') return false
  if (texts.some((text) => text !== null && hasNotes(text))) return true
  return /\.md$/i.test(file) && parseOrdinal(stem).ordinal === null
}

/** Writing statistics in <userData>/stats.json: words written per day and per-document goals. */
export class WritingStats {
  private readonly file: string
  private readonly now: () => Date
  private data: StatsFile

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file
    this.now = now
    this.data = this.load()
  }

  /** Records the net change in words from one save. */
  recordSave(file: string, before: string | null, after: string): void {
    const day = localDay(this.now())
    const entry = this.data.days[day] ?? { notes: 0, output: 0 }
    if (usesInlineNotes(file, before, after)) {
      const was = before === null ? { output: 0, notes: 0 } : splitWordCounts(before)
      const now = splitWordCounts(after)
      if (now.output === was.output && now.notes === was.notes) return
      entry.output += now.output - was.output
      entry.notes += now.notes - was.notes
    } else {
      const change = countWords(after) - (before === null ? 0 : countWords(before))
      if (change === 0) return
      entry[roleOf(file)] += change
    }
    this.data.days[day] = entry
    this.save()
  }

  daily(count = 14): DailyWords[] {
    const result: DailyWords[] = []
    const today = this.now()
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
      const day = localDay(date)
      result.push({ day, ...(this.data.days[day] ?? { notes: 0, output: 0 }) })
    }
    return result
  }

  goal(folder: string): number | null {
    return this.data.goals[key(folder)] ?? null
  }

  setGoal(folder: string, words: number | null): void {
    if (words && words > 0) this.data.goals[key(folder)] = Math.round(words)
    else delete this.data.goals[key(folder)]
    this.save()
  }

  async documentStats(folder: string): Promise<DocumentStats> {
    const model = await readFolder(folder)
    const words = async (name: string | null) => {
      if (!name) return { words: 0, modified: null as string | null }
      const target = path.join(folder, name)
      const [document, info] = await Promise.all([readTextDocument(target, true), stat(target).catch(() => null)])
      return { words: countWords(document.text), modified: info ? info.mtime.toISOString() : null }
    }
    const sections = await Promise.all(model.sections.map(async (section) => {
      const [notes, output] = await Promise.all([words(section.notes), words(section.output)])
      return {
        stem: section.stem,
        ordinal: section.ordinal,
        title: section.title,
        notesWords: notes.words,
        outputWords: output.words,
        modified: [notes.modified, output.modified].filter(Boolean).sort().at(-1) ?? null,
      }
    }))
    return {
      sections,
      notesWords: sections.reduce((sum, section) => sum + section.notesWords, 0),
      outputWords: sections.reduce((sum, section) => sum + section.outputWords, 0),
      goal: this.goal(folder),
    }
  }

  private load(): StatsFile {
    if (!existsSync(this.file)) return { days: {}, goals: {} }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StatsFile>
      return { days: raw.days ?? {}, goals: raw.goals ?? {} }
    } catch {
      return { days: {}, goals: {} }
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(`${this.file}.tmp`, this.file)
  }
}

function key(folder: string): string {
  const resolved = path.resolve(folder)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
