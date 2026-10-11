import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { folderName } from '../../shared/format'
import type { FolderListing } from '../../shared/ipc'
import { joinPath, samePath } from '../../shared/paths'
import { onDiskChange, touchesFolder } from './changes'
import { FilesIcon, OutlineIcon, PaneIcon, SearchIcon } from './icons'
import { ContextMenu } from './menu'
import { errorMessage, type OpenTarget } from './target'
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, X } from 'lucide-react'

export interface TreeActions {
  target: OpenTarget | null
  open: (target: OpenTarget) => void
  /** Renames a folder on disk, keeping whatever is open inside it open. */
  renameFolder: (folder: string, name: string) => Promise<void>
  /** Renames a file on disk, keeping it open if it is. */
  renameFile: (file: string, name: string) => Promise<void>
  /** Moves a file to the Recycle Bin, offering Undo afterwards. */
  deleteFile: (file: string) => Promise<void>
}

const TreeContext = createContext<TreeActions | null>(null)

function useTree(): TreeActions {
  const context = useContext(TreeContext)
  if (!context) throw new Error('WorkspaceTree context missing')
  return context
}

const indent = (depth: number, extra = 0) => ({ paddingLeft: `${8 + depth * 14 + extra}px` })

/** A document's name in the tree: the file name without a .md extension. */
const documentName = (file: string) => file.replace(/\.md$/i, '')

function NameInput({ initial, placeholder, depth, onSubmit, onCancel }: {
  initial: string
  placeholder: string
  depth: number
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <li className="tree-input-row" style={indent(depth, 18)}>
      <input
        className="tree-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) onSubmit(value.trim())
          if (event.key === 'Escape') onCancel()
        }}
        onBlur={onCancel}
      />
    </li>
  )
}

function FileRow({ folder, name, depth }: { folder: string; name: string; depth: number }) {
  const tree = useTree()
  const [renaming, setRenaming] = useState(false)
  const path = joinPath(folder, name)
  const selected = tree.target !== null && samePath(tree.target.path, path)

  if (renaming) {
    return (
      <NameInput
        initial={documentName(name)}
        placeholder="Document name"
        depth={depth}
        onCancel={() => setRenaming(false)}
        onSubmit={(next) => {
          setRenaming(false)
          if (next !== documentName(name)) void tree.renameFile(path, next)
        }}
      />
    )
  }
  return (
    <li>
      <ContextMenu items={[
        { label: 'Rename', onClick: () => setRenaming(true) },
        'separator',
        { label: 'Delete', onClick: () => void tree.deleteFile(path) },
      ]}>
        <div className="tree-row-wrap">
          <button
            type="button"
            className={`tree-row tree-file${selected ? ' selected' : ''}`}
            style={indent(depth, 18)}
            onClick={() => tree.open({ path })}
            onDoubleClick={() => setRenaming(true)}
            title={path}
          >
            <span className="tree-label">{documentName(name)}</span>
          </button>
        </div>
      </ContextMenu>
    </li>
  )
}

type Editing = 'folder' | 'document' | null

