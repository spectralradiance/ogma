// App-wide preferences edited in the Settings dialog: appearance and export defaults.

export type ThemeChoice = 'system' | 'light' | 'dark'

export interface FontChoice {
  label: string
  /** A CSS font-family list. */
  value: string
}

export const TEXT_FONTS: FontChoice[] = [
  { label: 'Source Serif', value: "'Source Serif 4', Georgia, serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Palatino', value: "'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
  { label: 'Cambria', value: 'Cambria, Georgia, serif' },
  { label: 'Garamond', value: "Garamond, 'EB Garamond', Georgia, serif" },
  { label: 'Segoe UI', value: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Calibri', value: "Calibri, 'Segoe UI', sans-serif" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono', Consolas, monospace" },
]

export const SOURCE_FONTS: FontChoice[] = [
  { label: 'Cascadia Mono', value: "'Cascadia Mono', Consolas, monospace" },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Courier New', value: "'Courier New', monospace" },
  { label: 'Same as text', value: 'var(--font-serif)' },
]

export interface Appearance {
  theme: ThemeChoice
  /** Font for writing (live view) and section titles. */
  textFont: string
  /** Pixels. */
  textSize: number
  lineHeight: number
  /** Widest a single column of text gets, in pixels. */
  textWidth: number
  /** Font for Source mode. */
  sourceFont: string
}

export type PageSize = 'A4' | 'Letter'
export type Margins = 'narrow' | 'normal' | 'wide'

export interface ExportPreferences {
  format: 'pdf' | 'html' | 'md'
  includeTitle: boolean
  font: string
  /** Points. */
  fontSize: number
  lineHeight: number
  pageSize: PageSize
  margins: Margins
}

export interface Preferences {
  appearance: Appearance
  export: ExportPreferences
}

export const DEFAULT_PREFERENCES: Preferences = {
  appearance: {
    theme: 'system',
    textFont: TEXT_FONTS[0].value,
    textSize: 17,
    lineHeight: 1.75,
    textWidth: 820,
    sourceFont: SOURCE_FONTS[0].value,
  },
  export: {
    format: 'pdf',
    includeTitle: true,
    font: 'Georgia, serif',
    fontSize: 12,
    lineHeight: 1.6,
    pageSize: 'A4',
    margins: 'normal',
  },
}

/** Page margins in inches, as Electron's printToPDF takes them. */
export const MARGIN_INCHES: Record<Margins, number> = { narrow: 0.5, normal: 0.9, wide: 1.25 }

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

// A font-family list can come from the user; keep it to characters a list needs, so it cannot break out of CSS.
const fontList = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() && /^[\p{L}\p{N} ,'"().-]+$/u.test(value) && value.length <= 200 ? value.trim() : fallback

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback

export function normalizePreferences(raw: unknown): Preferences {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as { appearance?: Partial<Appearance>; export?: Partial<ExportPreferences> }
  const a = value.appearance ?? {}
  const e = value.export ?? {}
  const da = DEFAULT_PREFERENCES.appearance
  const de = DEFAULT_PREFERENCES.export
  return {
    appearance: {
      theme: oneOf(a.theme, ['system', 'light', 'dark'], da.theme),
      textFont: fontList(a.textFont, da.textFont),
      textSize: clamp(a.textSize, 12, 28, da.textSize),
      lineHeight: clamp(a.lineHeight, 1.2, 2.4, da.lineHeight),
      textWidth: clamp(a.textWidth, 480, 1400, da.textWidth),
      sourceFont: a.sourceFont === 'var(--font-serif)' ? a.sourceFont : fontList(a.sourceFont, da.sourceFont),
    },
    export: {
      format: oneOf(e.format, ['pdf', 'html', 'md'], de.format),
      includeTitle: typeof e.includeTitle === 'boolean' ? e.includeTitle : de.includeTitle,
      font: fontList(e.font, de.font),
      fontSize: clamp(e.fontSize, 8, 24, de.fontSize),
      lineHeight: clamp(e.lineHeight, 1.1, 2.4, de.lineHeight),
      pageSize: oneOf(e.pageSize, ['A4', 'Letter'], de.pageSize),
      margins: oneOf(e.margins, ['narrow', 'normal', 'wide'], de.margins),
    },
  }
}
