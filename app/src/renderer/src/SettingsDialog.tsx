import { useState } from 'react'

import {
  type Appearance, type ExportPreferences, type FontChoice, PALETTES, type Preferences, SOURCE_FONTS, TEXT_FONTS, type ThemeChoice,
} from '../../shared/preferences'
import { X } from 'lucide-react'

import { Modal } from './Modal'

type Tab = 'appearance' | 'export'

interface SettingsDialogProps {
  preferences: Preferences
  onChange: (preferences: Preferences) => void
  onClose: () => void
  /** The open document's title, or null when nothing is open to export. */
  exportTitle: string | null
  onExport: () => void
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Match Windows' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

/** A preset list plus "Other…", which takes any installed font's name. */
function FontPicker({ value, fonts, onChange, sample }: { value: string; fonts: FontChoice[]; onChange: (value: string) => void; sample?: boolean }) {
  const preset = fonts.find((font) => font.value === value)
  const [custom, setCustom] = useState(preset ? '' : value.split(',')[0].replace(/['"]/g, '').trim())
  const [other, setOther] = useState(!preset)
  return (
    <span className="font-picker">
      <select
        value={other ? '__other' : value}
        onChange={(event) => {
          if (event.target.value === '__other') {
            setOther(true)
            return
          }
          setOther(false)
          onChange(event.target.value)
        }}
      >
        {fonts.map((font) => <option key={font.label} value={font.value}>{font.label}</option>)}
        <option value="__other">Other…</option>
      </select>
      {other && (
        <input
          value={custom}
          placeholder="Installed font name, e.g. Iowan Old Style"
          onChange={(event) => setCustom(event.target.value)}
          onBlur={() => custom.trim() && onChange(`'${custom.trim().replace(/['"]/g, '')}', serif`)}
          onKeyDown={(event) => { if (event.key === 'Enter' && custom.trim()) onChange(`'${custom.trim().replace(/['"]/g, '')}', serif`) }}
        />
      )}
      {sample && <span className="font-sample" style={{ fontFamily: value }}>The night sky, Ogma</span>}
    </span>
  )
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void
}) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="settings-value">{Math.round(value * 100) / 100}{unit}</span>
    </label>
  )
}

/** App settings: appearance (color scheme, fonts, text size and width) and export defaults. */
export function SettingsDialog({ preferences, onChange, onClose, exportTitle, onExport }: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('appearance')

  const appearance = (patch: Partial<Appearance>) => onChange({ ...preferences, appearance: { ...preferences.appearance, ...patch } })
  const exporting = (patch: Partial<ExportPreferences>) => onChange({ ...preferences, export: { ...preferences.export, ...patch } })
  const a = preferences.appearance
  const e = preferences.export

  return (
    <Modal label="Settings" className="settings" onClose={onClose}>
      <header className="modal-header">
        <h2>Settings</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <nav className="lexical-tabs" role="tablist">
        {(['appearance', 'export'] as Tab[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {{ appearance: 'Appearance', export: 'Export' }[id]}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === 'appearance' && (
          <div className="settings-section">
            <div className="settings-row">
              <span className="settings-label">Color scheme</span>
              <div className="segmented" role="group" aria-label="Color scheme">
                {THEMES.map((theme) => (
                  <button key={theme.id} type="button" aria-pressed={a.theme === theme.id} onClick={() => appearance({ theme: theme.id })}>{theme.label}</button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Palette</span>
              <div className="palette-picker" role="group" aria-label="Palette">
                {PALETTES.map((palette) => (
                  <button key={palette.id} type="button" className="palette-card" aria-pressed={a.palette === palette.id} onClick={() => appearance({ palette: palette.id })}>
                    <span className="palette-swatch" aria-hidden="true">
                      {([palette.light, palette.dark] as const).map(([bg, text, accent], index) => (
                        <span key={index} style={{ background: bg, color: text }}>
                          <i style={{ background: accent }} />Aa
                        </span>
                      ))}
                    </span>
                    {palette.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Text font</span>
              <FontPicker value={a.textFont} fonts={TEXT_FONTS} onChange={(textFont) => appearance({ textFont })} sample />
            </div>
            <Slider label="Text size" value={a.textSize} min={12} max={28} step={1} unit="px" onChange={(textSize) => appearance({ textSize })} />
            <Slider label="Line spacing" value={a.lineHeight} min={1.2} max={2.4} step={0.05} unit="" onChange={(lineHeight) => appearance({ lineHeight })} />
            <Slider label="Column width" value={a.textWidth} min={480} max={1400} step={20} unit="px" onChange={(textWidth) => appearance({ textWidth })} />
            <div className="settings-row">
              <span className="settings-label">Source mode font</span>
              <FontPicker value={a.sourceFont} fonts={SOURCE_FONTS} onChange={(sourceFont) => appearance({ sourceFont })} />
            </div>
            <p className="lexical-hint">Column width applies to the Column, Output and Notes views. Changes apply as you make them.</p>
          </div>
        )}
        {tab === 'export' && (
          <div className="settings-section">
            <div className="settings-row">
              <span className="settings-label">Export</span>
              <button type="button" className="primary" disabled={exportTitle === null} onClick={onExport}>
                {exportTitle === null ? 'Open a document to export it' : `Export ${exportTitle}…`}
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-label">Default format</span>
              <div className="segmented" role="group" aria-label="Default format">
                {(['pdf', 'html', 'md'] as const).map((format) => (
                  <button key={format} type="button" aria-pressed={e.format === format} onClick={() => exporting({ format })}>
                    {{ pdf: 'PDF', html: 'HTML', md: 'Markdown' }[format]}
                  </button>
                ))}
              </div>
            </div>
            <label className="settings-row">
              <span className="settings-label">Document title</span>
              <span><input type="checkbox" checked={e.includeTitle} onChange={(event) => exporting({ includeTitle: event.target.checked })} /> Start exports with the document title</span>
            </label>
            <div className="settings-row">
              <span className="settings-label">Font</span>
              <FontPicker value={e.font} fonts={TEXT_FONTS} onChange={(font) => exporting({ font })} sample />
            </div>
            <Slider label="Font size" value={e.fontSize} min={8} max={24} step={0.5} unit="pt" onChange={(fontSize) => exporting({ fontSize })} />
            <Slider label="Line spacing" value={e.lineHeight} min={1.1} max={2.4} step={0.05} unit="" onChange={(lineHeight) => exporting({ lineHeight })} />
            <div className="settings-row">
              <span className="settings-label">PDF page</span>
              <div className="segmented" role="group" aria-label="Page size">
                {(['A4', 'Letter'] as const).map((pageSize) => (
                  <button key={pageSize} type="button" aria-pressed={e.pageSize === pageSize} onClick={() => exporting({ pageSize })}>{pageSize}</button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="Margins">
                {(['narrow', 'normal', 'wide'] as const).map((margins) => (
                  <button key={margins} type="button" aria-pressed={e.margins === margins} onClick={() => exporting({ margins })}>
                    {margins[0].toUpperCase() + margins.slice(1)} margins
                  </button>
                ))}
              </div>
            </div>
            <p className="lexical-hint">Font and spacing apply to PDF and HTML; page size and margins to PDF. Markdown exports are plain text.</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
