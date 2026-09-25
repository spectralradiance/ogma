import type { ReactNode } from 'react'

import type { Drawer } from './DocumentView'

const ICON_PROPS = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function BookIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />
      <path d="M8 7h8M8 10.5h6" />
    </svg>
  )
}

export function SparkleIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  )
}

export const SIDE_TABS: { id: Drawer; label: string; shortcut: string; icon: () => ReactNode }[] = [
  { id: 'words', label: 'Words', shortcut: 'Ctrl+D', icon: BookIcon },
  { id: 'ai', label: 'AI', shortcut: 'Ctrl+J', icon: SparkleIcon },
]

interface SidePanelProps {
  open: Drawer | null
  onSelect: (drawer: Drawer) => void
  onClose: () => void
  children: ReactNode
}

/** The right-hand pane: icon tabs above the open panel, or a slim rail of tabs when closed. */
export function SidePanel({ open, onSelect, onClose, children }: SidePanelProps) {
  if (!open) {
    return (
      <nav className="side-rail" aria-label="Side panels">
        {SIDE_TABS.map((tab) => (
          <button key={tab.id} type="button" className="side-rail-tab" onClick={() => onSelect(tab.id)} title={`${tab.label} (${tab.shortcut})`} aria-label={tab.label}>
            <tab.icon />
          </button>
        ))}
      </nav>
    )
  }
  return (
    <aside className="side-panel">
      <nav className="side-tabs" role="tablist" aria-label="Side panels">
        {SIDE_TABS.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={open === tab.id} onClick={() => onSelect(tab.id)} title={`${tab.label} (${tab.shortcut})`}>
            <tab.icon />
            <span>{tab.label}</span>
          </button>
        ))}
        <button type="button" className="icon-button side-close" onClick={onClose} title="Close panel" aria-label="Close panel">×</button>
      </nav>
      {children}
    </aside>
  )
}