function FolderNode({ path, depth, initiallyOpen = false, onRemoveRoot }: {
  path: string
  depth: number
  initiallyOpen?: boolean
  onRemoveRoot?: () => void
}) {
  const tree = useTree()
  const [open, setOpen] = useState(initiallyOpen)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(() => window.ogma.folders.read(path).then(
    (next) => {
      setListing(next)
      setError(null)
    },
    (reason: unknown) => setError(errorMessage(reason)),
  ), [path])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    return onDiskChange((paths) => {
      if (touchesFolder(paths, path)) void load()
    })
  }, [open, path, load])

  const startEditing = (kind: Editing) => {
    setOpen(true)
    setEditing(kind)
  }
  const createDocument = (name: string) => {
    setEditing(null)
    const file = joinPath(path, /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`)
    window.ogma.files.write({
      path: file,
      text: '',
      format: { encoding: 'utf-8', eol: '\n', mixedEol: false },
      expectedMtimeMs: null,
    }).then(
      (result) => {
        if (!result.ok) throw new Error(`“${folderName(file)}” already exists here.`)
        tree.open({ path: file })
      },
      (reason: unknown) => window.alert(errorMessage(reason)),
    )
  }
  const createFolder = (name: string) => {
    setEditing(null)
    window.ogma.folders.create(path, name).then(() => load(), (reason: unknown) => window.alert(errorMessage(reason)))
  }

  const empty = listing && listing.folders.length === 0 && listing.files.length === 0
  const title = folderName(path)

  return (
    <li>
      {renaming ? (
        <ul className="tree">
          <NameInput
            initial={title}
            placeholder="Folder name"
            depth={depth - 1}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => {
              setRenaming(false)
              if (name !== title) void tree.renameFolder(path, name)
            }}
          />
        </ul>
      ) : (
      <ContextMenu items={[
        { label: 'New document', onClick: () => startEditing('document') },
        { label: 'New folder', onClick: () => startEditing('folder') },
        'separator',
        { label: 'Rename', onClick: () => setRenaming(true) },
        ...(onRemoveRoot ? ['separator' as const, { label: 'Remove from workspace', onClick: onRemoveRoot }] : []),
      ]}>
      <div className={`tree-row-wrap${depth === 0 ? ' tree-root' : ''}`}>
        <button
          type="button"
          className="tree-row tree-dir"
          style={indent(depth)}
          onClick={() => setOpen(!open)}
          onDoubleClick={() => setRenaming(true)}
          aria-expanded={open}
          title={path}
        >
          <span className="tree-chevron" aria-hidden="true">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="tree-label">{title}</span>
        </button>
        <span className="tree-actions">
          <button type="button" className="icon-button" title="New document" onClick={() => startEditing('document')}><FilePlus size={14} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="New folder" onClick={() => startEditing('folder')}><FolderPlus size={14} aria-hidden="true" /></button>
          {onRemoveRoot && (
            <button type="button" className="icon-button" title="Remove from workspace (files are not touched)" onClick={onRemoveRoot}><X size={14} aria-hidden="true" /></button>
          )}
        </span>
      </div>
      </ContextMenu>
      )}
      {open && (
        <ul className="tree">
          {error && <li className="tree-note" style={indent(depth, 18)}>{error}</li>}
          {editing === 'folder' && (
            <NameInput initial="" placeholder="Folder name" depth={depth + 1} onSubmit={createFolder} onCancel={() => setEditing(null)} />
          )}
          {listing?.folders.map((name) => (
            <FolderNode key={name} path={joinPath(path, name)} depth={depth + 1} />
          ))}
          {listing?.files.map((name) => (
            <FileRow key={name} folder={path} name={name} depth={depth + 1} />
          ))}
          {editing === 'document' && (
            <NameInput initial="" placeholder="Document name" depth={depth + 1} onSubmit={createDocument} onCancel={() => setEditing(null)} />
          )}
          {empty && !editing && <li className="tree-note" style={indent(depth + 1, 18)}>Empty folder</li>}
        </ul>
      )}
    </li>
  )
}

export type SidebarTab = 'files' | 'outline' | 'search'

interface WorkspaceTreeProps extends TreeActions {
  roots: string[]
  onAddRoot: () => void
  onRemoveRoot: (path: string) => void
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  /** Rendered in place of the tree on the Outline and Search tabs. */
  outline: ReactNode
  search: ReactNode
  /** Collapsed to a strip of tab icons. */
  collapsed: boolean
  onToggle: () => void
  /** The drag handle on the sidebar's right edge. */
  resizer: ReactNode
}

const SIDEBAR_TABS: { id: SidebarTab; label: string; icon: () => ReactNode; title: string }[] = [
  { id: 'files', label: 'Files', icon: FilesIcon, title: 'Files' },
  { id: 'outline', label: 'Outline', icon: OutlineIcon, title: 'Every section and heading in the open document' },
  { id: 'search', label: 'Search', icon: SearchIcon, title: 'Search all folders (Ctrl+Shift+F)' },
]

export function WorkspaceTree({
  roots, onAddRoot, onRemoveRoot, tab, onTab, outline, search, collapsed, onToggle, resizer, ...actions
}: WorkspaceTreeProps) {
  if (collapsed) {
    return (
      <nav className="side-rail left-rail" aria-label="Sidebar">
        <button type="button" className="side-rail-tab" onClick={onToggle} title="Show sidebar (Ctrl+\)" aria-label="Show sidebar">
          <PaneIcon side="left" open={false} />
        </button>
        {SIDEBAR_TABS.map((item) => (
          <button key={item.id} type="button" className="side-rail-tab" title={item.title} aria-label={item.label}
            onClick={() => {
              onTab(item.id)
              onToggle()
            }}>
            <item.icon />
          </button>
        ))}
      </nav>
    )
  }
  return (
    <TreeContext.Provider value={actions}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <nav className="sidebar-tabs" role="tablist">
            {SIDEBAR_TABS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => onTab(item.id)} title={item.title}>{item.label}</button>
            ))}
          </nav>
          <button type="button" className="icon-button" onClick={onAddRoot} title="Add folder…" aria-label="Add folder"><FolderPlus size={14} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={onToggle} title="Hide sidebar (Ctrl+\)" aria-label="Hide sidebar">
            <PaneIcon side="left" open />
          </button>
        </header>
        {tab === 'search' ? search : tab === 'outline' ? outline : roots.length === 0 ? (
          <>
            <p className="sidebar-empty">No folders yet. Folders are edited in place; nothing is copied.</p>
            <button type="button" className="add-folder" onClick={onAddRoot}>Add folder…</button>
          </>
        ) : (
          <ul className="tree tree-top">
            {roots.map((root) => (
              <FolderNode
                key={root}
                path={root}
                depth={0}
                initiallyOpen={roots.length === 1}
                onRemoveRoot={() => onRemoveRoot(root)}
              />
            ))}
          </ul>
        )}
        {resizer}
      </aside>
    </TreeContext.Provider>
  )
}
