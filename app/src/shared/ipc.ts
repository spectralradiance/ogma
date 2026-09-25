// Contracts shared by the main process, preload script and renderer.

/** Mirrors sidecar/oisin_ai/schemas.py. */
export interface GpuDevice {
  index: number
  name: string
  memory_total_mb: number
  memory_used_mb: number
  memory_free_mb: number
  driver_version: string
}

export interface GpuStatus {
  available: boolean
  devices: GpuDevice[]
  error: string | null
}

export interface TorchStatus {
  state: 'pending' | 'ready'
  installed: boolean | null
  version: string | null
  cuda_available: boolean
  cuda_version: string | null
  error: string | null
}

export interface ProviderStatus {
  id: string
  label: string
  kind: 'cloud' | 'local'
  configured: boolean
  detail: string | null
}

export interface SidecarHealth {
  status: 'ok'
  version: string
  python: string
  pid: number
  uptime_s: number
  gpu: GpuStatus
  torch: TorchStatus
  providers: ProviderStatus[]
  models_loaded: string[]
}

export type SidecarState = 'stopped' | 'starting' | 'online' | 'error'

export interface SidecarStatus {
  state: SidecarState
  health: SidecarHealth | null
  error: string | null
  restarts: number
}

export interface WorkspaceState {
  roots: string[]
}

export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252'
export type LineEnding = '\n' | '\r\n' | '\r'

/** How a file was stored on disk, so saving can restore it exactly. */
export interface TextFormat {
  encoding: TextEncodingName
  eol: LineEnding
  mixedEol: boolean
}

export interface DirEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
}

export interface TextDocument {
  path: string
  /** Always uses "\n" line breaks; `format` records what the file really uses. */
  text: string
  format: TextFormat
  mtimeMs: number
  size: number
}

export interface WriteRequest {
  path: string
  text: string
  format: TextFormat
  /** The mtime the document was loaded or last saved with; a mismatch means someone else changed the file. */
  expectedMtimeMs: number
  force?: boolean
}

export type WriteResult =
  | { ok: true; mtimeMs: number; size: number; format: TextFormat; notice: string | null }
  | { ok: false; reason: 'conflict'; diskMtimeMs: number }

/** Exposed to the renderer as `window.oisin` by the preload script. */
export interface OisinApi {
  sidecar: {
    getStatus(): Promise<SidecarStatus>
    getLogs(): Promise<string[]>
    restart(): Promise<void>
    onStatus(listener: (status: SidecarStatus) => void): () => void
  }
  workspace: {
    get(): Promise<WorkspaceState>
    addRoot(): Promise<WorkspaceState>
    removeRoot(path: string): Promise<WorkspaceState>
  }
  files: {
    listDir(path: string): Promise<DirEntry[]>
    read(path: string): Promise<TextDocument>
    write(request: WriteRequest): Promise<WriteResult>
  }
}

export const IPC = {
  sidecarStatus: 'sidecar:status',
  sidecarLogs: 'sidecar:logs',
  sidecarRestart: 'sidecar:restart',
  sidecarStatusChanged: 'sidecar:status-changed',
  workspaceGet: 'workspace:get',
  workspaceAddRoot: 'workspace:add-root',
  workspaceRemoveRoot: 'workspace:remove-root',
  filesListDir: 'files:list-dir',
  filesRead: 'files:read',
  filesWrite: 'files:write',
} as const

/** Custom protocol that serves images from inside workspace roots to the editor. */
export const LOCAL_FILE_SCHEME = 'oisin-file'
