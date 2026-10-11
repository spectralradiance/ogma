import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type SectionSummary, splitSections } from '../../shared/document'
import { folderName } from '../../shared/format'
import type { SidecarStatus, WorkspaceState } from '../../shared/ipc'
import { stripNotes } from '../../shared/notes'
import { outlineMarkdown } from '../../shared/outline'
import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/preferences'
import { samePath } from '../../shared/paths'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { ExportDialog } from './ExportDialog'
import { type AiWorkspace, AiPanel } from './AiPanel'
import { AiSettings } from './AiSettings'
import type { WordInContext } from './editor/MarkdownEditor'
import type { NotesView } from './editor/notesBlocks'
import { type Drawer, SidePanel } from './SidePanel'
import { type LexicalQuery, LexicalPanel } from './LexicalPanel'
import { readPref, writePref } from './prefs'
import { StatsDialog } from './StatsDialog'
import { StatusBar } from './StatusBar'
import { type ActivePane, errorMessage, type OpenTarget, parseTarget, sameTarget } from './target'
import { IconButton, ModeToggles, NotesViewSwitch } from './Toolbar'
import { SearchPanel } from './SearchPanel'
import { ResizeHandle } from './ResizeHandle'
import { SettingsDialog } from './SettingsDialog'
import { OutlinePanel } from './OutlinePanel'
import { useOutline } from './useOutline'
import { type SidebarTab, WorkspaceTree } from './WorkspaceTree'
import { ChartColumn, X } from 'lucide-react'

const LEFT_WIDTH = { initial: 260, min: 180, max: 560 }
const RIGHT_WIDTH = { initial: 340, min: 260, max: 720 }
const RAIL_WIDTH = 40

/** How the open editor reports back to the app; panes are identified by file path. */
interface PaneCallbacks {
  bindPane: (path: string, handle: DocumentPaneHandle | null) => void
  onInfo: (path: string, info: DocumentInfo | null) => void
  onSections: (path: string, sections: SectionSummary[]) => void
  onDirtyChange: (path: string, dirty: boolean) => void
  onSelectWord: (path: string, word: WordInContext) => void
}

const storedWidth = (key: string, bounds: { initial: number; min: number; max: number }) => {
  const value = Number(readPref(key))
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max ? value : bounds.initial
}

/** Puts the appearance preferences into the CSS variables the styles and editors read. */
function applyAppearance(preferences: Preferences) {
  const { appearance } = preferences
  const root = document.documentElement.style
  document.documentElement.dataset.palette = appearance.palette
  root.setProperty('--font-serif', appearance.textFont)
  root.setProperty('--font-source', appearance.sourceFont)
  root.setProperty('--text-size', `${appearance.textSize}px`)
  root.setProperty('--text-line-height', String(appearance.lineHeight))
  root.setProperty('--text-width', `${appearance.textWidth}px`)
}

