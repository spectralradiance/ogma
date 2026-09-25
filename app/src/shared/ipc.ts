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
}

export const IPC = {
  sidecarStatus: 'sidecar:status',
  sidecarLogs: 'sidecar:logs',
  sidecarRestart: 'sidecar:restart',
  sidecarStatusChanged: 'sidecar:status-changed',
  workspaceGet: 'workspace:get',
  workspaceAddRoot: 'workspace:add-root',
  workspaceRemoveRoot: 'workspace:remove-root',
} as const
