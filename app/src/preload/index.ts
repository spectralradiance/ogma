import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { IPC, type OisinApi, type SidecarStatus } from '../shared/ipc'

const api: OisinApi = {
  sidecar: {
    getStatus: () => ipcRenderer.invoke(IPC.sidecarStatus),
    getLogs: () => ipcRenderer.invoke(IPC.sidecarLogs),
    restart: () => ipcRenderer.invoke(IPC.sidecarRestart),
    onStatus: (listener) => {
      const handler = (_event: IpcRendererEvent, status: SidecarStatus): void => listener(status)
      ipcRenderer.on(IPC.sidecarStatusChanged, handler)
      return () => {
        ipcRenderer.removeListener(IPC.sidecarStatusChanged, handler)
      }
    },
  },
  workspace: {
    get: () => ipcRenderer.invoke(IPC.workspaceGet),
    addRoot: () => ipcRenderer.invoke(IPC.workspaceAddRoot),
    removeRoot: (path) => ipcRenderer.invoke(IPC.workspaceRemoveRoot, path),
  },
  files: {
    read: (path, options) => ipcRenderer.invoke(IPC.filesRead, path, options),
    write: (request) => ipcRenderer.invoke(IPC.filesWrite, request),
    onChanged: (listener) => {
      const handler = (_event: IpcRendererEvent, paths: string[]): void => listener(paths)
      ipcRenderer.on(IPC.filesChanged, handler)
      return () => {
        ipcRenderer.removeListener(IPC.filesChanged, handler)
      }
    },
  },
  folders: {
    read: (path) => ipcRenderer.invoke(IPC.foldersRead, path),
    create: (parent, name) => ipcRenderer.invoke(IPC.foldersCreate, parent, name),
  },
  sections: {
    create: (folder, title) => ipcRenderer.invoke(IPC.sectionsCreate, folder, title),
    rename: (folder, stem, title) => ipcRenderer.invoke(IPC.sectionsRename, folder, stem, title),
    move: (folder, stem, direction) => ipcRenderer.invoke(IPC.sectionsMove, folder, stem, direction),
    trash: (folder, stem) => ipcRenderer.invoke(IPC.sectionsTrash, folder, stem),
  },
}

contextBridge.exposeInMainWorld('oisin', api)
