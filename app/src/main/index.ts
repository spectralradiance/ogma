import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type AiConfig, type AiRunRequest, type AiSettingsState, normalizeAiConfig, SECRET_NAMES, type SecretName } from '../shared/ai'
import { type DictionaryStatus, type ExportOptions, IPC, LOCAL_FILE_SCHEME, type LexiconEntry, type WorkspaceState, type WriteRequest } from '../shared/ipc'
import { pathFromLocalFileUrl } from '../shared/paths'
import { MARGIN_INCHES, normalizePreferences } from '../shared/preferences'
import type { LeadingHeading } from '../shared/text'
import { AiBridge } from './aiBridge'
import { Dictionary } from './dictionary'
import { buildExportMarkdown, collectDocument, writeExport } from './exporter'
import { BackupStore, PathGuard, readTextDocument, writeTextDocument } from './fileService'
import { LexiconStore } from './lexicon'
import { PromptStore } from './prompts'
import { SearchIndex } from './searchIndex'
import { SnapshotStore } from './snapshots'
import { WritingStats } from './stats'
import { SecretStore } from './secrets'
import { SettingsStore } from './settings'
import { SidecarManager } from './sidecar'
import { resolveSidecarPaths } from './sidecarUtil'
import { WorkspaceWatcher } from './watcher'
import { addRoot, removeRoot } from './workspaceRoots'
import {
  createFolder, createSection, mergeSections, moveSection, readFolder, renameSection, setSectionHeading, trashSection,
} from './workspaceService'

// Lets tests and experiments run against a throwaway profile instead of the real one.
if (process.env.OISIN_USER_DATA) {
  app.setPath('userData', process.env.OISIN_USER_DATA)
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// The default user agent embeds the product name "Oisín"; the non-ASCII "í" makes
// protocol.handle reject every request header set, so keep the header ASCII.
app.userAgentFallback = app.userAgentFallback.replace(/Ois[^/\s]*\//, 'Oisin/')

const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
const secrets = new SecretStore(join(app.getPath('userData'), 'keys.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted),
})
const sidecar = new SidecarManager(resolveSidecarPaths(app.getAppPath(), process.env, process.platform), () => ({
  ...secrets.env(),
  ...(settings.get().compatBaseUrl ? { OISIN_COMPAT_BASE_URL: settings.get().compatBaseUrl } : {}),
}))
const prompts = new PromptStore(join(app.getPath('userData'), 'prompts'))
const snapshots = new SnapshotStore(join(app.getPath('userData'), 'snapshots'))
const writingStats = new WritingStats(join(app.getPath('userData'), 'stats.json'))
const ai = new AiBridge({
  connection: () => sidecar.connection(),
  prompts,
  config: () => settings.get().ai,
  historyDir: join(app.getPath('userData'), 'ai-history'),
  send: (runId, event) => mainWindow?.webContents.send(IPC.aiEvent, runId, event),
})
const guard = new PathGuard(() => settings.get().workspaceRoots)
const backupsDir = join(app.getPath('userData'), 'backups')
const backups = new BackupStore(backupsDir, guard)
const BACKUP_RETENTION_DAYS = 30
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])
const watcher = new WorkspaceWatcher((paths) => {
  mainWindow?.webContents.send(IPC.filesChanged, paths)
  // Keep the search index current once it has been built.
  if (searchIndex?.status().ready) {
    for (const changed of paths) void searchIndex.updateFile(changed, settings.get().workspaceRoots).catch(() => {})
  }
})
let searchIndex: SearchIndex | null = null

function index(): SearchIndex {
  searchIndex ??= new SearchIndex(join(app.getPath('userData'), 'search.db'))
  return searchIndex
}

function syncIndex(): Promise<void> {
  return index().sync(settings.get().workspaceRoots, (status) => mainWindow?.webContents.send(IPC.searchProgress, status))
}

function rootsChanged(): void {
  watcher.setRoots(settings.get().workspaceRoots)
  if (searchIndex?.status().ready) void syncIndex()
}
let mainWindow: BrowserWindow | null = null
let quitting = false
let dictionary: Dictionary | null = null
let dictionaryError: string | null = null

function aiSettingsState(): AiSettingsState {
  return {
    config: settings.get().ai,
    keys: secrets.status(),
    compatBaseUrl: settings.get().compatBaseUrl,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    promptsDir: prompts.location,
  }
}

