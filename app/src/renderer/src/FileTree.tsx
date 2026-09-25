import { useEffect, useState } from 'react'

import type { DirEntry } from '../../shared/ipc'

interface TreeNodeProps {
  entry: DirEntry
  depth: number
  openPath: string | null
  onOpen: (path: string) => void
  initiallyOpen?: boolean
  onRemove?: () => void
}

/** Lazily lists a folder's contents the first time it is expanded. */
export function TreeNode({ entry, depth, openPath, onOpen, initiallyOpen = false, onRemove }: TreeNodeProps) {
  const [open, setOpen] = useState(initiallyOpen)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || entry.kind !== 'dir' || children !== null) return
    let active = true
    window.oisin.files.listDir(entry.path).then(
      (entries) => { if (active) setChildren(entries) },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => {
      active = false
    }
  }, [open, entry, children])

  const indent = { paddingLeft: `${8 + depth * 14}px` }
  // Files line up with folder names, past the chevron column.
  const fileIndent = { paddingLeft: `${26 + (depth - 1) * 14}px` }

  if (entry.kind === 'file') {
    return (
      <li>
        <button
          type="button"
          className={`tree-row tree-file${entry.path === openPath ? ' selected' : ''}`}
          style={fileIndent}
          onClick={() => onOpen(entry.path)}
          title={entry.path}
        >
          <span className="tree-label">{entry.name}</span>
        </button>
      </li>
    )
  }

  const toggle = () => {
    // Collapsing forgets the listing so reopening picks up changes made elsewhere.
    if (open) setChildren(null)
    setOpen(!open)
  }

  return (
    <li>
      <div className={`tree-row-wrap${depth === 0 ? ' tree-root' : ''}`}>
        <button type="button" className="tree-row tree-dir" style={indent} onClick={toggle} aria-expanded={open} title={entry.path}>
          <span className="tree-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="tree-label">{entry.name}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            className="icon-button tree-remove"
            onClick={onRemove}
            title="Remove from workspace (files are not touched)"
            aria-label={`Remove ${entry.name} from workspace`}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <ul className="tree">
          {error && <li className="tree-note" style={indent}>{error}</li>}
          {children?.length === 0 && <li className="tree-note" style={{ paddingLeft: `${26 + depth * 14}px` }}>No text files</li>}
          {children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} openPath={openPath} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}
