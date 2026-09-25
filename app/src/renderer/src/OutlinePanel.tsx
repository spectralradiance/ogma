import { useState } from 'react'

import { outlineMarkdown, sectionHeadings } from '../../shared/outline'
import { samePath } from '../../shared/paths'
import type { Heading } from '../../shared/text'
import { readPref, writePref } from './prefs'
import type { Outline } from './useOutline'

interface OutlinePanelProps {
  outline: Outline | null
  /** The editor last typed in, to highlight its section. */
  activePath: string | null
  onOpenSection: (stem: string) => void
  onReveal: (path: string, line: number) => void
}

function HeadingList({ headings, path, notes, onReveal }: { headings: Heading[]; path: string; notes?: boolean; onReveal: OutlinePanelProps['onReveal'] }) {
  if (headings.length === 0) return null
  const top = Math.min(...headings.map((heading) => heading.level))
  return (
    <ul className="outline-headings">
      {headings.map((heading) => (
        <li key={`${heading.line}:${heading.text}`}>
          <button
            type="button"
            className={`outline-heading${notes ? ' outline-heading-notes' : ''}`}
            style={{ paddingLeft: `${22 + (heading.level - top) * 12}px` }}
            onClick={() => onReveal(path, heading.line)}
            title={notes ? `${heading.text} (notes)` : heading.text}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The whole document's structure: every section in order, its size, and the headings inside it. */
export function OutlinePanel({ outline, activePath, onOpenSection, onReveal }: OutlinePanelProps) {
  const [showNotes, setShowNotes] = useState(() => readPref('outlineNotes') === 'true')
  const [copied, setCopied] = useState(false)

  if (!outline) return <p className="sidebar-empty">Open a document to see its outline.</p>

  if (outline.kind === 'file') {
    return (
      <div className="outline-panel">
        <header className="outline-head">
          <div className="outline-title">{outline.title}</div>
          <div className="outline-totals">{outline.file.words.toLocaleString()} words · {outline.file.headings.length} headings</div>
        </header>
        {outline.file.headings.length === 0
          ? <p className="sidebar-empty">No headings yet. Lines starting with # become headings.</p>
          : <HeadingList headings={outline.file.headings} path={outline.path} onReveal={onReveal} />}
      </div>
    )
  }

  const { sections } = outline
  const outputWords = sections.reduce((sum, section) => sum + section.output.words, 0)
  const notesWords = sections.reduce((sum, section) => sum + section.notes.words, 0)
  const largest = Math.max(1, ...sections.map((section) => section.output.words))
  const missing = sections.filter((section) => !section.output.exists).length

  const toggleNotes = () => {
    writePref('outlineNotes', String(!showNotes))
    setShowNotes(!showNotes)
  }
  const copy = () => {
    void navigator.clipboard.writeText(outlineMarkdown(outline.title, sections, { notes: showNotes, leads: false })).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="outline-panel">
      <header className="outline-head">
        <div className="outline-title">{outline.title}</div>
        <div className="outline-totals">
          {sections.length} {sections.length === 1 ? 'section' : 'sections'} · {outputWords.toLocaleString()} words output · {notesWords.toLocaleString()} notes
          {missing > 0 && <> · <span className="outline-missing">{missing} without output</span></>}
        </div>
        <div className="outline-controls">
          <label title="Also list the headings inside each section’s notes">
            <input type="checkbox" checked={showNotes} onChange={toggleNotes} /> Notes headings
          </label>
          <button type="button" className="link-button" onClick={copy} title="Copy the outline as a Markdown list">{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </header>
      <ol className="outline-sections">
        {sections.map((section) => {
          const active = activePath !== null && (samePath(activePath, section.notesPath) || samePath(activePath, section.outputPath))
          const size = section.output.exists
            ? `${section.output.words.toLocaleString()} words of output, ${section.notes.words.toLocaleString()} of notes`
            : `No output yet; ${section.notes.words.toLocaleString()} words of notes`
          return (
            <li key={section.stem} className={active ? 'active' : undefined}>
              <button type="button" className="outline-section" onClick={() => onOpenSection(section.stem)} title={size}>
                {section.ordinal && <span className="tree-ordinal">{section.ordinal}</span>}
                <span className="outline-section-title">{section.title}</span>
                <span className={`outline-words${section.output.exists ? '' : ' outline-missing'}`}>
                  {section.output.exists ? section.output.words.toLocaleString() : 'notes only'}
                </span>
                <span className="outline-bar" aria-hidden="true">
                  <span style={{ width: `${(section.output.words / largest) * 100}%` }} />
                </span>
              </button>
              <HeadingList headings={sectionHeadings(section.title, section.output)} path={section.outputPath} onReveal={onReveal} />
              {showNotes && <HeadingList headings={sectionHeadings(section.title, section.notes)} path={section.notesPath} notes onReveal={onReveal} />}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
