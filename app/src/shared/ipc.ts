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
  python_prefix: string
  in_virtualenv: boolean
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

export interface TextDocument {
  path: string
  /** Always uses "\n" line breaks; `format` records what the file really uses. */
  text: string
  format: TextFormat
  /** null when the file does not exist yet (read with `allowMissing`). */
  mtimeMs: number | null
  size: number
}

export interface WriteRequest {
  path: string
  text: string
  format: TextFormat
  /**
   * The mtime the document was loaded or last saved with; a mismatch means someone
   * else changed the file. null means the file is expected not to exist yet.
   */
  expectedMtimeMs: number | null
  force?: boolean
}

export interface SectionInfo {
  /** File name without the -notes/-output suffix and extension, e.g. "1 the first era". */
  stem: string
  ordinal: string | null
  separator: string
  title: string
  /** Existing file names (in the document folder), or null when not created yet. */
  notes: string | null
  output: string | null
  /** The names to use, whether or not the files exist yet. */
  notesName: string
  outputName: string
}

export interface SubdocumentInfo {
  name: string
  ordinal: string | null
  title: string
}

/** One document folder: its sub-documents, ordered sections, and document-wide notes. */
export interface FolderModel {
  subdocuments: SubdocumentInfo[]
  sections: SectionInfo[]
  documentNotes: string[]
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
    read(path: string, options?: { allowMissing?: boolean }): Promise<TextDocument>
    write(request: WriteRequest): Promise<WriteResult>
    /** Paths changed on disk under any workspace root (debounced). */
    onChanged(listener: (paths: string[]) => void): () => void
  }
  folders: {
    read(path: string): Promise<FolderModel>
    create(parent: string, name: string): Promise<string>
  }
  sections: {
    create(folder: string, title: string): Promise<SectionInfo>
    rename(folder: string, stem: string, title: string): Promise<SectionInfo>
    move(folder: string, stem: string, direction: 'up' | 'down'): Promise<SectionInfo>
    trash(folder: string, stem: string): Promise<void>
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
  filesRead: 'files:read',
  filesWrite: 'files:write',
  filesChanged: 'files:changed',
  foldersRead: 'folders:read',
  foldersCreate: 'folders:create',
  sectionsCreate: 'sections:create',
  sectionsRename: 'sections:rename',
  sectionsMove: 'sections:move',
  sectionsTrash: 'sections:trash',
} as const

/** Custom protocol that serves images from inside workspace roots to the editor. */
export const LOCAL_FILE_SCHEME = 'oisin-file'
