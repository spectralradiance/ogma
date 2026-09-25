import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'

import { IPC, type WorkspaceState } from '../shared/ipc'
import { SettingsStore } from './settings'
import { SidecarManager } from './sidecar'
import { resolveSidecarPaths } from './sidecarUtil'
import { addRoot, removeRoot } from './workspaceRoots'

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
const sidecar = new SidecarManager(resolveSidecarPaths(app.getAppPath(), process.env, process.platform))
let mainWindow: BrowserWindow | null = null
let quitting = false

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
    }
    return workspaceState()
  })
  ipcMain.handle(IPC.workspaceRemoveRoot, (_event, path: unknown) => {
    if (typeof path !== 'string') throw new TypeError('path must be a string')
    settings.update({ workspaceRoots: removeRoot(settings.get().workspaceRoots, path, process.platform) })
    return workspaceState()
  })
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

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void sidecar.stop().finally(() => app.quit())
})

void app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void sidecar.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
