import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell, type OpenDialogOptions } from 'electron'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { IPC, LOCAL_FILE_SCHEME, type WorkspaceState, type WriteRequest } from '../shared/ipc'
import { pathFromLocalFileUrl } from '../shared/paths'
import { BackupStore, PathGuard, readTextDocument, writeTextDocument } from './fileService'
import { SettingsStore } from './settings'
import { SidecarManager } from './sidecar'
import { resolveSidecarPaths } from './sidecarUtil'
import { WorkspaceWatcher } from './watcher'
import { addRoot, removeRoot } from './workspaceRoots'
import { createFolder, createSection, moveSection, readFolder, renameSection, trashSection } from './workspaceService'

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
const sidecar = new SidecarManager(resolveSidecarPaths(app.getAppPath(), process.env, process.platform))
const guard = new PathGuard(() => settings.get().workspaceRoots)
const backupsDir = join(app.getPath('userData'), 'backups')
const backups = new BackupStore(backupsDir, guard)
const BACKUP_RETENTION_DAYS = 30
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])
const watcher = new WorkspaceWatcher((paths) => mainWindow?.webContents.send(IPC.filesChanged, paths))
let mainWindow: BrowserWindow | null = null
let quitting = false

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
  ipcMain.handle(IPC.sidecarStatus, () => sidecar.getStatus())
  ipcMain.handle(IPC.sidecarLogs, () => sidecar.getLogs())
  ipcMain.handle(IPC.sidecarRestart, () => sidecar.restart())

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
      watcher.setRoots(roots)
    }
    return workspaceState()
  })
  ipcMain.handle(IPC.workspaceRemoveRoot, (_event, path: unknown) => {
    if (typeof path !== 'string') throw new TypeError('path must be a string')
    settings.update({ workspaceRoots: removeRoot(settings.get().workspaceRoots, path, process.platform) })
    watcher.setRoots(settings.get().workspaceRoots)
    return workspaceState()
  })

  ipcMain.handle(IPC.filesRead, (_event, path: unknown, options?: { allowMissing?: boolean }) =>
    readTextDocument(guard.resolve(path), options?.allowMissing === true))
  ipcMain.handle(IPC.filesWrite, (_event, request: WriteRequest) =>
    writeTextDocument(guard.resolve(request?.path), request, backups))

  ipcMain.handle(IPC.foldersRead, (_event, folder: unknown) => readFolder(guard.resolve(folder)))
  ipcMain.handle(IPC.foldersCreate, (_event, parent: unknown, name: unknown) =>
    createFolder(guard.resolve(parent), text(name)))
  ipcMain.handle(IPC.sectionsCreate, (_event, folder: unknown, title: unknown) =>
    createSection(guard.resolve(folder), text(title)))
  ipcMain.handle(IPC.sectionsRename, (_event, folder: unknown, stem: unknown, title: unknown) =>
    renameSection(guard.resolve(folder), text(stem), text(title)))
  ipcMain.handle(IPC.sectionsMove, (_event, folder: unknown, stem: unknown, direction: unknown) => {
    if (direction !== 'up' && direction !== 'down') throw new TypeError('direction must be up or down')
    return moveSection(guard.resolve(folder), text(stem), direction)
  })
  ipcMain.handle(IPC.sectionsTrash, (_event, folder: unknown, stem: unknown) =>
    trashSection(guard.resolve(folder), text(stem), (file) => shell.trashItem(guard.resolve(file))))
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
  void sidecar.stop().finally(() => app.quit())
})

void app.whenReady().then(() => {
  registerLocalFileProtocol()
  registerIpc()
  void BackupStore.prune(backupsDir, BACKUP_RETENTION_DAYS)
  createWindow()
  watcher.setRoots(settings.get().workspaceRoots)
  void sidecar.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