/** Renders HTML to PDF in a hidden window with scripts disabled. */
async function printToPdf(html: string): Promise<Buffer> {
  const file = join(app.getPath('temp'), `oisin-export-${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } })
  try {
    await window.loadFile(file)
    const style = settings.get().preferences.export
    const margin = MARGIN_INCHES[style.margins]
    return await window.webContents.printToPDF({
      pageSize: style.pageSize,
      printBackground: true,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
    })
  } finally {
    window.destroy()
    await rm(file, { force: true })
  }
}

function lexicon(): LexiconStore {
  return new LexiconStore(settings.get().lexiconDir ?? join(app.getPath('userData'), 'lexicon'))
}

/** Where to look for wiktionary.db: the saved choice, an override, then ogma's copy next to this project. */
function dictionaryCandidates(): string[] {
  return [
    settings.get().dictionaryPath,
    process.env.OISIN_DICTIONARY_DB,
    resolve(app.getAppPath(), '..', '..', 'ogma', 'data', 'wiktionary.db'),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function openDictionary(candidates = dictionaryCandidates()): DictionaryStatus {
  dictionary?.close()
  dictionary = null
  dictionaryError = null
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      dictionary = new Dictionary(candidate)
      if (settings.get().dictionaryPath !== candidate) settings.update({ dictionaryPath: candidate })
      return dictionaryStatus()
    } catch (error) {
      dictionaryError = error instanceof Error ? error.message : String(error)
    }
  }
  dictionaryError ??= 'No wiktionary.db found. Choose one, or build it with ogma’s setup:dict script.'
  return dictionaryStatus()
}

function dictionaryStatus(): DictionaryStatus {
  return { available: dictionary !== null, path: dictionary ? settings.get().dictionaryPath : null, error: dictionary ? null : dictionaryError }
}

function requireDictionary(): Dictionary {
  if (!dictionary) openDictionary()
  if (!dictionary) throw new Error(dictionaryError ?? 'Dictionary unavailable.')
  return dictionary
}

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

function registerLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const requested = pathFromLocalFileUrl(request.url)
    if (!requested || !IMAGE_EXTENSIONS.has(extname(requested).toLowerCase())) {
      return new Response('Not found', { status: 404 })
    }
    let target: string
    try {
      target = guard.resolve(requested)
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

function workspaceState(): WorkspaceState {
  return { roots: settings.get().workspaceRoots }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Oisín',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d1c' : '#f7f6f2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow = window
}

function registerIpc(): void {
  ipcMain.handle(IPC.preferencesGet, () => settings.get().preferences)
  ipcMain.handle(IPC.preferencesSave, (_event, value: unknown) => {
    const preferences = normalizePreferences(value)
    settings.update({ preferences })
    // Switches prefers-color-scheme in every window, so the CSS follows.
    nativeTheme.themeSource = preferences.appearance.theme
    return preferences
  })
  ipcMain.handle(IPC.sidecarStatus, () => sidecar.getStatus())
  ipcMain.handle(IPC.sidecarLogs, () => sidecar.getLogs())
  ipcMain.handle(IPC.sidecarRestart, () => sidecar.restart())
  ipcMain.handle(IPC.sidecarStop, () => sidecar.stop())
  ipcMain.handle(IPC.sidecarInstallTorch, (_event, index: unknown) => sidecar.installTorch(text(index)))

  ipcMain.handle(IPC.workspaceGet, () => workspaceState())
  ipcMain.handle(IPC.workspaceAddRoot, async (event) => {
    const options: OpenDialogOptions = {
      title: 'Add folder to workspace',
      properties: ['openDirectory', 'multiSelections'],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (!result.canceled) {
      const roots = result.filePaths.reduce(
        (current, path) => addRoot(current, path, process.platform),
        settings.get().workspaceRoots,
      )
      settings.update({ workspaceRoots: roots })
      rootsChanged()
    }
    return workspaceState()
  })
  ipcMain.handle(IPC.workspaceRemoveRoot, (_event, path: unknown) => {
    if (typeof path !== 'string') throw new TypeError('path must be a string')
    settings.update({ workspaceRoots: removeRoot(settings.get().workspaceRoots, path, process.platform) })
    rootsChanged()
    return workspaceState()
  })

  ipcMain.handle(IPC.filesRead, (_event, path: unknown, options?: { allowMissing?: boolean }) =>
    readTextDocument(guard.resolve(path), options?.allowMissing === true))
  ipcMain.handle(IPC.filesWrite, async (_event, request: WriteRequest) => {
    const target = guard.resolve(request?.path)
    const before = await readTextDocument(target, true).then((document) => (document.mtimeMs === null ? null : document.text), () => null)
    const result = await writeTextDocument(target, request, backups)
    if (result.ok) {
      void snapshots.afterSave(target, request.text).catch(() => {})
      writingStats.recordSave(target, before, request.text)
      mainWindow?.webContents.send(IPC.statsChanged, writingStats.daily())
    }
    return result
  })
  ipcMain.handle(IPC.statsDocument, (_event, folder: unknown) => writingStats.documentStats(guard.resolve(folder)))
  ipcMain.handle(IPC.statsSetGoal, (_event, folder: unknown, words: unknown) => {
    const target = guard.resolve(folder)
    writingStats.setGoal(target, typeof words === 'number' && Number.isFinite(words) ? words : null)
    return writingStats.documentStats(target)
  })
  ipcMain.handle(IPC.statsDaily, (_event, days: unknown) => writingStats.daily(typeof days === 'number' ? Math.min(Math.max(days, 1), 366) : 14))
  ipcMain.handle(IPC.historyList, (_event, file: unknown) => snapshots.list(guard.resolve(file)))
  ipcMain.handle(IPC.historyRead, (_event, file: unknown, id: unknown) => snapshots.read(guard.resolve(file), text(id)))
  ipcMain.handle(IPC.historySnapshot, (_event, file: unknown, content: unknown, label: unknown) =>
    snapshots.manual(guard.resolve(file), text(content), typeof label === 'string' ? label : ''))

  ipcMain.handle(IPC.foldersRead, (_event, folder: unknown) => readFolder(guard.resolve(folder)))
  ipcMain.handle(IPC.foldersCreate, (_event, parent: unknown, name: unknown) =>
    createFolder(guard.resolve(parent), text(name)))
  ipcMain.handle(IPC.sectionsCreate, (_event, folder: unknown, title: unknown) =>
    createSection(guard.resolve(folder), text(title)))
  ipcMain.handle(IPC.sectionsRename, (_event, folder: unknown, stem: unknown, title: unknown) =>
    renameSection(guard.resolve(folder), text(stem), text(title), backups))
  ipcMain.handle(IPC.sectionsSetHeading, (_event, folder: unknown, stem: unknown, heading: unknown) =>
    setSectionHeading(guard.resolve(folder), text(stem), leadingHeading(heading), backups))
  ipcMain.handle(IPC.sectionsMove, (_event, folder: unknown, stem: unknown, direction: unknown) => {
    if (direction !== 'up' && direction !== 'down') throw new TypeError('direction must be up or down')
    return moveSection(guard.resolve(folder), text(stem), direction)
  })
  ipcMain.handle(IPC.dictionaryStatus, () => (dictionary ? dictionaryStatus() : openDictionary()))
  ipcMain.handle(IPC.dictionaryChoose, async (event) => {
    const options: OpenDialogOptions = {
      title: 'Choose wiktionary.db',
      properties: ['openFile'],
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? dictionaryStatus() : openDictionary([result.filePaths[0]])
  })
  ipcMain.handle(IPC.dictionaryLookup, (_event, word: unknown) => requireDictionary().lookup(text(word)))
  ipcMain.handle(IPC.dictionarySearch, (_event, query: unknown, limit: unknown) =>
    requireDictionary().search(text(query), typeof limit === 'number' ? limit : 20))

  ipcMain.handle(IPC.lexiconLocation, () => lexicon().location)
  ipcMain.handle(IPC.lexiconList, () => lexicon().list())
  ipcMain.handle(IPC.lexiconSave, (_event, entry: LexiconEntry) => {
    if (!entry || typeof entry.word !== 'string') throw new TypeError('Expected a lexicon entry.')
    return lexicon().save(entry)
  })
  ipcMain.handle(IPC.lexiconRemove, (_event, word: unknown) => lexicon().remove(text(word), (file) => shell.trashItem(file)))
  ipcMain.handle(IPC.lexiconImportAisling, async (event) => {
    const options: OpenDialogOptions = { title: 'Choose Aisling’s Vocabulary folder', properties: ['openDirectory'] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : lexicon().importAisling(result.filePaths[0])
  })

  ipcMain.handle(IPC.exportDocument, async (event, folder: unknown, title: unknown, options: ExportOptions) => {
    const source = guard.resolve(folder)
    if (!options || !['md', 'html', 'pdf'].includes(options.format) || !['output', 'notes'].includes(options.content)) {
      throw new TypeError('Invalid export options.')
    }
    const name = text(title).replace(/[<>:"/\\|?*]/g, '_') || 'document'
    const suffix = options.content === 'notes' ? ' (notes)' : ''
    const dialogOptions = {
      title: 'Export document',
      defaultPath: join(app.getPath('documents'), `${name}${suffix}.${options.format}`),
      filters: [{ name: options.format.toUpperCase(), extensions: [options.format] }],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const choice = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (choice.canceled || !choice.filePath) return null
    const { sections, skipped } = await collectDocument(source, options)
    const markdown = buildExportMarkdown(text(title), sections, options.includeTitle, options.content === 'notes')
    await writeExport(choice.filePath, options.format, markdown, text(title), source, printToPdf, settings.get().preferences.export)
    return { path: choice.filePath, sections: sections.length, skipped }
  })
  ipcMain.handle(IPC.exportShow, (_event, file: unknown) => shell.showItemInFolder(text(file)))

  ipcMain.handle(IPC.searchStatus, () => index().status())
  ipcMain.handle(IPC.searchSync, async () => {
    await syncIndex()
    return index().status()
  })
  ipcMain.handle(IPC.searchQuery, (_event, query: unknown) => index().search(text(query)))
  ipcMain.handle(IPC.searchRelated, (_event, passage: unknown, exclude: unknown) =>
    index().related(text(passage), Array.isArray(exclude) ? exclude.filter((item): item is string => typeof item === 'string') : []))

  ipcMain.handle(IPC.aiSettings, () => aiSettingsState())
  ipcMain.handle(IPC.aiSaveConfig, (_event, config: AiConfig) => {
    settings.update({ ai: normalizeAiConfig(config) })
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiSetKey, async (_event, name: unknown, value: unknown) => {
    if (!SECRET_NAMES.includes(name as SecretName)) throw new TypeError('Unknown key name.')
    secrets.set(name as SecretName, typeof value === 'string' ? value : null)
    await sidecar.restart()
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiSetCompatBaseUrl, async (_event, url: unknown) => {
    const value = text(url).trim()
    if (value && !/^https?:\/\//i.test(value)) throw new Error('The base URL must start with http:// or https://')
    settings.update({ compatBaseUrl: value })
    await sidecar.restart()
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiOpenPrompts, async () => {
    await prompts.ensureDefaults()
    await shell.openPath(prompts.location)
  })
  ipcMain.handle(IPC.aiRun, (_event, request: AiRunRequest) => {
    if (!request || typeof request.task !== 'string' || typeof request.variables !== 'object') throw new TypeError('Expected an AI run request.')
    return ai.start(request)
  })
  ipcMain.handle(IPC.aiCancel, (_event, runId: unknown) => ai.cancel(text(runId)))
  ipcMain.handle(IPC.aiUnloadLocal, async () => {
    const connection = sidecar.connection()
    if (!connection) return
    await fetch(`${connection.baseUrl}/ai/local/unload`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` } })
  })

  ipcMain.handle(IPC.sectionsMerge, (_event, folder: unknown, stem: unknown, laterStem: unknown) =>
    mergeSections(guard.resolve(folder), text(stem), text(laterStem), backups, (file) => shell.trashItem(guard.resolve(file))))
  ipcMain.handle(IPC.sectionsTrash, (_event, folder: unknown, stem: unknown) =>
    trashSection(guard.resolve(folder), text(stem), (file) => shell.trashItem(guard.resolve(file))))
}

function leadingHeading(value: unknown): LeadingHeading | null {
  if (value === null) return null
  const candidate = value as Partial<LeadingHeading> | undefined
  if (typeof candidate?.level !== 'number' || typeof candidate.text !== 'string') throw new TypeError('Expected a heading or null.')
  return { level: candidate.level, text: candidate.text }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string.')
  return value
}

sidecar.on('status', (status) => {
  mainWindow?.webContents.send(IPC.sidecarStatusChanged, status)
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// will-quit fires only after every window has closed, i.e. after the renderer has
// flushed unsaved edits, so the sidecar is not stopped if a window refuses to close.
app.on('will-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  watcher.close()
  dictionary?.close()
  searchIndex?.close()
  void sidecar.stop().finally(() => app.quit())
})

void app.whenReady().then(() => {
  nativeTheme.themeSource = settings.get().preferences.appearance.theme
  registerLocalFileProtocol()
  registerIpc()
  void BackupStore.prune(backupsDir, BACKUP_RETENTION_DAYS)
  void prompts.ensureDefaults()
  createWindow()
  watcher.setRoots(settings.get().workspaceRoots)
  void sidecar.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
