import { useState } from 'react'

import type { SectionInfo } from '../../shared/ipc'
import type { LeadingHeading } from '../../shared/text'
import { type MenuItem, DropdownMenu } from './menu'
import { SAVE_LABEL, type SaveState } from './DocumentPane'
import { Ellipsis } from 'lucide-react'

export interface PaneState {
  state: SaveState
  exists: boolean
}

export interface SectionLayout {
  hideNotes?: boolean
  hideOutput?: boolean
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
  onDelete: () => void
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
  section, notes, output, layout, previous, next, onLayout, onRename, onMove, onMerge, onDelete, onHistory, heading, onHeading, onMatchHeading,
}: SectionHeaderProps) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(section.title)
  const numbered = section.ordinal !== null
  const attention = needsAttention(notes) || needsAttention(output)
  const problem = [notes, output].some((pane) => pane?.state === 'conflict' || pane?.state === 'error')
  // With a heading, the heading is the title readers see; the file name only orders and labels the files.
  const shownTitle = heading?.text ?? section.title
  const mismatch = heading !== null && normalized(heading.text) !== normalized(section.title)

  const items: MenuItem[] = [
    { label: 'Edit section title', onClick: () => { setTitle(shownTitle); setRenaming(true) } },
    {
      label: 'Section heading',
      checked: heading !== null,
      onClick: () => onHeading(heading === null),
      title: 'The title as a heading at the top of the output (its first line), so it appears in exports',
    },
    'separator',
    { label: 'Swap with previous section', disabled: !numbered || !previous?.ordinal, onClick: () => onMove('up') },
    { label: 'Swap with next section', disabled: !numbered || !next?.ordinal, onClick: () => onMove('down') },
    { label: `Merge into previous${previous ? ` (${previous.title})` : ''}…`, disabled: !previous, onClick: () => onMerge('previous') },
    { label: `Merge next${next ? ` (${next.title})` : ''} into this…`, disabled: !next, onClick: () => onMerge('next') },
    'separator',
    { label: layout.hideOutput ? 'Show output' : 'Hide output', onClick: () => onLayout({ ...layout, hideOutput: !layout.hideOutput }) },
    { label: layout.hideNotes ? 'Show notes' : 'Hide notes', onClick: () => onLayout({ ...layout, hideNotes: !layout.hideNotes }) },
    'separator',
    { label: 'Delete section', onClick: onDelete },
    'separator',
    { label: 'Output history…', hint: statusText(output), disabled: !output?.exists, onClick: () => onHistory('output') },
    { label: 'Notes history…', hint: statusText(notes), disabled: !notes?.exists, onClick: () => onHistory('notes') },
  ]

  return (
    <div className={`section-line${heading ? '' : ' no-heading'}`}>
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
      <DropdownMenu
        items={items}
        trigger={(
          <button
            type="button"
            className={`icon-button section-menu-button${attention ? ' attention' : ''}${problem ? ' problem' : ''}`}
            aria-label={`Section menu for ${section.title}`}
            title={attention ? `Section menu — notes: ${statusText(notes)}, output: ${statusText(output)}` : 'Section menu'}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  )
}
