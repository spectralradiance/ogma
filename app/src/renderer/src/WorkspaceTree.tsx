import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { folderName } from '../../shared/format'
import type { FolderModel, SectionInfo } from '../../shared/ipc'
import { joinPath, samePath } from '../../shared/paths'
import { onDiskChange, touchesFolder } from './changes'
import { FilesIcon, OutlineIcon, PaneIcon, SearchIcon } from './icons'
import { type ActivePane, errorMessage, type OpenTarget } from './target'
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, X } from 'lucide-react'

export interface TreeActions {
  target: OpenTarget | null
  /** The editor last typed in; its section is highlighted. */
  active: ActivePane | null
  open: (target: OpenTarget) => void
  /** Runs a rename/move/trash, saving the open section first if it is affected. */
  runSectionOperation: (folder: string, stem: string, operation: () => Promise<SectionInfo | null>) => Promise<void>
  /** Renames a folder on disk, keeping whatever is open inside it open. */
  renameFolder: (folder: string, name: string) => Promise<void>
  /** Deletes a section's files, offering Undo afterwards. */
  deleteSection: (folder: string, section: SectionInfo) => Promise<void>
}

const TreeContext = createContext<TreeActions | null>(null)

function useTree(): TreeActions {
  const context = useContext(TreeContext)
  if (!context) throw new Error('WorkspaceTree context missing')
  return context
}

const indent = (depth: number, extra = 0) => ({ paddingLeft: `${8 + depth * 14 + extra}px` })

function NameInput({ initial, placeholder, depth, ordinal, onSubmit, onCancel }: {
  initial: string
  ordinal?: string | null
  placeholder: string
  depth: number
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <li className="tree-input-row" style={indent(depth, 18)}>
      {ordinal && <span className="tree-ordinal">{ordinal}</span>}
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

type MenuItem = { label: string; onClick: () => void; disabled?: boolean } | 'separator'

/** A right-click menu at the pointer; closes on any outside click, scroll or Escape. */
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && (event.target as Element).closest('.context-menu')) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])
  return (
    <div className="section-menu context-menu" role="menu" style={{ left: x, top: y }}>
      {items.map((item, index) => item === 'separator' ? (
        <div key={index} className="menu-separator" />
      ) : (
        <button key={index} type="button" role="menuitem" disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onClick()
          }}>
          {item.label}
        </button>
      ))}
    </div>
  )
}

interface FolderIdentity {
  path: string
  title: string
  ordinal: string | null
}

function openDocument(folder: FolderIdentity, focusStem: string | null): OpenTarget {
  return { kind: 'document', folder: folder.path, title: folder.title, ordinal: folder.ordinal, focusStem, nonce: Date.now() }
}

interface SectionDrag {
  /** Stem of the section being dragged. */
  from: string | null
  /** Stem of the section it is currently over. */
  over: string | null
}

