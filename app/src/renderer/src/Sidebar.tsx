import { folderName } from '../../shared/format'

interface SidebarProps {
  roots: string[]
  onAdd: () => void
  onRemove: (path: string) => void
}

export function Sidebar({ roots, onAdd, onRemove }: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span>Workspace</span>
        <button type="button" className="icon-button" onClick={onAdd} title="Add folder…" aria-label="Add folder">
          +
        </button>
      </header>
      {roots.length === 0 ? (
        <p className="sidebar-empty">No folders yet. Folders are edited in place; nothing is copied.</p>
      ) : (
        <ul className="root-list">
          {roots.map((root) => (
            <li key={root} className="root-item" title={root}>
              <div className="root-text">
                <span className="root-name">{folderName(root)}</span>
                <span className="root-path">{root}</span>
              </div>
              <button
                type="button"
                className="icon-button root-remove"
                onClick={() => onRemove(root)}
                title="Remove from workspace (files are not touched)"
                aria-label={`Remove ${folderName(root)} from workspace`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="add-folder" onClick={onAdd}>
        Add folder…
      </button>
    </aside>
  )
}
