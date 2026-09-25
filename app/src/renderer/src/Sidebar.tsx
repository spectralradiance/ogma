import { folderName } from '../../shared/format'
import { TreeNode } from './FileTree'

interface SidebarProps {
  roots: string[]
  openPath: string | null
  onAdd: () => void
  onRemove: (path: string) => void
  onOpen: (path: string) => void
}

export function Sidebar({ roots, openPath, onAdd, onRemove, onOpen }: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span>Workspace</span>
        <button type="button" className="icon-button" onClick={onAdd} title="Add folder…" aria-label="Add folder">
          +
        </button>
      </header>
      {roots.length === 0 ? (
        <>
          <p className="sidebar-empty">No folders yet. Folders are edited in place; nothing is copied.</p>
          <button type="button" className="add-folder" onClick={onAdd}>
            Add folder…
          </button>
        </>
      ) : (
        <ul className="tree tree-top">
          {roots.map((root) => (
            <TreeNode
              key={root}
              entry={{ name: folderName(root), path: root, kind: 'dir' }}
              depth={0}
              openPath={openPath}
              onOpen={onOpen}
              initiallyOpen={roots.length === 1}
              onRemove={() => onRemove(root)}
            />
          ))}
        </ul>
      )}
    </aside>
  )
}
