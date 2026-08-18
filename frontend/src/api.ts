import type { AnalysisResult, AnalysisSummary, Artifact, DictionaryEntry, DictionarySearchResult, IndexStatus, Job, OutlineCache, RunSummary, SystemSummary, WorkspaceFile, WorkspaceFileSummary } from './types'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const DICTIONARY_API = import.meta.env.VITE_DICTIONARY_API_URL ?? 'http://127.0.0.1:3001'

/** Central fetch boundary. Error details from FastAPI are promoted to Error. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(body.detail ?? 'Request failed')
  }
  return response.json() as Promise<T>
}

async function dictionaryRequest<T>(path: string, notFound?: T): Promise<T> {
  const response = await fetch(`${DICTIONARY_API}${path}`)
  if (response.status === 404 && notFound !== undefined) return notFound
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(body.detail ?? body.error ?? 'Dictionary request failed')
  }
  return response.json() as Promise<T>
}

/** Typed calls matching the Pydantic contracts in api/schemas.py. */
export const api = {
  indexStatus: () => request<IndexStatus>('/api/index/status'),
  systems: () => request<SystemSummary[]>('/api/systems'),
  runs: () => request<RunSummary[]>('/api/runs'),
  jobs: () => request<Job[]>('/api/jobs'),
  caches: (system: string) => request<OutlineCache[]>(`/api/outlines/${encodeURIComponent(system)}/caches`),
  artifact: (runId: string, system: string, kind: Artifact['kind']) =>
    request<Artifact>(`/api/runs/${runId}/${encodeURIComponent(system)}/artifacts/${kind}`),
  startIndex: () => request<Job>('/api/index', { method: 'POST', body: '{}' }),
  startOutline: (system: string, cachePath?: string) => request<Job>('/api/outlines', {
    method: 'POST',
    body: JSON.stringify({ system, cache_path: cachePath || null, regenerate: !cachePath }),
  }),
  startManuscript: (system: string, runId?: string, cachePath?: string) => request<Job>('/api/manuscripts', {
    method: 'POST',
    body: JSON.stringify({
      system,
      run_id: runId || null,
      cache_path: cachePath || null,
      regenerate_outline: !runId && !cachePath,
    }),
  }),
  cancelJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}`, { method: 'DELETE' }),
  analyses: () => request<AnalysisSummary[]>('/api/analyses'),
  analysis: (runId: string) => request<AnalysisResult>(`/api/analyses/${runId}`),
  startAnalysis: () => request<Job>('/api/analyses', {
    method: 'POST',
    body: '{}',
  }),
  eventsUrl: (jobId: string) => `${API}/api/jobs/${jobId}/events`,
  workspaceFiles: () => request<WorkspaceFileSummary[]>('/api/workspace/files'),
  workspaceFile: (path: string) => request<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}`),
  saveWorkspaceFile: (path: string, content: string) => request<WorkspaceFile>('/api/workspace/file', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  }),
  defineWord: (word: string) => dictionaryRequest<DictionaryEntry[]>(`/api/define/${encodeURIComponent(word)}`, []),
  searchDictionary: (query: string, limit = 20) => dictionaryRequest<DictionarySearchResult[]>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`),
}
