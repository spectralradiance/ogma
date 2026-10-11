import { useState } from 'react'

import { outlineMarkdown } from '../../shared/outline'
import type { Heading } from '../../shared/text'
import type { Outline } from './useOutline'

interface OutlinePanelProps {
  outline: Outline | null
  onReveal: (path: string, line: number) => void
}

function HeadingList({ headings, path, onReveal }: { headings: Heading[]; path: string; onReveal: OutlinePanelProps['onReveal'] }) {
  if (headings.length === 0) return null
  const top = Math.min(...headings.map((heading) => heading.level))
  return (
    <ul className="outline-headings">
      {headings.map((heading) => (
        <li key={`${heading.line}:${heading.text}`}>
          <button
            type="button"
            className="outline-heading"
            style={{ paddingLeft: `${22 + (heading.level - top) * 12}px` }}
            onClick={() => onReveal(path, heading.line)}
            title={heading.text}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The document's structure: each # section in order, its size, and the headings inside it. */
export function OutlinePanel({ outline, onReveal }: OutlinePanelProps) {
  const [copied, setCopied] = useState(false)

  if (!outline) return <p className="sidebar-empty">Open a document to see its outline.</p>

  const titled = outline.sections.filter((section) => section.title !== null)
  const outputWords = outline.sections.reduce((sum, section) => sum + section.outputWords, 0)
  const notesWords = outline.sections.reduce((sum, section) => sum + section.notesWords, 0)
  const largest = Math.max(1, ...titled.map((section) => section.outputWords))
  const copy = () => {
    void navigator.clipboard.writeText(outlineMarkdown(outline.title, outline.sections)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="outline-panel">
      <header className="outline-head">
        <div className="outline-title">{outline.title}</div>
        <div className="outline-totals">
          {titled.length} {titled.length === 1 ? 'section' : 'sections'} · {outputWords.toLocaleString()} words
          {notesWords > 0 && <> · {notesWords.toLocaleString()} in notes</>}
        </div>
        {titled.length > 0 && (
          <div className="outline-controls">
            <button type="button" className="link-button" onClick={copy} title="Copy the outline as a Markdown list">{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </header>
      {titled.length === 0
        ? <p className="sidebar-empty">No sections yet. Each line starting with # starts a section.</p>
        : (
          <ol className="outline-sections">
            {titled.map((section) => (
              <li key={`${section.line}:${section.title}`}>
                <button type="button" className="outline-section" onClick={() => onReveal(outline.path, section.line)}
                  title={`${section.outputWords.toLocaleString()} words, ${section.notesWords.toLocaleString()} in notes`}>
                  <span className="outline-section-title">{section.title}</span>
                  <span className="outline-words">{section.outputWords.toLocaleString()}</span>
                  <span className="outline-bar" aria-hidden="true">
                    <span style={{ width: `${(section.outputWords / largest) * 100}%` }} />
                  </span>
                </button>
                <HeadingList headings={section.headings} path={outline.path} onReveal={onReveal} />
              </li>
            ))}
          </ol>
        )}
    </div>
  )
}
