import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Settings {
  workspaceRoots: string[]
}

export function parseSettings(raw: unknown): Settings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const roots = Array.isArray(value.workspaceRoots)
    ? value.workspaceRoots.filter((root): root is string => typeof root === 'string' && root.length > 0)
    : []
  return { workspaceRoots: roots }
}

/** App settings in <userData>/settings.json, written atomically. */
export class SettingsStore {
  private readonly path: string
  private settings: Settings

  constructor(path: string) {
    this.path = path
    this.settings = this.load()
  }

  get(): Settings {
    return this.settings
  }

  update(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    this.save()
    return this.settings
  }

  private load(): Settings {
    if (!existsSync(this.path)) return parseSettings({})
    try {
      return parseSettings(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      // Keep the unreadable file for inspection instead of overwriting it on the next save.
      renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      return parseSettings({})
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.settings, null, 2), 'utf8')
    renameSync(temporary, this.path)
  }
}
