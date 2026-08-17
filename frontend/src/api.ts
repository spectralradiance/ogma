import type { AnalysisResult, AnalysisSummary, Artifact, IndexStatus, Job, OutlineCache, RunSummary, SystemSummary } from './types'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

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
}
