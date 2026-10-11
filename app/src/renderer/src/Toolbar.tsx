import type { ComponentProps } from 'react'
import { Code, Eye, FileText, Focus, Layers, type LucideIcon, NotebookPen } from 'lucide-react'

import type { NotesView } from './editor/notesBlocks'

// Toolbar buttons are icons: the label is the accessible name, the title the tooltip.
const ICON = { size: 16, strokeWidth: 1.8, 'aria-hidden': true } as const

export function IconButton({ icon: Icon, label, title, ...props }: { icon: LucideIcon; label: string; title?: string } & ComponentProps<'button'>) {
  return (
    <button type="button" className="tool-button" aria-label={label} title={title ?? label} {...props}>
      <Icon {...ICON} />
    </button>
  )
}

const NOTES_VIEWS: { id: NotesView; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'output', icon: FileText, label: 'Output', title: 'The text as one continuous document, notes hidden' },
  { id: 'notes', icon: NotebookPen, label: 'Notes', title: 'All notes as one continuous document, under each section’s # heading. Enter on a heading starts its notes.' },
  { id: 'all', icon: Layers, label: 'Both', title: 'Text and notes together, each section’s notes under its text. Ctrl+Alt+N adds or jumps to notes.' },
]

/** The output alone, the notes alone, or both. */
export function NotesViewSwitch({ view, onView }: { view: NotesView; onView: (view: NotesView) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Document view">
      {NOTES_VIEWS.map((option) => (
        <IconButton key={option.id} icon={option.icon} label={option.label} title={`${option.label}: ${option.title}`} aria-pressed={view === option.id} onClick={() => onView(option.id)} />
      ))}
    </div>
  )
}

interface ModeProps {
  live: boolean
  focusMode: boolean
  onToggleLive: () => void
  onToggleFocus: () => void
}

export function ModeToggles({ live, focusMode, onToggleLive, onToggleFocus }: ModeProps) {
  return (
    <div className="mode-toggles">
      <div className="segmented" role="group" aria-label="Editing mode">
        <IconButton icon={Eye} label="Live" title="Live rendering (Ctrl+/)" aria-pressed={live} onClick={live ? undefined : onToggleLive} />
        <IconButton icon={Code} label="Source" title="Markdown source (Ctrl+/)" aria-pressed={!live} onClick={live ? onToggleLive : undefined} />
      </div>
      <IconButton icon={Focus} label="Focus mode" title="Focus mode (F8)" aria-pressed={focusMode} onClick={onToggleFocus} />
    </div>
  )
}