function SectionRow({ folder: identity, section, depth, index, count, drag, onDrag, onDropOn, onChanged }: {
  folder: FolderIdentity
  section: SectionInfo
  depth: number
  index: number
  count: number
  drag: SectionDrag
  onDrag: (next: SectionDrag) => void
  onDropOn: (targetStem: string) => void
  onChanged: () => void
}) {
  const tree = useTree()
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const folder = identity.path
  const active = tree.active !== null && tree.active.folder !== null && samePath(tree.active.folder, folder)
    && tree.active.stem?.toLowerCase() === section.stem.toLowerCase()

  const run = (operation: () => Promise<SectionInfo | null>) => {
    void tree.runSectionOperation(folder, section.stem, operation).then(onChanged)
  }

  if (renaming) {
    return (
      <NameInput
        initial={section.title}
        placeholder="Section name"
        depth={depth}
        ordinal={section.ordinal}
        onCancel={() => setRenaming(false)}
        onSubmit={(title) => {
          setRenaming(false)
          if (title !== section.title) run(() => window.ogma.sections.rename(folder, section.stem, title))
        }}
      />
    )
  }

  const trash = () => void tree.deleteSection(folder, section).then(onChanged)

  const numbered = section.ordinal !== null
  const dragging = drag.from === section.stem
  const dropTarget = numbered && drag.from !== null && drag.over === section.stem && !dragging
  return (
    <li>
      <div
        className={`tree-row-wrap${active ? ' active' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''}`}
        draggable={numbered}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', section.stem)
          onDrag({ from: section.stem, over: null })
        }}
        onDragOver={(event) => {
          if (!numbered || drag.from === null) return
          event.preventDefault()
          if (drag.over !== section.stem) onDrag({ from: drag.from, over: section.stem })
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (numbered && drag.from !== null && !dragging) onDropOn(section.stem)
          onDrag({ from: null, over: null })
        }}
        onDragEnd={() => onDrag({ from: null, over: null })}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <button
          type="button"
          className="tree-row tree-section"
          style={indent(depth, 18)}
          onClick={() => tree.open(openDocument(identity, section.stem))}
          onDoubleClick={() => setRenaming(true)}
          title={section.notes ?? section.notesName}
        >
          {section.ordinal && <span className="tree-ordinal">{section.ordinal}</span>}
          <span className="tree-label">{section.title}</span>
          <span
            className={`output-mark${section.output ? ' has-output' : ''}`}
            title={section.output ? 'Has output' : 'No output yet'}
            aria-label={section.output ? 'Has output' : 'No output yet'}
          />
        </button>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: 'Rename', onClick: () => setRenaming(true) },
          'separator',
          { label: 'Move up', disabled: !numbered || index === 0, onClick: () => run(() => window.ogma.sections.move(folder, section.stem, 'up')) },
          { label: 'Move down', disabled: !numbered || index === count - 1, onClick: () => run(() => window.ogma.sections.move(folder, section.stem, 'down')) },
          'separator',
          { label: 'Delete', onClick: trash },
        ]} />
      )}
    </li>
  )
}

type Editing = 'section' | 'folder' | null

