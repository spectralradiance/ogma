// App-wide preferences edited in the Settings dialog: appearance and export defaults.

export type ThemeChoice = 'system' | 'light' | 'dark'

/** A named set of colors. The values themselves live in styles.css under `[data-palette]`. */
export const PALETTES = [
  { id: 'ogma', label: 'Ogma', light: ['#f7f6f2', '#1f2421', '#3f6b5a'], dark: ['#1b1d1c', '#e4e6e1', '#8fbfa8'] },
  { id: 'parchment', label: 'Parchment', light: ['#f5eedc', '#3b3226', '#8a5a2b'], dark: ['#1e1a15', '#e8dfcc', '#d9a35f'] },
  { id: 'slate', label: 'Slate', light: ['#eceff4', '#2e3440', '#4a6a9b'], dark: ['#242933', '#e5e9f0', '#88a8d8'] },
  { id: 'mono', label: 'Mono', light: ['#ffffff', '#111111', '#111111'], dark: ['#121212', '#eeeeee', '#eeeeee'] },
] as const

export type PaletteId = (typeof PALETTES)[number]['id']

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
  /** Light, dark, or follow Windows. */
  theme: ThemeChoice
  /** The color palette; each has a light and a dark variant. */
  palette: PaletteId
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
    palette: 'ogma',
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
      palette: oneOf(a.palette, PALETTES.map((palette) => palette.id), da.palette),
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
