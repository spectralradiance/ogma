import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { AiEvent } from '../shared/ai'
import { type DailyWords, IPC, type OisinApi, type SearchStatus, type SidecarStatus } from '../shared/ipc'

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
  dictionary: {
    status: () => ipcRenderer.invoke(IPC.dictionaryStatus),
    choose: () => ipcRenderer.invoke(IPC.dictionaryChoose),
    lookup: (word) => ipcRenderer.invoke(IPC.dictionaryLookup, word),
    search: (text, limit) => ipcRenderer.invoke(IPC.dictionarySearch, text, limit),
  },
  lexicon: {
    location: () => ipcRenderer.invoke(IPC.lexiconLocation),
    list: () => ipcRenderer.invoke(IPC.lexiconList),
    save: (entry) => ipcRenderer.invoke(IPC.lexiconSave, entry),
    remove: (word) => ipcRenderer.invoke(IPC.lexiconRemove, word),
    importAisling: () => ipcRenderer.invoke(IPC.lexiconImportAisling),
  },
  ai: {
    settings: () => ipcRenderer.invoke(IPC.aiSettings),
    saveConfig: (config) => ipcRenderer.invoke(IPC.aiSaveConfig, config),
    setKey: (name, value) => ipcRenderer.invoke(IPC.aiSetKey, name, value),
    setCompatBaseUrl: (url) => ipcRenderer.invoke(IPC.aiSetCompatBaseUrl, url),
    openPrompts: () => ipcRenderer.invoke(IPC.aiOpenPrompts),
    run: (request) => ipcRenderer.invoke(IPC.aiRun, request),
    cancel: (runId) => ipcRenderer.invoke(IPC.aiCancel, runId),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, runId: string, event: AiEvent): void => listener(runId, event)
      ipcRenderer.on(IPC.aiEvent, handler)
      return () => {
        ipcRenderer.removeListener(IPC.aiEvent, handler)
      }
    },
    unloadLocal: () => ipcRenderer.invoke(IPC.aiUnloadLocal),
  },
  stats: {
    document: (folder) => ipcRenderer.invoke(IPC.statsDocument, folder),
    setGoal: (folder, words) => ipcRenderer.invoke(IPC.statsSetGoal, folder, words),
    daily: (days) => ipcRenderer.invoke(IPC.statsDaily, days),
    onChanged: (listener) => {
      const handler = (_event: IpcRendererEvent, days: DailyWords[]): void => listener(days)
      ipcRenderer.on(IPC.statsChanged, handler)
      return () => {
        ipcRenderer.removeListener(IPC.statsChanged, handler)
      }
    },
  },
  history: {
    list: (path) => ipcRenderer.invoke(IPC.historyList, path),
    read: (path, id) => ipcRenderer.invoke(IPC.historyRead, path, id),
    snapshot: (path, text, label) => ipcRenderer.invoke(IPC.historySnapshot, path, text, label),
  },
  exports: {
    document: (folder, title, options) => ipcRenderer.invoke(IPC.exportDocument, folder, title, options),
    showInFolder: (path) => ipcRenderer.invoke(IPC.exportShow, path),
  },
  search: {
    status: () => ipcRenderer.invoke(IPC.searchStatus),
    sync: () => ipcRenderer.invoke(IPC.searchSync),
    query: (text) => ipcRenderer.invoke(IPC.searchQuery, text),
    related: (text, exclude) => ipcRenderer.invoke(IPC.searchRelated, text, exclude),
    onProgress: (listener) => {
      const handler = (_event: IpcRendererEvent, status: SearchStatus): void => listener(status)
      ipcRenderer.on(IPC.searchProgress, handler)
      return () => {
        ipcRenderer.removeListener(IPC.searchProgress, handler)
      }
    },
  },
  sections: {
    create: (folder, title) => ipcRenderer.invoke(IPC.sectionsCreate, folder, title),
    rename: (folder, stem, title) => ipcRenderer.invoke(IPC.sectionsRename, folder, stem, title),
    move: (folder, stem, direction) => ipcRenderer.invoke(IPC.sectionsMove, folder, stem, direction),
    trash: (folder, stem) => ipcRenderer.invoke(IPC.sectionsTrash, folder, stem),
  },
}

contextBridge.exposeInMainWorld('oisin', api)
