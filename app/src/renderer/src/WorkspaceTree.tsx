import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { folderName } from '../../shared/format'
import type { FolderModel, SectionInfo } from '../../shared/ipc'
import { joinPath, samePath } from '../../shared/paths'
import { onDiskChange, touchesFolder } from './changes'
import { type ActivePane, errorMessage, type OpenTarget } from './target'

export interface TreeActions {
  target: OpenTarget | null
  /** The editor last typed in; its section is highlighted. */
  active: ActivePane | null
  open: (target: OpenTarget) => void
  /** Runs a rename/move/trash, saving the open section first if it is affected. */
  runSectionOperation: (folder: string, stem: string, operation: () => Promise<SectionInfo | null>) => Promise<void>
}

const TreeContext = createContext<TreeActions | null>(null)

function useTree(): TreeActions {
  const context = useContext(TreeContext)
  if (!context) throw new Error('WorkspaceTree context missing')
  return context
}

const indent = (depth: number, extra = 0) => ({ paddingLeft: `${8 + depth * 14 + extra}px` })

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

interface FolderIdentity {
  path: string
  title: string
  ordinal: string | null
}

function openDocument(folder: FolderIdentity, focusStem: string | null): OpenTarget {
  return { kind: 'document', folder: folder.path, title: folder.title, ordinal: folder.ordinal, focusStem, nonce: Date.now() }
}

function SectionRow({ folder: identity, section, depth, index, count, onChanged }: {
  folder: FolderIdentity
  section: SectionInfo
  depth: number
  index: number
  count: number
  onChanged: () => void
}) {
  const tree = useTree()
  const [renaming, setRenaming] = useState(false)
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
        onCancel={() => setRenaming(false)}
        onSubmit={(title) => {
          setRenaming(false)
          if (title !== section.title) run(() => window.oisin.sections.rename(folder, section.stem, title))
        }}
      />
    )
  }

  const numbered = section.ordinal !== null
  return (
    <li>
      <div className={`tree-row-wrap${active ? ' active' : ''}`}>
        <button
          type="button"
          className="tree-row tree-section"
          style={indent(depth, 18)}
          onClick={() => tree.open(openDocument(identity, section.stem))}
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
        <span className="tree-actions">
          {numbered && (
            <>
              <button type="button" className="icon-button" disabled={index === 0} title="Move up"
                onClick={() => run(() => window.oisin.sections.move(folder, section.stem, 'up'))}>↑</button>
              <button type="button" className="icon-button" disabled={index === count - 1} title="Move down"
                onClick={() => run(() => window.oisin.sections.move(folder, section.stem, 'down'))}>↓</button>
            </>
          )}
          <button type="button" className="icon-button" title="Rename" onClick={() => setRenaming(true)}>✎</button>
          <button
            type="button"
            className="icon-button"
            title="Move to Recycle Bin"
            onClick={() => {
              const files = [section.notes, section.output].filter(Boolean).join('” and “')
              if (window.confirm(`Move “${files}” to the Recycle Bin?`)) {
                run(async () => {
                  await window.oisin.sections.trash(folder, section.stem)
                  return null
                })
              }
            }}
          >
            ×
          </button>
        </span>
      </div>
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

  const load = useCallback(() => window.oisin.folders.read(path).then(
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
    window.oisin.sections.create(path, name).then(
      (section) => {
        void load()
        tree.open(openDocument(identity, section.stem))
      },
      (reason: unknown) => window.alert(errorMessage(reason)),
    )
  }
  const createFolder = (name: string) => {
    setEditing(null)
    window.oisin.folders.create(path, name).then(() => load(), (reason: unknown) => window.alert(errorMessage(reason)))
  }

  const documentOpen = tree.target?.kind === 'document' && samePath(tree.target.folder, path)
  const fileActive = (name: string) => tree.target?.kind === 'file' && samePath(tree.target.path, joinPath(path, name))
  const empty = model && model.sections.length === 0 && model.subdocuments.length === 0 && model.documentNotes.length === 0

  return (
    <li>
      <div className={`tree-row-wrap${depth === 0 ? ' tree-root' : ''}`}>
        <button
          type="button"
          className={`tree-row tree-dir${documentOpen ? ' selected' : ''}`}
          style={indent(depth)}
          onClick={() => {
            // A folder with sections opens as a document; other folders just expand or collapse.
            const wasOpen = open
            setOpen(true)
            void (async () => {
              const current = model ?? await window.oisin.folders.read(path).catch(() => null)
              if (current && current.sections.length > 0) tree.open(openDocument(identity, null))
              else if (wasOpen) setOpen(false)
            })()
          }}
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
            {open ? '▾' : '▸'}
          </span>
          {ordinal && <span className="tree-ordinal">{ordinal}</span>}
          <span className="tree-label">{title}</span>
        </button>
        <span className="tree-actions">
          <button type="button" className="icon-button" title="New section" onClick={() => { expand(); setEditing('section') }}>+</button>
          <button type="button" className="icon-button" title="New folder" onClick={() => { expand(); setEditing('folder') }}>⊞</button>
          {onRemoveRoot && (
            <button type="button" className="icon-button" title="Remove from workspace (files are not touched)" onClick={onRemoveRoot}>×</button>
          )}
        </span>
      </div>
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
}

export function WorkspaceTree({ roots, onAddRoot, onRemoveRoot, tab, onTab, outline, search, ...actions }: WorkspaceTreeProps) {
  return (
    <TreeContext.Provider value={actions}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <nav className="sidebar-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => onTab('files')}>Files</button>
            <button type="button" role="tab" aria-selected={tab === 'outline'} onClick={() => onTab('outline')} title="Every section and heading in the open document">Outline</button>
            <button type="button" role="tab" aria-selected={tab === 'search'} onClick={() => onTab('search')} title="Search all folders (Ctrl+Shift+F)">Search</button>
          </nav>
          <button type="button" className="icon-button" onClick={onAddRoot} title="Add folder…" aria-label="Add folder">+</button>
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
      </aside>
    </TreeContext.Provider>
  )
}
