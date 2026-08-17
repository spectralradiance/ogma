export interface IndexStatus {
  available: boolean
  completed_at: string | null
  files_found: number | null
  total_chunks: number | null
  database_modified_at: string | null
}

export interface SystemSummary {
  name: string
  sections: number
}

export interface OutlineCache {
  path: string
  modified_at: string
  sections: number
}

export interface RunSummary {
  run_id: string
  system: string
  outline_sections: number
  completed_sections: number
  total_sections: number
  has_human_outline: boolean
  has_manuscript: boolean
  modified_at: string
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: string
  kind: 'index' | 'outline' | 'manuscript'
  status: JobStatus
  created_at: string
  started_at: string | null
  finished_at: string | null
  command: string[]
  run_id: string | null
  system: string | null
  return_code: number | null
  logs: string[]
  error: string | null
}

export interface Artifact {
  run_id: string
  system: string
  kind: 'outline' | 'manuscript' | 'writing_plan'
  content: string
}
