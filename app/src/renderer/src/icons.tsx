import { BookOpen, Folder, ListTree, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Settings, Sparkles } from 'lucide-react'

// Lucide line icons, 16px, drawn in the current text color. The wrappers keep one
// size and stroke weight across the app; use lucide-react directly for one-offs.

const SIZE = 16
const STROKE = 1.8

export const BookIcon = () => <BookOpen size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
export const SparkleIcon = () => <Sparkles size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
export const FilesIcon = () => <Folder size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
export const OutlineIcon = () => <ListTree size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
export const SearchIcon = () => <Search size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
export const GearIcon = () => <Settings size={SIZE} strokeWidth={STROKE} aria-hidden="true" />

/** A window with one pane marked: toggles that pane. */
export function PaneIcon({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const Icon = side === 'left' ? (open ? PanelLeftClose : PanelLeftOpen) : (open ? PanelRightClose : PanelRightOpen)
  return <Icon size={SIZE} strokeWidth={STROKE} aria-hidden="true" />
}