function FolderNode({ path, title, ordinal, depth, initiallyOpen = false, onRemoveRoot }: {
  path: string
  title: string
  ordinal?: string | null
  depth: number
  initiallyOpen?: boolean
  onRemoveRoot?: () => void
}) {
  const tree = useTree()
  const [open, setOpen] = useState(initiallyOpen)
  const [model, setModel] = useState<FolderModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [drag, setDrag] = useState<SectionDrag>({ from: null, over: null })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(() => window.ogma.folders.read(path).then(
    (next) => {
      setModel(next)
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

  const expand = () => setOpen(true)
  const identity: FolderIdentity = { path, title, ordinal: ordinal ?? null }
  const createSection = (name: string) => {
    setEditing(null)
    window.ogma.sections.create(path, name).then(
      (section) => {
        void load()
        tree.open(openDocument(identity, section.stem))
      },
      (reason: unknown) => window.alert(errorMessage(reason)),
    )
  }
  const createFolder = (name: string) => {
    setEditing(null)
    window.ogma.folders.create(path, name).then(() => load(), (reason: unknown) => window.alert(errorMessage(reason)))
  }

  /** Moves a numbered section into another's place by swapping it past each section in between. */
  const dropSection = (targetStem: string) => {
    const numbered = model?.sections.filter((section) => section.ordinal !== null) ?? []
    const from = numbered.findIndex((section) => section.stem === drag.from)
    const to = numbered.findIndex((section) => section.stem === targetStem)
    if (from < 0 || to < 0 || from === to) return
    const direction = to > from ? 'down' : 'up'
    void tree.runSectionOperation(path, numbered[from].stem, async () => {
      let moved: SectionInfo = numbered[from]
      for (let step = Math.abs(to - from); step > 0; step--) {
        moved = await window.ogma.sections.move(path, moved.stem, direction)
      }
      return moved
    }).then(() => load())
  }

  const documentOpen = tree.target?.kind === 'document' && samePath(tree.target.folder, path)
  const fileActive = (name: string) => tree.target?.kind === 'file' && samePath(tree.target.path, joinPath(path, name))
  const empty = model && model.sections.length === 0 && model.subdocuments.length === 0 && model.documentNotes.length === 0

  return (
    <li>
      {renaming ? (
        <ul className="tree">
          <NameInput
            initial={folderName(path)}
            placeholder="Folder name"
            depth={depth - 1}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => {
              setRenaming(false)
              if (name !== folderName(path)) void tree.renameFolder(path, name)
            }}
          />
        </ul>
      ) : (
      <div
        className={`tree-row-wrap${depth === 0 ? ' tree-root' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <button
          type="button"
          className={`tree-row tree-dir${documentOpen ? ' selected' : ''}`}
          style={indent(depth)}
          onClick={() => {
            // A folder with sections opens as a document; other folders just expand or collapse.
            const wasOpen = open
            setOpen(true)
            void (async () => {
              const current = model ?? await window.ogma.folders.read(path).catch(() => null)
              if (current && current.sections.length > 0) tree.open(openDocument(identity, null))
              else if (wasOpen) setOpen(false)
            })()
          }}
          onDoubleClick={() => setRenaming(true)}
          aria-expanded={open}
          title={path}
        >
          <span
            className="tree-chevron"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation()
              setOpen(!open)
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {ordinal && <span className="tree-ordinal">{ordinal}</span>}
          <span className="tree-label">{title}</span>
        </button>
        <span className="tree-actions">
          <button type="button" className="icon-button" title="New section" onClick={() => { expand(); setEditing('section') }}><FilePlus size={14} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="New folder" onClick={() => { expand(); setEditing('folder') }}><FolderPlus size={14} aria-hidden="true" /></button>
          {onRemoveRoot && (
            <button type="button" className="icon-button" title="Remove from workspace (files are not touched)" onClick={onRemoveRoot}><X size={14} aria-hidden="true" /></button>
          )}
        </span>
      </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: 'Rename', onClick: () => setRenaming(true) },
          { label: 'New section', onClick: () => { expand(); setEditing('section') } },
          { label: 'New folder', onClick: () => { expand(); setEditing('folder') } },
          ...(onRemoveRoot ? ['separator' as const, { label: 'Remove from workspace', onClick: onRemoveRoot }] : []),
        ]} />
      )}
      {open && (
        <ul className="tree">
          {error && <li className="tree-note" style={indent(depth, 18)}>{error}</li>}
          {editing === 'folder' && (
            <NameInput initial="" placeholder="Folder name" depth={depth + 1} onSubmit={createFolder} onCancel={() => setEditing(null)} />
          )}
          {model?.documentNotes.map((name) => (
            <li key={name}>
              <button
                type="button"
                className={`tree-row tree-docnote${fileActive(name) ? ' selected' : ''}`}
                style={indent(depth + 1, 18)}
                onClick={() => tree.open({ kind: 'file', path: joinPath(path, name) })}
                title="Notes for this whole document"
              >
                <span className="tree-label">{name}</span>
              </button>
            </li>
          ))}
          {model?.subdocuments.map((subdocument) => (
            <FolderNode
              key={subdocument.name}
              path={joinPath(path, subdocument.name)}
              title={subdocument.title}
              ordinal={subdocument.ordinal}
              depth={depth + 1}
            />
          ))}
          {model?.sections.map((section) => (
            <SectionRow
              key={section.stem}
              folder={identity}
              section={section}
              depth={depth + 1}
              index={model.sections.filter((s) => s.ordinal !== null).indexOf(section)}
              count={model.sections.filter((s) => s.ordinal !== null).length}
              drag={drag}
              onDrag={setDrag}
              onDropOn={dropSection}
              onChanged={() => void load()}
            />
          ))}
          {editing === 'section' && (
            <NameInput initial="" placeholder="Section name" depth={depth + 1} onSubmit={createSection} onCancel={() => setEditing(null)} />
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
                title={folderName(root)}
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