export function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState>({ roots: [] })
  const [target, setTarget] = useState<OpenTarget | null>(() => parseTarget(readPref('openTarget')))
  const [live, setLive] = useState(() => readPref('live') !== 'false')
  const [focusMode, setFocusMode] = useState(false)
  const [active, setActive] = useState<ActivePane | null>(null)
  const [infos, setInfos] = useState<Record<string, DocumentInfo | null>>({})
  const [docSections, setDocSections] = useState<Record<string, SectionSummary[]>>({})
  const [notesView, setNotesView] = useState<NotesView>(() => {
    const stored = readPref('notesView')
    return stored === 'notes' || stored === 'all' ? stored : 'output'
  })
  const [reloadToken, setReloadToken] = useState(0)
  const [todayWords, setTodayWords] = useState<number | null>(null)
  const [drawer, setDrawer] = useState<Drawer | null>(() => {
    const stored = readPref('drawer')
    return stored === 'words' || stored === 'ai' ? stored : null
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const savePreferencesTimer = useRef<number | undefined>(undefined)
  const [leftOpen, setLeftOpen] = useState(() => readPref('leftOpen') !== 'false')
  const [leftWidth, setLeftWidth] = useState(() => storedWidth('leftWidth', LEFT_WIDTH))
  const [rightWidth, setRightWidth] = useState(() => storedWidth('rightWidth', RIGHT_WIDTH))
  const lastDrawer = useRef<Drawer>(drawer ?? 'words')
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files')
  const [searchFocus, setSearchFocus] = useState(0)
  // A line to jump to once the pane for this file is ready (after opening a search result).
  const pendingReveal = useRef<{ path: string; line: number } | null>(null)
  const [lexicalQuery, setLexicalQuery] = useState<LexicalQuery | null>(null)
  const drawerRef = useRef(drawer)
  const panes = useRef(new Map<string, DocumentPaneHandle>())
  const dirtyPanes = useRef(new Set<string>())
  const closing = useRef(false)

  useEffect(() => {
    let alive = true
    let pushed = false
    // Subscribe first so a status pushed while the initial fetch is in flight is not overwritten.
    const unsubscribe = window.ogma.sidecar.onStatus((next) => {
      pushed = true
      setStatus(next)
    })
    void window.ogma.sidecar.getStatus().then((initial) => {
      if (alive && !pushed) setStatus(initial)
    })
    void window.ogma.preferences.get().then((stored) => {
      if (!alive) return
      applyAppearance(stored)
      setPreferences(stored)
    })
    void window.ogma.workspace.get().then((initial) => {
      if (alive) setWorkspace(initial)
    })
    const today = (days: { notes: number; output: number }[]) => {
      const last = days.at(-1)
      return last ? last.notes + last.output : 0
    }
    void window.ogma.stats.daily(1).then((days) => {
      if (alive) setTodayWords(today(days))
    })
    const unsubscribeStats = window.ogma.stats.onChanged((days) => setTodayWords(today(days)))
    return () => {
      alive = false
      unsubscribe()
      unsubscribeStats()
    }
  }, [])

  const flushAll = useCallback(async () => {
    const results = await Promise.all([...panes.current.values()].map((handle) => handle.flush()))
    return results.every(Boolean)
  }, [])

  const changeTarget = useCallback((next: OpenTarget | null) => {
    setTarget(next)
    writePref('openTarget', next ? JSON.stringify(next) : null)
    setActive(next ? { path: next.path } : null)
  }, [])

  const open = useCallback(async (next: OpenTarget) => {
    if (sameTarget(target, next)) return
    const saved = await flushAll()
    if (!saved && !window.confirm('Some changes could not be saved. Open the other file anyway and lose them?')) return
    changeTarget(next)
  }, [target, flushAll, changeTarget])

  const [undo, setUndo] = useState<{ undoId: string; title: string; path: string } | null>(null)

  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), 10000)
    return () => window.clearTimeout(timer)
  }, [undo])

  /** Moves a file to the Recycle Bin (closing it first if it is open) and offers Undo. */
  const deleteFile = useCallback(async (file: string) => {
    const isOpen = target !== null && samePath(target.path, file)
    if (isOpen && !(await flushAll())) {
      window.alert('The document has unsaved changes that could not be saved. Resolve that first.')
      return
    }
    try {
      const { undoId } = await window.ogma.files.trash(file)
      if (isOpen) changeTarget(null)
      setUndo({ undoId, title: folderName(file).replace(/\.md$/i, ''), path: file })
    } catch (error) {
      window.alert(errorMessage(error))
    }
  }, [target, flushAll, changeTarget])

  const undoDelete = useCallback(() => {
    if (!undo) return
    setUndo(null)
    window.ogma.files.restore(undo.undoId).then(
      () => changeTarget({ path: undo.path }),
      (error: unknown) => window.alert(errorMessage(error)),
    )
  }, [undo, changeTarget])

  const renameFolder = useCallback(async (folder: string, name: string) => {
    if (!(await flushAll())) {
      window.alert('Some changes could not be saved. Resolve that before renaming a folder.')
      return
    }
    try {
      const renamed = await window.ogma.folders.rename(folder, name)
      // Open files inside the folder keep working at their new location.
      const remap = (path: string) => {
        if (samePath(path, folder)) return renamed
        const inside = path.length > folder.length && samePath(path.slice(0, folder.length), folder) && /[\\/]/.test(path[folder.length])
        return inside ? renamed + path.slice(folder.length) : path
      }
      if (target) changeTarget({ path: remap(target.path) })
      setWorkspace(await window.ogma.workspace.get())
      setReloadToken((token) => token + 1)
    } catch (error) {
      window.alert(errorMessage(error))
    }
  }, [target, flushAll, changeTarget])

  const renameFile = useCallback(async (file: string, name: string) => {
    const isOpen = target !== null && samePath(target.path, file)
    if (isOpen && !(await flushAll())) {
      window.alert('The document has unsaved changes that could not be saved. Resolve that before renaming it.')
      return
    }
    try {
      const renamed = await window.ogma.files.rename(file, name)
      if (isOpen) changeTarget({ path: renamed })
    } catch (error) {
      window.alert(errorMessage(error))
    }
  }, [target, flushAll, changeTarget])

  const toggleLive = useCallback(() => {
    setLive((value) => {
      writePref('live', String(!value))
      return !value
    })
  }, [])
  const toggleFocus = useCallback(() => setFocusMode((value) => !value), [])
  const changeNotesView = useCallback((next: NotesView) => {
    setNotesView(next)
    writePref('notesView', next)
  }, [])

  const changePreferences = useCallback((next: Preferences) => {
    applyAppearance(next)
    setPreferences(next)
    // Sliders change many times a second; write once they settle.
    window.clearTimeout(savePreferencesTimer.current)
    savePreferencesTimer.current = window.setTimeout(() => void window.ogma.preferences.save(next), 300)
  }, [])

  const toggleLeft = useCallback(() => {
    setLeftOpen((open) => {
      writePref('leftOpen', String(!open))
      return !open
    })
  }, [])
  const resizeLeft = useCallback((width: number) => {
    setLeftWidth(width)
    writePref('leftWidth', String(width))
  }, [])
  const resizeRight = useCallback((width: number) => {
    setRightWidth(width)
    writePref('rightWidth', String(width))
  }, [])

  const showDrawer = useCallback((next: Drawer | null) => {
    if (next) lastDrawer.current = next
    setDrawer(next)
    drawerRef.current = next
    writePref('drawer', next)
  }, [])
  const toggleDrawer = useCallback((kind: Drawer) => showDrawer(drawerRef.current === kind ? null : kind), [showDrawer])

  /** Ctrl+D: look up the word at the cursor (opening the panel), or toggle the panel when there is none. */
  const lookUpCurrentWord = useCallback(() => {
    const path = active?.path
    const found = path ? panes.current.get(path)?.currentWord() : null
    if (found) {
      setLexicalQuery({ ...found, source: path ?? null })
      showDrawer('words')
    } else {
      toggleDrawer('words')
    }
  }, [active, showDrawer, toggleDrawer])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault()
        event.stopPropagation()
        toggleLive()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        event.stopPropagation()
        lookUpCurrentWord()
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        setFocusMode(false)
        setSidebarTab('search')
        setSearchFocus((count) => count + 1)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        event.stopPropagation()
        toggleDrawer('ai')
      } else if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        event.stopPropagation()
        setAppSettingsOpen(true)
      } else if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
        event.preventDefault()
        event.stopPropagation()
        toggleLeft()
      } else if (event.key === 'F8') {
        event.preventDefault()
        toggleFocus()
      } else if (event.key === 'Escape' && focusMode) {
        setFocusMode(false)
      }
    }
    // Capture phase so these win over CodeMirror's own bindings (Ctrl+/ toggles comments there).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleLive, toggleFocus, focusMode, lookUpCurrentWord, toggleDrawer, toggleLeft])

  useEffect(() => {
    // Hold the window open until pending edits are on disk.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyPanes.current.size === 0 || closing.current) return
      event.preventDefault()
      void flushAll().then((saved) => {
        if (saved || window.confirm('Some changes could not be saved. Close anyway and lose them?')) {
          closing.current = true
          window.close()
        }
      })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushAll])

  const callbacks = useMemo<PaneCallbacks>(() => ({
    bindPane: (path, handle) => {
      if (handle) panes.current.set(path, handle)
      else panes.current.delete(path)
      const reveal = pendingReveal.current
      if (handle && reveal && samePath(reveal.path, path)) {
        pendingReveal.current = null
        // Give the editor a moment to load its text before moving the cursor.
        window.setTimeout(() => handle.revealLine(reveal.line), 350)
      }
    },
    onInfo: (path, info) => setInfos((current) => ({ ...current, [path]: info })),
    onSections: (path, list) => setDocSections((current) => ({ ...current, [path]: list })),
    onDirtyChange: (path, dirty) => {
      if (dirty) dirtyPanes.current.add(path)
      else dirtyPanes.current.delete(path)
    },
    onSelectWord: (path, word) => {
      if (drawerRef.current === 'words') setLexicalQuery({ ...word, source: path })
    },
  }), [])

  /** Opens a file at a line (a search result or an outline entry). */
  const openAt = useCallback(async (hit: { path: string; line: number }) => {
    const existing = panes.current.get(hit.path)
    if (existing) {
      pendingReveal.current = null
      window.setTimeout(() => existing.revealLine(hit.line), 150)
    } else {
      pendingReveal.current = { path: hit.path, line: hit.line }
    }
    await open({ path: hit.path })
  }, [open])

  const addRoot = () => void window.ogma.workspace.addRoot().then(setWorkspace)
  const removeRoot = (path: string) => void window.ogma.workspace.removeRoot(path).then(setWorkspace)

  const activePath = active?.path ?? null
  const outline = useOutline(target, docSections, reloadToken)
  const activeInfo = activePath ? infos[activePath] ?? null : null
  const mode = { live, focusMode, onToggleLive: toggleLive, onToggleFocus: toggleFocus }
  const documentTitle = target ? folderName(target.path).replace(/\.[^.]+$/, '') : ''
  // What Settings → Export exports: the open document. Notes are left out of the output.
  const exportTarget = target ? { path: target.path, title: documentTitle } : null
  const shownDrawer = focusMode ? null : drawer

  const aiWorkspace: AiWorkspace = {
    focus: active ? { label: folderName(active.path), inSection: true } : null,
    readActive: () => {
      const handle = active ? panes.current.get(active.path) : undefined
      if (!active || !handle) return null
      // Notes blocks are the writer's scaffolding, not text to analyze.
      return {
        text: stripNotes(handle.getText()),
        selection: handle.getSelection(),
        document: documentTitle,
        section: handle.currentSection()?.title ?? '',
      }
    },
    readSection: async () => {
      // The section under the cursor; its notes blocks are the notes.
      const handle = active ? panes.current.get(active.path) : undefined
      const current = handle?.currentSection()
      if (!active || !handle || !current) return null
      const preface = splitSections(handle.getText()).find((candidate) => candidate.title === null)?.notes
      return {
        document: documentTitle,
        section: current.title ?? documentTitle,
        notes: current.notes,
        output: current.output,
        documentNotes: preface || '(none)',
        target: { path: active.path, index: current.index },
      }
    },
    currentWord: () => (active ? panes.current.get(active.path)?.currentWord() ?? null : null),
    suggestOutput: (target, text, label) => panes.current.get(target.path)?.propose(text, label, target.index) ?? null,
    replaceWord: (word) => (active ? panes.current.get(active.path)?.replaceWord(word) ?? false : false),
    outline: outline && outline.sections.some((section) => section.title !== null)
      ? { title: outline.title, sections: outline.sections.length, markdown: () => outlineMarkdown(outline.title, outline.sections) }
      : null,
    agent: {
      openFiles: () => [...panes.current].map(([path, handle]) => ({
        path, focused: active ? samePath(active.path, path) : false, text: handle.getText(),
      })),
      read: async (path) => {
        const open = [...panes.current].find(([openPath]) => samePath(openPath, path))
        if (open) return open[1].getText()
        return window.ogma.files.read(path).then((document) => document.text, () => null)
      },
      outline: () => aiWorkspace.outline?.markdown() ?? null,
      search: async (query) => {
        await window.ogma.search.sync()
        return window.ogma.search.query(query)
      },
      suggestEdit: (path, oldText, newText, label, snapshot) => {
        const handle = panes.current.get(path)
        return handle ? handle.proposeEdit(oldText, newText, label, snapshot) : { error: 'That file is no longer open.' }
      },
    },
  }

  return (
    <div
      className={`shell${focusMode ? ' shell-focus' : ''}`}
      style={focusMode ? undefined : {
        gridTemplateColumns: `${leftOpen ? leftWidth : RAIL_WIDTH}px minmax(0, 1fr) ${shownDrawer ? rightWidth : RAIL_WIDTH}px`,
      }}
    >
      {!focusMode && (
        <WorkspaceTree
          roots={workspace.roots}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          target={target}
          open={(next) => void open(next)}
          renameFolder={renameFolder}
          renameFile={renameFile}
          deleteFile={deleteFile}
          tab={sidebarTab}
          onTab={setSidebarTab}
          collapsed={!leftOpen}
          onToggle={toggleLeft}
          resizer={(
            <ResizeHandle edge="right" width={leftWidth} min={LEFT_WIDTH.min} max={LEFT_WIDTH.max}
              onResize={resizeLeft} onReset={() => resizeLeft(LEFT_WIDTH.initial)} />
          )}
          outline={(
            <OutlinePanel outline={outline} onReveal={(path, line) => void openAt({ path, line })} />
          )}
          search={(
            <SearchPanel
              roots={workspace.roots}
              autoFocus={searchFocus > 0}
              key={searchFocus}
              onOpen={(hit) => void openAt(hit)}
              relatedSource={() => {
                const handle = active ? panes.current.get(active.path) : undefined
                if (!active || !handle) return null
                const text = handle.getSelection().trim() || handle.getText()
                return { label: folderName(active.path), text, exclude: [active.path] }
              }}
            />
          )}
        />
      )}
      <main className="stage">
        {target && (
          <DocumentPane
            key={target.path}
            ref={(handle) => callbacks.bindPane(target.path, handle)}
            path={target.path}
            live={live}
            focusMode={focusMode}
            notesView={notesView}
            onShowNotes={() => changeNotesView('notes')}
            headerActions={(
              <>
                <IconButton icon={ChartColumn} label="Statistics" title="Word counts per section, goal and daily progress" onClick={() => setShowStats(true)} />
                <NotesViewSwitch view={notesView} onView={changeNotesView} />
                <ModeToggles {...mode} />
              </>
            )}
            onInfo={(next) => callbacks.onInfo(target.path, next)}
            onSections={(list) => callbacks.onSections(target.path, list)}
            onDirtyChange={(dirty) => callbacks.onDirtyChange(target.path, dirty)}
            onFocus={() => setActive({ path: target.path })}
            onSelectWord={(word) => callbacks.onSelectWord(target.path, word)}
            onClose={() => changeTarget(null)}
          />
        )}
        {!target && (
          <div className="placeholder">
            <h1 className="wordmark">Ogma</h1>
            <p>{workspace.roots.length > 0 ? 'Choose a document from the sidebar.' : 'Add a folder to begin.'}</p>
          </div>
        )}
      </main>
      {!focusMode && (
        <SidePanel
          open={shownDrawer}
          onSelect={showDrawer}
          onClose={() => showDrawer(null)}
          onShow={() => showDrawer(lastDrawer.current)}
          resizer={(
            <ResizeHandle edge="left" width={rightWidth} min={RIGHT_WIDTH.min} max={RIGHT_WIDTH.max}
              onResize={resizeRight} onReset={() => resizeRight(RIGHT_WIDTH.initial)} />
          )}
          aiState={status?.state ?? 'starting'}
        >
          {shownDrawer === 'words' && (
            <LexicalPanel
              query={lexicalQuery}
              onLookup={(word) => setLexicalQuery((current) => ({ word, context: '', source: current?.source ?? null }))}
              onReplace={(word) => (active ? panes.current.get(active.path)?.replaceWord(word) ?? false : false)}
            />
          )}
          {shownDrawer === 'ai' && (
            <AiPanel
              workspace={aiWorkspace}
              status={status}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
        </SidePanel>
      )}
      {exporting && exportTarget && (
        <ExportDialog folder={exportTarget.path} title={exportTarget.title} flush={flushAll} onClose={() => setExporting(false)} />
      )}
      {showStats && target && (
        <StatsDialog
          path={target.path}
          title={documentTitle}
          onClose={() => setShowStats(false)}
          onOpenSection={(line) => {
            setShowStats(false)
            void openAt({ path: target.path, line })
          }}
        />
      )}
      {settingsOpen && <AiSettings status={status} onClose={() => setSettingsOpen(false)} />}
      <StatusBar
        documentInfo={activeInfo}
        todayWords={todayWords}
        panes={focusMode ? null : {
          left: leftOpen,
          right: shownDrawer !== null,
          onLeft: toggleLeft,
          onRight: () => showDrawer(shownDrawer ? null : lastDrawer.current),
        }}
        onSettings={() => setAppSettingsOpen(true)}
      />
      {undo && (
        <div
          className="fixed bottom-10 left-4 z-20 flex items-center gap-2.5 rounded-md border border-border bg-raised py-1.5 pr-2 pl-3.5 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
          role="status"
        >
          <span>Deleted “{undo.title}”.</span>
          <button type="button" onClick={undoDelete}>Undo</button>
          <button type="button" className="icon-button" onClick={() => setUndo(null)} aria-label="Dismiss"><X size={14} aria-hidden="true" /></button>
        </div>
      )}
      {appSettingsOpen && (
        <SettingsDialog
          preferences={preferences}
          onChange={changePreferences}
          onClose={() => setAppSettingsOpen(false)}
          exportTitle={exportTarget?.title ?? null}
          onExport={() => {
            setAppSettingsOpen(false)
            setExporting(true)
          }}
        />
      )}
    </div>
  )
}
