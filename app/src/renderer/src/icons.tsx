// Line icons, 16px, drawn in the current text color.

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

export function FilesIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  )
}

export function OutlineIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M4 6h16M8 11h12M8 16h12M4 11h.01M4 16h.01" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  )
}

/** A window with its left (or right) pane marked: toggles that pane. */
export function PaneIcon({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const x = side === 'left' ? 9 : 15
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={`M${x} 4v16`} />
      {open && <path d={side === 'left' ? 'M3 4h6v16H3z' : 'M15 4h6v16h-6z'} fill="currentColor" fillOpacity="0.25" stroke="none" />}
    </svg>
  )
}

export function GearIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}
