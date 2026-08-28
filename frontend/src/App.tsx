import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, BookOpenText, Database, FileText, Library, LoaderCircle, Network, PencilLine, Play, RefreshCw, Search, Square, Terminal, Workflow } from 'lucide-react'
import { api } from './api'
import { JobBanner } from './JobBanner'
import type { Artifact, Job, RunSummary } from './types'
import { useJobEvents } from './useJobEvents'
import './App.css'

type View = 'pipeline' | 'workspace' | 'editor' | 'analysis' | 'runs' | 'jobs'
// Curated rather than free-text: an unloadable model name only surfaces as a
// failure deep in a background job, so keep the picker to models known to work.
const WRITER_MODELS = [
  { value: 'Qwen/Qwen2.5-7B-Instruct', label: 'Local GPU · Qwen2.5 7B' },
  { value: 'Qwen/Qwen2.5-14B-Instruct', label: 'Local GPU · Qwen2.5 14B' },
  { value: 'claude-opus-5', label: 'Claude API · Opus 5' },
  { value: 'claude-sonnet-5', label: 'Claude API · Sonnet 5' },
]
// Topic charts, canvas graph, and pipeline-status dependencies are lazy so the
// initial manuscript-workspace bundle stays small until each tab is selected.
const PipelineView = lazy(() => import('./PipelineView').then((module) => ({ default: module.PipelineView })))
const AnalysisView = lazy(() => import('./AnalysisView').then((module) => ({ default: module.AnalysisView })))
const WorkspaceEditor = lazy(() => import('./editor/WorkspaceEditor').then((module) => ({ default: module.WorkspaceEditor })))

const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Never'

