import type { ReactNode } from 'react'

import type { SidecarState } from '../../shared/ipc'
import { SERVER_STATE_LABEL } from './AiServer'
import { BookIcon, PaneIcon, SparkleIcon } from './icons'

/** The panels on the right: dictionary and lexicon, and AI. */
export type Drawer = 'words' | 'ai'

export const SIDE_TABS: { id: Drawer; label: string; shortcut: string; icon: () => ReactNode }[] = [
  { id: 'words', label: 'Words', shortcut: 'Ctrl+D', icon: BookIcon },
  { id: 'ai', label: 'AI', shortcut: 'Ctrl+J', icon: SparkleIcon },
]

interface SidePanelProps {
  open: Drawer | null
  onSelect: (drawer: Drawer) => void
  onClose: () => void
  /** Reopens the panel last shown. */
  onShow: () => void
  /** The drag handle on the panel's left edge. */
  resizer: ReactNode
  /** Shown as a dot on the AI tab when the server is not online. */
  aiState: SidecarState
  children: ReactNode
}

/** The right-hand pane: icon tabs above the open panel, or a slim rail of tabs when closed. */
export function SidePanel({ open, onSelect, onClose, onShow, resizer, aiState, children }: SidePanelProps) {
  const badge = (id: Drawer) => (id === 'ai' && aiState !== 'online'
    ? <span className={`dot dot-${aiState} side-tab-badge`} aria-hidden="true" />
    : null)
  const hint = (id: Drawer) => (id === 'ai' && aiState !== 'online' ? ` — ${SERVER_STATE_LABEL[aiState]}` : '')
  if (!open) {
    return (
      <nav className="side-rail" aria-label="Side panels">
        <button type="button" className="side-rail-tab" onClick={onShow} title="Show panel" aria-label="Show panel">
          <PaneIcon side="right" open={false} />
        </button>
        {SIDE_TABS.map((tab) => (
          <button key={tab.id} type="button" className="side-rail-tab" onClick={() => onSelect(tab.id)} title={`${tab.label} (${tab.shortcut})${hint(tab.id)}`} aria-label={tab.label}>
            <tab.icon />
            {badge(tab.id)}
          </button>
        ))}
      </nav>
    )
  }
  return (
    <aside className="side-panel">
      <nav className="side-tabs" role="tablist" aria-label="Side panels">
        {SIDE_TABS.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={open === tab.id} onClick={() => onSelect(tab.id)} title={`${tab.label} (${tab.shortcut})${hint(tab.id)}`}>
            <tab.icon />
            <span>{tab.label}</span>
            {badge(tab.id)}
          </button>
        ))}
        <button type="button" className="icon-button side-close" onClick={onClose} title="Hide panel" aria-label="Hide panel">
          <PaneIcon side="right" open />
        </button>
      </nav>
      {children}
      {resizer}
    </aside>
  )
}
