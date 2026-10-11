// Contracts shared by the main process, preload script and renderer.

/** Mirrors sidecar/ogma_ai/schemas.py. */
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

export type SidecarState = 'stopped' | 'starting' | 'online' | 'error' | 'installing'

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

export interface DictionarySense {
  glosses: string[]
  examples: { text: string; translation?: string }[]
}

export interface DictionaryEntry {
  id: number
  word: string
  pos: string | null
  etymology: string | null
  senses: DictionarySense[]
  ipa: string[]
  synonyms: string[]
  antonyms: string[]
  derived: string[]
  related: string[]
}

export interface DictionarySearchResult {
  word: string
  pos: string | null
  gloss: string
}

/** Progress of building the dictionary from Wiktionary (a large download, streamed straight into the database). */
export interface DictionaryDownload {
  state: 'idle' | 'downloading' | 'indexing' | 'done' | 'error'
  received: number
  total: number | null
  entries: number
  error: string | null
}

export interface DictionaryStatus {
  available: boolean
  path: string | null
  error: string | null
}

/** A word saved to the personal lexicon (one Markdown file per word). */
export interface LexiconEntry {
  word: string
  definition: string
  tags: string[]
  synonyms: string[]
  /** The sentence the word was found in. */
  context: string
  /** File the word was saved from, if any. */
  source: string | null
  /** ISO date. */
  added: string
  /** Free-form notes (the body of the Markdown file). */
  note: string
}

import type { AiConfig, AiEvent, AiRunRequest, AiSettingsState, SecretName } from './ai'
import type { Preferences } from './preferences'
import type { LeadingHeading } from './text'

export interface SearchHit {
  path: string
  /** 1-based line where the matching paragraph starts. */
  line: number
  /** Excerpt with matches wrapped in MATCH_START … MATCH_END (see main/searchIndex.ts). */
  snippet: string
}

export interface DailyWords {
  /** Local date, YYYY-MM-DD. */
  day: string
  /** Net words added (negative when more were cut). */
  notes: number
  output: number
}

export interface SectionStats {
  stem: string
  ordinal: string | null
  title: string
  notesWords: number
  outputWords: number
  /** ISO time either file last changed. */
  modified: string | null
}

export interface DocumentStats {
  sections: SectionStats[]
  notesWords: number
  outputWords: number
  /** Output word goal, if set. */
  goal: number | null
}

export interface SnapshotEntry {
  id: string
  /** ISO time the version was captured. */
  at: string
  words: number
  chars: number
  /** Set for manual snapshots; null for automatic ones. */
  label: string | null
}

export interface ExportOptions {
  format: 'md' | 'html' | 'pdf'
  /** Which file of each section to include. */
  content: 'output' | 'notes'
  includeTitle: boolean
}

export interface ConvertOutcome {
  /** The single-file document. */
  path: string
  /** False when it already existed and was left as it is. */
  created: boolean
  sections: number
  /** Nested documents inside the folder, which are not included. */
  subfolders: number
}

export interface ExportOutcome {
  path: string
  sections: number
  /** Sections left out because that file is empty or missing. */
  skipped: string[]
}

export interface SearchStatus {
  files: number
  indexing: boolean
  done: number
  total: number
  /** True once a full pass has completed this session. */
  ready: boolean
}

