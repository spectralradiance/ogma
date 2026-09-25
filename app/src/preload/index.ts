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
    listDir: (path) => ipcRenderer.invoke(IPC.filesListDir, path),
    read: (path) => ipcRenderer.invoke(IPC.filesRead, path),
    write: (request) => ipcRenderer.invoke(IPC.filesWrite, request),
  },
}

contextBridge.exposeInMainWorld('oisin', api)