function App() {
  const queryClient = useQueryClient()
  // Local state is limited to navigation and selections. Durable workflow state
  // lives in FastAPI/data directories and server state is owned by TanStack Query.
  const [view, setView] = useState<View>('pipeline')
  const [system, setSystem] = useState('Universal Metaphysics')
  const [cachePath, setCachePath] = useState('')
  const [modelName, setModelName] = useState(WRITER_MODELS[0].value)
  const provider = modelName.toLowerCase().startsWith('claude') ? 'claude' : 'local'
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [submittedJob, setSubmittedJob] = useState<Job | null>(null)
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [search, setSearch] = useState('')
  const liveJob = useJobEvents(activeJobId)

  // Runs and jobs poll at a low frequency for changes made by other browser tabs
  // or CLI invocations. The selected live job uses SSE below for immediate logs.
  const index = useQuery({ queryKey: ['index'], queryFn: api.indexStatus })
  const systems = useQuery({ queryKey: ['systems'], queryFn: api.systems })
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 5000 })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 3000 })
  const caches = useQuery({ queryKey: ['caches', system], queryFn: () => api.caches(system) })

  const track = (job: Job) => {
    // Opening the drawer immediately gives queued work visible feedback while
    // the SSE connection takes over subsequent status and log updates.
    setActiveJobId(job.id)
    setSubmittedJob(job)
    void queryClient.invalidateQueries({ queryKey: ['jobs'] })
  }
  const indexMutation = useMutation({ mutationFn: api.startIndex, onSuccess: track })
  const outlineMutation = useMutation({ mutationFn: () => api.startOutline(system, cachePath || undefined, provider, modelName), onSuccess: track })
  const manuscriptMutation = useMutation({
    // Supplying a run resumes its progress.json; omitting it creates a fresh,
    // timestamped run using either the selected plan cache or regenerated plans.
    mutationFn: (run?: RunSummary) => api.startManuscript(system, run?.run_id, run ? undefined : cachePath || undefined, provider, modelName),
    onSuccess: track,
  })
  const cancelMutation = useMutation({ mutationFn: api.cancelJob })
  const trackedFromPoll = (jobs.data ?? []).find((job) => job.id === activeJobId) ?? null
  const activeJob = liveJob ?? trackedFromPoll ?? (submittedJob?.id === activeJobId ? submittedJob : null)
  const activeGenerationJobs = (jobs.data ?? [])
    .filter((job) => (job.kind === 'outline' || job.kind === 'manuscript') && (job.status === 'queued' || job.status === 'running'))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
  const polledGenerationJob = activeGenerationJobs.find((job) => job.status === 'running') ?? activeGenerationJobs[0] ?? null
  const trackedGenerationJob = activeJob && (activeJob.kind === 'outline' || activeJob.kind === 'manuscript') && (activeJob.status === 'queued' || activeJob.status === 'running')
    ? activeJob
    : null
  const generationJob = polledGenerationJob?.status === 'running'
    ? polledGenerationJob
    : trackedGenerationJob ?? polledGenerationJob

  const filteredRuns = (runs.data ?? []).filter((run) => {
    const needle = search.toLowerCase()
    return !needle || run.system.toLowerCase().includes(needle) || run.run_id.toLowerCase().includes(needle)
  })
  const openArtifact = async (run: RunSummary, kind: Artifact['kind']) => setArtifact(await api.artifact(run.run_id, run.system, kind))

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-icon" src="/favicon.svg" alt="" /><span>Ogma</span></div>
      <nav>
        <button className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}><Workflow /> Pipeline</button>
        <button className={view === 'workspace' ? 'active' : ''} onClick={() => setView('workspace')}><Activity /> Workspace</button>
        <button className={view === 'editor' ? 'active' : ''} onClick={() => setView('editor')}><PencilLine /> Editor</button>
        <button className={view === 'analysis' ? 'active' : ''} onClick={() => setView('analysis')}><Network /> Analysis</button>
        <button className={view === 'runs' ? 'active' : ''} onClick={() => setView('runs')}><Library /> Run library</button>
        <button className={view === 'jobs' ? 'active' : ''} onClick={() => setView('jobs')}><Terminal /> Job console</button>
      </nav>
      <div className="sidebar-foot"><span className={`status-dot ${index.data?.available ? 'online' : ''}`} />{index.data?.available ? 'Index online' : 'Index unavailable'}</div>
    </aside>

    <main className={view === 'editor' ? 'editor-main' : ''}>
      <header className="topbar">
        <div><p className="eyebrow">Local semantic workspace</p><h1>{view === 'pipeline' ? 'Pipeline overview' : view === 'workspace' ? 'Manuscript operations' : view === 'editor' ? 'Markdown editor' : view === 'analysis' ? 'Corpus intelligence' : view === 'runs' ? 'Generated library' : 'Background jobs'}</h1></div>
        {view !== 'editor' && view !== 'pipeline' && <div className="search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter runs" /></div>}
      </header>

      {view === 'pipeline' && <Suspense fallback={<section className="panel analysis-empty">Loading pipeline...</section>}><PipelineView jobs={jobs.data ?? []} onTrack={track} onOpenJob={setActiveJobId} onNavigate={setView} /></Suspense>}
      {view === 'workspace' && <>
        <section className="metrics">
          <div><Database /><span>Indexed chunks</span><strong>{index.data?.total_chunks?.toLocaleString() ?? '24,818'}</strong><small>{formatDate(index.data?.completed_at ?? index.data?.database_modified_at)}</small></div>
          <div><BookOpenText /><span>Available texts</span><strong>{systems.data?.length ?? 3}</strong><small>{systems.data?.reduce((sum, item) => sum + item.sections, 0) ?? 147} sections</small></div>
          <div><FileText /><span>Generated runs</span><strong>{runs.data?.length ?? 0}</strong><small>{jobs.data?.filter((job) => job.status === 'running').length ?? 0} active jobs</small></div>
        </section>
        {generationJob && <JobBanner job={generationJob} onOpenLogs={setActiveJobId} onCancel={cancelMutation.mutate} className="generation-progress" />}
        <section className="workspace-grid">
          <div className="panel controls-panel">
            <div className="panel-title"><div><p className="eyebrow">Pipeline</p><h2>Build a text</h2></div><button className="icon-button" title="Refresh" onClick={() => void queryClient.invalidateQueries()}><RefreshCw /></button></div>
            <label>Source text<select value={system} onChange={(event) => { setSystem(event.target.value); setCachePath('') }}>{systems.data?.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
            <label>Writer<select value={modelName} onChange={(event) => setModelName(event.target.value)}>{WRITER_MODELS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label>Writing plan<select value={cachePath} onChange={(event) => setCachePath(event.target.value)}><option value="">Regenerate from indexed notes</option>{caches.data?.map((cache) => <option key={cache.path} value={cache.path}>{formatDate(cache.modified_at)} · {cache.sections} sections</option>)}</select></label>
            <div className="action-stack"><button onClick={() => outlineMutation.mutate()}><Play /> Generate outline</button><button className="primary" onClick={() => manuscriptMutation.mutate(undefined)}><BookOpenText /> Outline + manuscript</button></div>
            <div className="divider" />
            <div className="index-row"><div><strong>Source index</strong><span>{index.data?.available ? 'Ready for retrieval' : 'Needs indexing'}</span></div><button className="secondary" onClick={() => indexMutation.mutate()}><Database /> Reindex notes</button></div>
          </div>
          <div className="panel recent-panel"><div className="panel-title"><div><p className="eyebrow">Recent</p><h2>Generation runs</h2></div><button className="text-button" onClick={() => setView('runs')}>View all</button></div><RunTable runs={filteredRuns.slice(0, 5)} onArtifact={openArtifact} onContinue={(run) => { setSystem(run.system); manuscriptMutation.mutate(run) }} /></div>
        </section>
      </>}
      {view === 'editor' && <Suspense fallback={<section className="panel analysis-empty">Loading editor...</section>}><WorkspaceEditor /></Suspense>}
      {view === 'analysis' && <Suspense fallback={<section className="panel analysis-empty">Loading analysis tools...</section>}><AnalysisView jobs={jobs.data ?? []} onTrack={track} onOpenJob={setActiveJobId} /></Suspense>}
      {view === 'runs' && <section className="panel full-panel"><RunTable runs={filteredRuns} onArtifact={openArtifact} onContinue={(run) => { setSystem(run.system); manuscriptMutation.mutate(run) }} /></section>}
      {view === 'jobs' && <section className="panel full-panel"><JobTable jobs={jobs.data ?? []} onSelect={(job) => setActiveJobId(job.id)} /></section>}
    </main>

    {activeJobId && <aside className="drawer job-drawer"><div className="drawer-head"><div><p className="eyebrow">Live process</p><h2>{activeJob?.kind ?? 'Queued job'}</h2></div><button className="icon-button" onClick={() => setActiveJobId(null)}>×</button></div><div className={`job-state ${activeJob?.status ?? 'queued'}`}>{activeJob?.status === 'running' && <LoaderCircle className="spin" />}{activeJob?.status ?? 'connecting'}</div><pre>{activeJob?.logs.join('\n') || 'Waiting for output...'}</pre>{activeJob?.status === 'running' && <button className="danger" onClick={() => cancelMutation.mutate(activeJob.id)}><Square /> Stop job</button>}</aside>}
    {artifact && <aside className="drawer artifact-drawer"><div className="drawer-head"><div><p className="eyebrow">{artifact.run_id}</p><h2>{artifact.kind.replace('_', ' ')}</h2></div><button className="icon-button" onClick={() => setArtifact(null)}>×</button></div><article>{artifact.content}</article></aside>}
  </div>
}

/** Compact artifact/progress table shared by dashboard and library views. */
function RunTable({ runs, onArtifact, onContinue }: { runs: RunSummary[]; onArtifact: (run: RunSummary, kind: Artifact['kind']) => void; onContinue: (run: RunSummary) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>Run</th><th>Text</th><th>Outline</th><th>Manuscript</th><th>Updated</th><th /></tr></thead><tbody>{runs.length === 0 ? <tr><td colSpan={6} className="empty">No generated runs yet</td></tr> : runs.map((run) => <tr key={`${run.run_id}-${run.system}`}><td><code>{run.run_id.replace('generated', '')}</code></td><td><strong>{run.system}</strong></td><td>{run.outline_sections}/{run.total_sections}</td><td>{run.completed_sections}/{run.total_sections}</td><td>{formatDate(run.modified_at)}</td><td><div className="row-actions">{run.has_human_outline && <button title="Open outline" onClick={() => void onArtifact(run, 'outline')}><FileText /></button>}{run.has_manuscript && <button title="Open manuscript" onClick={() => void onArtifact(run, 'manuscript')}><BookOpenText /></button>}<button title="Continue generation" onClick={() => onContinue(run)}><Play /></button></div></td></tr>)}</tbody></table></div>
}

/** Session-scoped job history; selecting a row reconnects its SSE drawer. */
function JobTable({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>Status</th><th>Job</th><th>Text</th><th>Started</th><th>Output</th></tr></thead><tbody>{jobs.length === 0 ? <tr><td colSpan={5} className="empty">No jobs in this server session</td></tr> : jobs.map((job) => <tr key={job.id} onClick={() => onSelect(job)} className="clickable"><td><span className={`pill ${job.status}`}>{job.status}</span></td><td>{job.kind}</td><td>{job.system ?? 'All notes'}</td><td>{formatDate(job.started_at ?? job.created_at)}</td><td>{job.logs.at(-1) ?? 'Waiting'}</td></tr>)}</tbody></table></div>
}

export default App