/** Exposed to the renderer as `window.ogma` by the preload script. */
export interface OgmaApi {
  preferences: {
    get(): Promise<Preferences>
    save(preferences: Preferences): Promise<Preferences>
  }
  sidecar: {
    getStatus(): Promise<SidecarStatus>
    getLogs(): Promise<string[]>
    restart(): Promise<void>
    stop(): Promise<void>
    /** Installs PyTorch from a CUDA wheel index (see shared/torch.ts), restarting the server around it. */
    installTorch(index: string): Promise<void>
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
    /** Renames the folder and returns its new path. */
    rename(path: string, name: string): Promise<string>
    read(path: string): Promise<FolderModel>
    create(parent: string, name: string): Promise<string>
    /** Writes the folder's sections into one Markdown file next to it (the folder is kept) and returns it. */
    convert(path: string): Promise<ConvertOutcome>
    /** The folder's single-file document, if it has been made; null otherwise. */
    singleDocument(path: string): Promise<string | null>
  }
  dictionary: {
    status(): Promise<DictionaryStatus>
    /** Lets the user pick a wiktionary.db file. */
    choose(): Promise<DictionaryStatus>
    /** Downloads Wiktionary and builds the database; resolves when it is ready to use. */
    download(): Promise<DictionaryStatus>
    cancelDownload(): Promise<void>
    onDownload(listener: (status: DictionaryDownload) => void): () => void
    lookup(word: string): Promise<DictionaryEntry[]>
    search(text: string, limit?: number): Promise<DictionarySearchResult[]>
  }
  lexicon: {
    location(): Promise<string>
    list(): Promise<LexiconEntry[]>
    save(entry: LexiconEntry): Promise<LexiconEntry>
    remove(word: string): Promise<void>
    /** Imports an Aisling Vocabulary folder chosen by the user; null if cancelled. */
    importAisling(): Promise<{ imported: number; skipped: number } | null>
  }
  ai: {
    settings(): Promise<AiSettingsState>
    saveConfig(config: AiConfig): Promise<AiSettingsState>
    /** Stores (or with null, clears) an API key; the AI server restarts to pick it up. */
    setKey(name: SecretName, value: string | null): Promise<AiSettingsState>
    setCompatBaseUrl(url: string): Promise<AiSettingsState>
    openPrompts(): Promise<void>
    /** Starts a run and returns its id; events arrive through onEvent. */
    run(request: AiRunRequest): Promise<string>
    cancel(runId: string): Promise<void>
    onEvent(listener: (runId: string, event: AiEvent) => void): () => void
    unloadLocal(): Promise<void>
  }
  stats: {
    document(folder: string): Promise<DocumentStats>
    setGoal(folder: string, words: number | null): Promise<DocumentStats>
    daily(days?: number): Promise<DailyWords[]>
    /** Fires after each save that changed the word count, with the last 14 days. */
    onChanged(listener: (days: DailyWords[]) => void): () => void
  }
  history: {
    /** Versions of a file, newest first. */
    list(path: string): Promise<SnapshotEntry[]>
    read(path: string, id: string): Promise<string>
    snapshot(path: string, text: string, label: string): Promise<SnapshotEntry>
  }
  exports: {
    /** Asks where to save, then writes the document; null if cancelled. */
    document(folder: string, title: string, options: ExportOptions): Promise<ExportOutcome | null>
    showInFolder(path: string): Promise<void>
  }
  search: {
    status(): Promise<SearchStatus>
    /** Starts (or joins) bringing the index up to date; resolves when done. */
    sync(): Promise<SearchStatus>
    query(text: string): Promise<SearchHit[]>
    related(text: string, exclude: string[]): Promise<SearchHit[]>
    onProgress(listener: (status: SearchStatus) => void): () => void
  }
  sections: {
    create(folder: string, title: string): Promise<SectionInfo>
    rename(folder: string, stem: string, title: string): Promise<SectionInfo>
    move(folder: string, stem: string, direction: 'up' | 'down'): Promise<SectionInfo>
    /** Moves the section's files to the Recycle Bin; the result can be passed to `restore`. */
    trash(folder: string, stem: string): Promise<{ undoId: string }>
    restore(undoId: string): Promise<void>
    /** Appends `laterStem`'s notes and output to `stem`'s, then removes `laterStem`. */
    merge(folder: string, stem: string, laterStem: string): Promise<SectionInfo>
    /** Sets (or with null removes) the heading on the first line of the section's output. */
    setHeading(folder: string, stem: string, heading: LeadingHeading | null): Promise<SectionInfo>
  }
}

export const IPC = {
  preferencesGet: 'preferences:get',
  preferencesSave: 'preferences:save',
  sidecarStatus: 'sidecar:status',
  sidecarLogs: 'sidecar:logs',
  sidecarRestart: 'sidecar:restart',
  sidecarStop: 'sidecar:stop',
  sidecarInstallTorch: 'sidecar:install-torch',
  sidecarStatusChanged: 'sidecar:status-changed',
  workspaceGet: 'workspace:get',
  workspaceAddRoot: 'workspace:add-root',
  workspaceRemoveRoot: 'workspace:remove-root',
  filesRead: 'files:read',
  filesWrite: 'files:write',
  filesChanged: 'files:changed',
  foldersRead: 'folders:read',
  foldersCreate: 'folders:create',
  foldersRename: 'folders:rename',
  foldersConvert: 'folders:convert',
  foldersSingleDocument: 'folders:single-document',
  sectionsCreate: 'sections:create',
  sectionsRename: 'sections:rename',
  sectionsMove: 'sections:move',
  sectionsTrash: 'sections:trash',
  sectionsRestore: 'sections:restore',
  sectionsMerge: 'sections:merge',
  sectionsSetHeading: 'sections:set-heading',
  dictionaryStatus: 'dictionary:status',
  dictionaryChoose: 'dictionary:choose',
  dictionaryDownload: 'dictionary:download',
  dictionaryCancelDownload: 'dictionary:cancel-download',
  dictionaryDownloadProgress: 'dictionary:download-progress',
  dictionaryLookup: 'dictionary:lookup',
  dictionarySearch: 'dictionary:search',
  lexiconLocation: 'lexicon:location',
  lexiconList: 'lexicon:list',
  lexiconSave: 'lexicon:save',
  lexiconRemove: 'lexicon:remove',
  lexiconImportAisling: 'lexicon:import-aisling',
  aiSettings: 'ai:settings',
  aiSaveConfig: 'ai:save-config',
  aiSetKey: 'ai:set-key',
  aiSetCompatBaseUrl: 'ai:set-compat-base-url',
  aiOpenPrompts: 'ai:open-prompts',
  aiRun: 'ai:run',
  aiCancel: 'ai:cancel',
  aiEvent: 'ai:event',
  aiUnloadLocal: 'ai:unload-local',
  statsDocument: 'stats:document',
  statsSetGoal: 'stats:set-goal',
  statsDaily: 'stats:daily',
  statsChanged: 'stats:changed',
  historyList: 'history:list',
  historyRead: 'history:read',
  historySnapshot: 'history:snapshot',
  exportDocument: 'export:document',
  exportShow: 'export:show',
  searchStatus: 'search:status',
  searchSync: 'search:sync',
  searchQuery: 'search:query',
  searchRelated: 'search:related',
  searchProgress: 'search:progress',
} as const

/** Search snippet markers around matched words; control characters that cannot occur in normal text. */
export const MATCH_START = '\u0002'
export const MATCH_END = '\u0003'

/** Custom protocol that serves images from inside workspace roots to the editor. */
export const LOCAL_FILE_SCHEME = 'ogma-file'
