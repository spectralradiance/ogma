import type { Artifact, IndexStatus, Job, OutlineCache, RunSummary, SystemSummary } from './types'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

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
  eventsUrl: (jobId: string) => `${API}/api/jobs/${jobId}/events`,
}
