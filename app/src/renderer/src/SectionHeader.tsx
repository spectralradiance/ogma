import { useEffect, useRef, useState } from 'react'

import type { SectionInfo } from '../../shared/ipc'
import type { LeadingHeading } from '../../shared/text'
import { SAVE_LABEL, type SaveState } from './DocumentPane'

export interface PaneState {
  state: SaveState
  exists: boolean
}

export interface SectionLayout {
  hideNotes?: boolean
  hideOutput?: boolean
  /** Show notes before/left of output in this section, reversing the document's order. */
  swapped?: boolean
}

interface SectionHeaderProps {
  section: SectionInfo
  notes: PaneState | undefined
  output: PaneState | undefined
  layout: SectionLayout
  previous: SectionInfo | null
  next: SectionInfo | null
  onLayout: (layout: SectionLayout) => void
  onRename: (title: string) => void
  onMove: (direction: 'up' | 'down') => void
  onMerge: (direction: 'previous' | 'next') => void
  onHistory: (role: 'notes' | 'output') => void
  /** The heading on the output's first line: the section's heading, if it has one. */
  heading: LeadingHeading | null
  onHeading: (on: boolean) => void
  /** Resolve a heading that differs from the file name: rewrite the heading, or rename the files. */
  onMatchHeading: (use: 'title' | 'heading') => void
}

function statusText(pane: PaneState | undefined): string {
  if (!pane) return '—'
  if (!pane.exists && pane.state === 'saved') return 'not created yet'
  return SAVE_LABEL[pane.state]
}

// Case and punctuation differences between file name and heading are not worth flagging.
const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const needsAttention = (pane: PaneState | undefined) => pane !== undefined && pane.state !== 'saved'

/** A section as a single line: title, a rule, and a menu with everything else. */
export function SectionHeader({
  section, notes, output, layout, previous, next, onLayout, onRename, onMove, onMerge, onHistory, heading, onHeading, onMatchHeading,
}: SectionHeaderProps) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(section.title)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  const act = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  const numbered = section.ordinal !== null
  const attention = needsAttention(notes) || needsAttention(output)
  const problem = [notes, output].some((pane) => pane?.state === 'conflict' || pane?.state === 'error')
  // With a heading, the heading is the title readers see; the file name only orders and labels the files.
  const shownTitle = heading?.text ?? section.title
  const mismatch = heading !== null && normalized(heading.text) !== normalized(section.title)

  return (
    <div className={`section-line${heading ? '' : ' no-heading'}`} ref={root}>
      {renaming ? (
        <input
          className="section-rename"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && title.trim()) {
              setRenaming(false)
              if (title.trim() !== section.title || title.trim() !== shownTitle) onRename(title.trim())
            }
            if (event.key === 'Escape') {
              setRenaming(false)
              setTitle(shownTitle)
            }
          }}
          onBlur={() => {
            setRenaming(false)
            setTitle(shownTitle)
          }}
        />
      ) : (
        <h2 className="section-line-title" title={heading ? `Section heading (the output’s first line)` : 'No section heading: the output continues from the previous section'}>
          {section.ordinal && <span className="section-ordinal">{section.ordinal}</span>}
          {shownTitle}
        </h2>
      )}
      {mismatch && !renaming && (
        <span className="section-mismatch" title="The heading and the file name say different things">
          file name: “{section.title}”
          <button type="button" className="link-button" onClick={() => onMatchHeading('title')}>Use file name</button>
          <button type="button" className="link-button" onClick={() => onMatchHeading('heading')}>Rename files</button>
        </span>
      )}
      <hr className="section-line-rule" />
      <button
        type="button"
        className={`icon-button section-menu-button${attention ? ' attention' : ''}${problem ? ' problem' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Section menu for ${section.title}`}
        title={attention ? `Section menu — notes: ${statusText(notes)}, output: ${statusText(output)}` : 'Section menu'}
      >
        ⋯
      </button>
      {open && (
        <div className="section-menu" role="menu">
          <button type="button" role="menuitem" onClick={act(() => { setTitle(shownTitle); setRenaming(true) })}>Edit section title</button>
          <button type="button" role="menuitemcheckbox" aria-checked={heading !== null} onClick={act(() => onHeading(heading === null))}
            title="The title as a heading at the top of the output (its first line), so it appears in exports">
            <span className="menu-check" aria-hidden="true">{heading ? '✓' : ''}</span>Section heading
          </button>
          <div className="menu-separator" />
          <button type="button" role="menuitem" disabled={!numbered || !previous?.ordinal} onClick={act(() => onMove('up'))}>
            Swap with previous section
          </button>
          <button type="button" role="menuitem" disabled={!numbered || !next?.ordinal} onClick={act(() => onMove('down'))}>
            Swap with next section
          </button>
          <button type="button" role="menuitem" disabled={!previous} onClick={act(() => onMerge('previous'))}>
            Merge into previous{previous ? ` (${previous.title})` : ''}…
          </button>
          <button type="button" role="menuitem" disabled={!next} onClick={act(() => onMerge('next'))}>
            Merge next{next ? ` (${next.title})` : ''} into this…
          </button>
          <div className="menu-separator" />
          <button type="button" role="menuitem" onClick={act(() => onLayout({ ...layout, hideOutput: !layout.hideOutput }))}>
            {layout.hideOutput ? 'Show output' : 'Hide output'}
          </button>
          <button type="button" role="menuitem" onClick={act(() => onLayout({ ...layout, hideNotes: !layout.hideNotes }))}>
            {layout.hideNotes ? 'Show notes' : 'Hide notes'}
          </button>
          <button type="button" role="menuitem" onClick={act(() => onLayout({ ...layout, swapped: !layout.swapped }))}>
            Swap output and notes
          </button>
          <div className="menu-separator" />
          <div className="menu-status">
            <span>Output</span><span className={`save-${output?.state ?? 'saved'}`}>{statusText(output)}</span>
            <button type="button" className="link-button" disabled={!output?.exists} onClick={act(() => onHistory('output'))}>History…</button>
          </div>
          <div className="menu-status">
            <span>Notes</span><span className={`save-${notes?.state ?? 'saved'}`}>{statusText(notes)}</span>
            <button type="button" className="link-button" disabled={!notes?.exists} onClick={act(() => onHistory('notes'))}>History…</button>
          </div>
        </div>
      )}
    </div>
  )
}
