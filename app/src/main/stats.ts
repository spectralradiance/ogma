import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { DailyWords, DocumentStats } from '../shared/ipc'
import { splitSections, splitWordCounts } from '../shared/document'
import { readTextDocument } from './fileService'

interface StatsFile {
  /** Net words changed per local day: the text itself and its notes blocks. */
  days: Record<string, { notes: number; output: number }>
  /** Output word goal per document file (lower-cased path on Windows). */
  goals: Record<string, number>
}

export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
  recordSave(before: string | null, after: string): void {
    const day = localDay(this.now())
    const entry = this.data.days[day] ?? { notes: 0, output: 0 }
    const was = before === null ? { output: 0, notes: 0 } : splitWordCounts(before)
    const now = splitWordCounts(after)
    if (now.output === was.output && now.notes === was.notes) return
    entry.output += now.output - was.output
    entry.notes += now.notes - was.notes
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

  goal(file: string): number | null {
    return this.data.goals[key(file)] ?? null
  }

  setGoal(file: string, words: number | null): void {
    if (words && words > 0) this.data.goals[key(file)] = Math.round(words)
    else delete this.data.goals[key(file)]
    this.save()
  }

  /** Per-section counts for a document (split at its headings), with its goal. */
  async documentStats(file: string): Promise<DocumentStats> {
    const [document, info] = await Promise.all([readTextDocument(file, true), stat(file).catch(() => null)])
    const sections = splitSections(document.text).map(({ title, line, hasText, notesWords, outputWords }) => ({ title, line, hasText, notesWords, outputWords }))
    return {
      sections,
      notesWords: sections.reduce((sum, section) => sum + section.notesWords, 0),
      outputWords: sections.reduce((sum, section) => sum + section.outputWords, 0),
      modified: info ? info.mtime.toISOString() : null,
      goal: this.goal(file),
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

function key(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
