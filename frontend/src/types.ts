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
  kind: 'index' | 'organize_chaos' | 'outline' | 'manuscript' | 'analysis' | 'concepts'
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

export interface ChaosStatus {
  unsorted_files: number
  imported_files: number
  last_run_at: string | null
}

export interface ConceptsArtifact {
  content: string
  modified_at: string | null
}

export interface AnalysisSummary {
  run_id: string
  created_at: string
  source: string
  embedding_model?: string | null
  document_count: number
  keyword_count: number
  topic_count: number
}

export interface AnalysisResult extends AnalysisSummary {
  analysis_version?: number
  keywords: { term: string; score: number }[]
  topics: { Topic: number; Count: number; Name: string; DisplayName?: string; Representation?: string[] }[]
  topics_by_directory: Record<string, unknown>[]
  documents_by_level?: { level: number; level_range: string; document_count: number }[]
  topics_by_level?: { level: number; level_range: string; topic: number; topic_name: string; document_count: number; prevalence: number }[]
  keywords_by_level?: { level: number; level_range: string; term: string; document_count: number; prevalence: number }[]
  documents: {
    path: string
    directory: string
    depth: number
    level?: number | null
    level_range?: string | null
    topic: number
    topic_name: string
    keywords?: string[]
    character_count?: number
    excerpt?: string
  }[]
  graph: {
    nodes: { id: string; label: string; kind: 'topic' | 'keyword' | 'document'; score?: number }[]
    edges: { source: string; target: string; kind: string }[]
  }
}

export interface Artifact {
  run_id: string
  system: string
  kind: 'outline' | 'manuscript' | 'writing_plan'
  content: string
}

export interface WorkspaceFileSummary {
  path: string
  size: number
  modified_at: string
}

export interface WorkspaceFile extends WorkspaceFileSummary {
  content: string
}

export interface DictionaryExample {
  text: string
  translation?: string
}

export interface DictionarySense {
  glosses: string[]
  examples: DictionaryExample[]
}

export interface DictionaryEntry {
  id: number
  word: string
  pos: string | null
  etymology: string | null
  data: {
    senses: DictionarySense[]
    ipa: string[]
    synonyms: string[]
    antonyms: string[]
    derived: string[]
    related: string[]
  }
}

export interface DictionarySearchResult {
  id: number
  word: string
  pos: string | null
  gloss: string
}
