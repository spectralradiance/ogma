import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { SectionInfo, SidecarStatus, WorkspaceState } from '../../shared/ipc'
import { joinPath } from '../../shared/paths'
import type { Heading } from '../../shared/text'
import { DocumentPane, type DocumentInfo, type DocumentPaneHandle } from './DocumentPane'
import { type AiWorkspace, AiPanel } from './AiPanel'
import { AiSettings } from './AiSettings'
import { type Drawer, DocumentView, ModeToggles, type PaneCallbacks } from './DocumentView'
import { type LexicalQuery, LexicalPanel } from './LexicalPanel'
import { readPref, writePref } from './prefs'
import { StatusBar } from './StatusBar'
import {
  type ActivePane, errorMessage, isOpenDocument, type OpenTarget, parseTarget, parseViewMode, sameTarget, type ViewMode,
} from './target'
import { WorkspaceTree } from './WorkspaceTree'

export function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState>({ roots: [] })
  const [target, setTarget] = useState<OpenTarget | null>(() => parseTarget(readPref('openTarget')))
  const [view, setView] = useState<ViewMode>(() => parseViewMode(readPref('documentView')))
  const [live, setLive] = useState(() => readPref('live') !== 'false')
  const [focusMode, setFocusMode] = useState(false)
  const [active, setActive] = useState<ActivePane | null>(null)
  const [infos, setInfos] = useState<Record<string, DocumentInfo | null>>({})
  const [headings, setHeadings] = useState<Record<string, Heading[]>>({})
  const [reloadToken, setReloadToken] = useState(0)
  const [drawer, setDrawer] = useState<Drawer | null>(() => {
    const stored = readPref('drawer')
    return stored === 'words' || stored === 'ai' ? stored : null
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [lexicalQuery, setLexicalQuery] = useState<LexicalQuery | null>(null)
  const drawerRef = useRef(drawer)
  const panes = useRef(new Map<string, DocumentPaneHandle>())
  const dirtyPanes = useRef(new Set<string>())
  const closing = useRef(false)

  useEffect(() => {
    let alive = true
    let pushed = false
    // Subscribe first so a status pushed while the initial fetch is in flight is not overwritten.
    const unsubscribe = window.oisin.sidecar.onStatus((next) => {
      pushed = true
      setStatus(next)
    })
    void window.oisin.sidecar.getStatus().then((initial) => {
      if (alive && !pushed) setStatus(initial)
    })
    void window.oisin.workspace.get().then((initial) => {
      if (alive) setWorkspace(initial)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const flushAll = useCallback(async () => {
    const results = await Promise.all([...panes.current.values()].map((handle) => handle.flush()))
    return results.every(Boolean)
  }, [])

  const changeTarget = useCallback((next: OpenTarget | null) => {
    setTarget(next)
    writePref('openTarget', next ? JSON.stringify(next) : null)
    setActive(next?.kind === 'file' ? { path: next.path, folder: null, stem: null } : null)
  }, [])

  const open = useCallback(async (next: OpenTarget) => {
    // Scrolling within the open document needs no save.
    if (next.kind === 'document' && sameTarget(target, next)) {
      changeTarget(next)
      return
    }
    if (sameTarget(target, next)) return
    const saved = await flushAll()
    if (!saved && !window.confirm('Some changes could not be saved. Open the other file anyway and lose them?')) return
    changeTarget(next)
  }, [target, flushAll, changeTarget])

  const runSectionOperation = useCallback(async (
    folder: string,
    stem: string,
    operation: () => Promise<SectionInfo | null>,
  ) => {
    const affectsOpen = isOpenDocument(target, folder)
    if (affectsOpen && !(await flushAll())) {
      window.alert('The open document has unsaved changes that could not be saved. Resolve that first.')
      return
    }
    try {
      const result = await operation()
      if (affectsOpen && target?.kind === 'document') {
        const followed = target.focusStem?.toLowerCase() === stem.toLowerCase()
        if (followed) changeTarget({ ...target, focusStem: result?.stem ?? null })
        setReloadToken((token) => token + 1)
      }
    } catch (error) {
      window.alert(errorMessage(error))
    }
  }, [target, flushAll, changeTarget])

  const changeView = useCallback((next: ViewMode) => {
    setView(next)
    writePref('documentView', next)
  }, [])

  const toggleLive = useCallback(() => {
    setLive((value) => {
      writePref('live', String(!value))
      return !value
    })
  }, [])
  const toggleFocus = useCallback(() => setFocusMode((value) => !value), [])

  const showDrawer = useCallback((next: Drawer | null) => {
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
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        event.stopPropagation()
        toggleDrawer('ai')
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
  }, [toggleLive, toggleFocus, focusMode, lookUpCurrentWord, toggleDrawer])

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
    },
    onInfo: (path, info) => setInfos((current) => ({ ...current, [path]: info })),
    onHeadings: (path, list) => setHeadings((current) => ({ ...current, [path]: list })),
    onDirtyChange: (path, dirty) => {
      if (dirty) dirtyPanes.current.add(path)
      else dirtyPanes.current.delete(path)
    },
    onActivePane: setActive,
    onSelectWord: (path, word) => {
      if (drawerRef.current === 'words') setLexicalQuery({ ...word, source: path })
    },
  }), [])

  const addRoot = () => void window.oisin.workspace.addRoot().then(setWorkspace)
  const removeRoot = (path: string) => void window.oisin.workspace.removeRoot(path).then(setWorkspace)

  const activePath = active?.path ?? null
  const activeInfo = activePath ? infos[activePath] ?? null : null
  const activeLabel = active?.stem && activePath
    ? (/-output\.[^.\\/]+$/i.test(activePath) ? 'Output' : 'Notes')
    : ''
  const mode = {
    live, focusMode, drawer, onToggleLive: toggleLive, onToggleFocus: toggleFocus, onToggleDrawer: toggleDrawer,
  }
  const shownDrawer = focusMode ? null : drawer
  const documentTitle = target?.kind === 'document' ? target.title : target?.kind === 'file' ? folderName(target.path) : ''

  const aiWorkspace: AiWorkspace = {
    focus: active
      ? { label: active.section ? `${active.section.title} (${activeLabel.toLowerCase()})` : folderName(active.path), inSection: Boolean(active.section) }
      : null,
    readActive: () => {
      const handle = active ? panes.current.get(active.path) : undefined
      if (!active || !handle) return null
      return { text: handle.getText(), selection: handle.getSelection(), document: documentTitle, section: active.section?.title ?? '' }
    },
    readSection: async () => {
      const section = active?.section
      const folder = active?.folder
      if (!section || !folder) return null
      const read = async (path: string) => panes.current.get(path)?.getText()
        ?? window.oisin.files.read(path, { allowMissing: true }).then((document) => document.text, () => '')
      const [notes, output] = await Promise.all([read(section.notesPath), read(section.outputPath)])
      // Document-wide notes (outline, sources) give the draft its context; capped to keep prompts reasonable.
      const model = await window.oisin.folders.read(folder).catch(() => null)
      const documentNotes = await Promise.all((model?.documentNotes ?? []).slice(0, 4).map(async (name) => {
        const text = await read(joinPath(folder, name))
        return `### ${name}\n${text.slice(0, 12_000)}`
      }))
      return { document: documentTitle, section: section.title, notes, output, documentNotes: documentNotes.join('\n\n') || '(none)' }
    },
    currentWord: () => (active ? panes.current.get(active.path)?.currentWord() ?? null : null),
    applyOutput: (text) => {
      const path = active?.section?.outputPath
      const handle = path ? panes.current.get(path) : undefined
      if (!handle) return false
      handle.replaceAll(text)
      return true
    },
    replaceWord: (word) => (active ? panes.current.get(active.path)?.replaceWord(word) ?? false : false),
  }

  return (
    <div className={`shell${focusMode ? ' shell-focus' : ''}${shownDrawer ? ' shell-panel' : ''}`}>
      {!focusMode && (
        <WorkspaceTree
          roots={workspace.roots}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          target={target}
          active={active}
          outline={activePath ? headings[activePath] ?? [] : []}
          open={(next) => void open(next)}
          reveal={(line) => (activePath ? panes.current.get(activePath)?.revealLine(line) : undefined)}
          runSectionOperation={runSectionOperation}
        />
      )}
      <main className="stage">
        {target?.kind === 'document' && (
          <DocumentView
            key={target.folder}
            target={target}
            view={view}
            onView={changeView}
            reloadToken={reloadToken}
            callbacks={callbacks}
            onOpenFile={(path) => void open({ kind: 'file', path })}
            {...mode}
          />
        )}
        {target?.kind === 'file' && (
          <DocumentPane
            key={target.path}
            ref={(handle) => callbacks.bindPane(target.path, handle)}
            path={target.path}
            live={live}
            focusMode={focusMode}
            headerActions={<ModeToggles {...mode} />}
            onInfo={(next) => callbacks.onInfo(target.path, next)}
            onHeadings={(list) => callbacks.onHeadings(target.path, list)}
            onDirtyChange={(dirty) => callbacks.onDirtyChange(target.path, dirty)}
            onFocus={() => setActive({ path: target.path, folder: null, stem: null })}
            onSelectWord={(word) => callbacks.onSelectWord(target.path, word)}
            onClose={() => changeTarget(null)}
          />
        )}
        {!target && (
          <div className="placeholder">
            <h1 className="wordmark">Oisín</h1>
            <p>{workspace.roots.length > 0 ? 'Choose a document or file from the sidebar.' : 'Add a folder of notes to begin.'}</p>
          </div>
        )}
      </main>
      {shownDrawer === 'words' && (
        <LexicalPanel
          query={lexicalQuery}
          onLookup={(word) => setLexicalQuery((current) => ({ word, context: '', source: current?.source ?? null }))}
          onReplace={(word) => (active ? panes.current.get(active.path)?.replaceWord(word) ?? false : false)}
          onClose={() => showDrawer(null)}
        />
      )}
      {shownDrawer === 'ai' && (
        <AiPanel
          workspace={aiWorkspace}
          providers={status?.health?.providers ?? []}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => showDrawer(null)}
        />
      )}
      {settingsOpen && <AiSettings providers={status?.health?.providers ?? []} onClose={() => setSettingsOpen(false)} />}
      <StatusBar
        status={status}
        documentInfo={activeInfo}
        documentLabel={activeLabel}
      />
    </div>
  )
}
