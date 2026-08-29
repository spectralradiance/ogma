import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenText, ChevronRight, Database, FileText, Network, Play, Plus, Shuffle, Tags, Terminal } from 'lucide-react'
import { api } from './api'
import { JobBanner } from './JobBanner'
import type { Artifact, Job, PipelineRun } from './types'

type View = 'workspace' | 'editor' | 'analysis' | 'chat' | 'jobs'
type ModelOption = { value: string; label: string }

const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Never'
const RUN_STORAGE_KEY = 'ogma-pipeline-run'

/** A query's stat line: still loading, failed (with a way to say so), or resolved. */
function queryStat<T>(query: { data?: T; isError: boolean }, render: (data: T) => string, emptyMessage?: string): string {
  if (query.data !== undefined) return render(query.data)
  if (query.isError) return emptyMessage ?? 'Status unavailable — retrying'
  return 'Loading status...'
}

interface Stage {
  key: string
  icon: React.ReactNode
  title: string
  description: string
  stat: string
  job: Job | null
  onRun: () => void
  runLabel: string
  runDisabled: boolean
  locked?: string
  onOpen?: () => void
  openLabel?: string
  files?: string[]
}

/**
 * The whole corpus-to-manuscript flow as one run: organize chaos, index,
 * analyze, generate concepts, and write, in that order. Steps are gated —
 * each becomes available once the previous one is done for the selected
 * run — and every step's output files are listed inline, folding in what
 * the old standalone Run Library view showed.
 */
export function PipelineView({ jobs, onTrack, onOpenJob, onNavigate, writerModels, embeddingModels, modelName, onModelNameChange, embeddingModel, onEmbeddingModelChange, onOpenArtifact }: {
  jobs: Job[]
  onTrack: (job: Job) => void
  onOpenJob: (jobId: string) => void
  onNavigate: (view: View) => void
  writerModels: ModelOption[]
  embeddingModels: ModelOption[]
  modelName: string
  onModelNameChange: (value: string) => void
  embeddingModel: string
  onEmbeddingModelChange: (value: string) => void
  onOpenArtifact: (runId: string, system: string, kind: Artifact['kind']) => void
}) {
  const queryClient = useQueryClient()
  const provider = modelName.toLowerCase().startsWith('claude') ? 'claude' : 'local'
  const [runId, setRunId] = useState<string | null>(() => localStorage.getItem(RUN_STORAGE_KEY))

  useEffect(() => {
    if (runId) localStorage.setItem(RUN_STORAGE_KEY, runId)
    else localStorage.removeItem(RUN_STORAGE_KEY)
  }, [runId])

  // A brand-new run has no folder on disk until its first step writes
  // something, so it won't appear in the polled list yet — keep it here as a
  // fallback until discovery catches up (or forever, if nothing is run).
  const [pendingRun, setPendingRun] = useState<PipelineRun | null>(null)

  const runsQuery = useQuery({ queryKey: ['pipeline-runs'], queryFn: api.pipelineRuns, refetchInterval: 5000 })
  const systemsQuery = useQuery({ queryKey: ['systems'], queryFn: api.systems })
  const chaosStatus = useQuery({ queryKey: ['chaos-status'], queryFn: api.chaosStatus, refetchInterval: 5000 })
  const indexStatus = useQuery({ queryKey: ['index'], queryFn: api.indexStatus, refetchInterval: 5000 })
  const concepts = useQuery({ queryKey: ['concepts', runId], queryFn: () => api.concepts(runId!), enabled: Boolean(runId), retry: false })

  const currentRun = runsQuery.data?.find((run) => run.run_id === runId)
    ?? (pendingRun?.run_id === runId ? pendingRun : null)
  const stepFor = (step: string) => currentRun?.steps.find((entry) => entry.step === step)
  const stepDone = (step: string) => stepFor(step)?.done ?? false

  const createRun = useMutation({
    mutationFn: api.createPipelineRun,
    onSuccess: (run) => { setRunId(run.run_id); setPendingRun(run); void queryClient.invalidateQueries({ queryKey: ['pipeline-runs'] }) },
  })
  const organizeChaos = useMutation({ mutationFn: () => api.startOrganizeChaos(false, runId ?? undefined), onSuccess: onTrack })
  const reindex = useMutation({ mutationFn: api.startIndex, onSuccess: onTrack })
  const analyze = useMutation({ mutationFn: () => api.startAnalysis(embeddingModel, runId ?? undefined), onSuccess: onTrack })
  const generateConcepts = useMutation({ mutationFn: () => api.startConcepts(200, provider, runId ?? undefined), onSuccess: onTrack })
  const startOutline = useMutation({ mutationFn: (system: string) => api.startOutline(system, undefined, provider, modelName, runId ?? undefined), onSuccess: onTrack })
  const startManuscript = useMutation({ mutationFn: (system: string) => api.startManuscript(system, runId ?? undefined, undefined, provider, modelName), onSuccess: onTrack })
  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  })

  const running = (kind: Job['kind']) => jobs.some((job) => job.kind === kind && (job.status === 'queued' || job.status === 'running'))
  const latestJobOfKind = (kind: Job['kind'], system?: string) => {
    const matches = jobs.filter((job) => job.kind === kind && (system === undefined || job.system === system))
    if (!matches.length) return null
    return matches.reduce((left, right) => (left.created_at > right.created_at ? left : right))
  }

  if (!runId || !currentRun) {
    return <RunPicker
      runs={runsQuery.data ?? []}
      loading={runsQuery.isLoading}
      creating={createRun.isPending}
      onCreate={() => createRun.mutate()}
      onSelect={setRunId}
    />
  }

  const organizeChaosDone = stepDone('organize_chaos')
  const indexDone = stepDone('index')
  const analysisDone = stepDone('analysis')
  const conceptsDone = stepDone('concepts')

  const stages: Stage[] = [
    {
      key: 'organize_chaos',
      icon: <Shuffle />,
      title: 'Organize chaos',
      description: 'Route raw chaos notes into the destinations profiled in chapter-profiles.md — direct heading matches first, embedding similarity for everything else.',
      stat: queryStat(chaosStatus, (data) => `${data.imported_files} note files matched · ${data.unsorted_files} unsorted · last run ${formatDate(data.last_run_at)}`),
      job: latestJobOfKind('organize_chaos'),
      onRun: () => organizeChaos.mutate(),
      runLabel: 'Run',
      runDisabled: running('organize_chaos'),
      files: stepFor('organize_chaos')?.files,
    },
    {
      key: 'index',
      icon: <Database />,
      title: 'Index notes',
      description: 'Embed the organized note tree into the shared ChromaDB vector store that retrieval, analysis, and generation all read from.',
      stat: queryStat(indexStatus, (data) => `${data.available ? `${data.total_chunks?.toLocaleString() ?? 0} chunks indexed` : 'Not indexed yet'} · last run ${formatDate(data.completed_at ?? data.database_modified_at)}`),
      job: latestJobOfKind('index'),
      onRun: () => reindex.mutate(),
      runLabel: 'Reindex',
      runDisabled: running('index') || !organizeChaosDone,
      locked: organizeChaosDone ? undefined : 'Organize chaos first',
      files: stepFor('index')?.files,
    },
    {
      key: 'analysis',
      icon: <Network />,
      title: 'Analyze corpus',
      description: 'Extract keywords, model topics, and build the document/topic/keyword graph across the indexed corpus.',
      stat: stepFor('analysis')?.done ? `Done for this run${stepFor('analysis')?.files.length ? ` · ${stepFor('analysis')!.files.length} file(s)` : ''}` : 'Not yet run for this run',
      job: latestJobOfKind('analysis', runId),
      onRun: () => analyze.mutate(),
      runLabel: 'Run analysis',
      runDisabled: running('analysis') || !indexDone,
      locked: indexDone ? undefined : 'Index notes first',
      onOpen: () => onNavigate('analysis'),
      openLabel: 'Open analysis',
      files: stepFor('analysis')?.files,
    },
    {
      key: 'concepts',
      icon: <Tags />,
      title: 'Generate concepts',
      description: 'Distill a deduplicated concept glossary from indexed notes, grounded and cached across resumable batches.',
      stat: queryStat(concepts, (data) => `${data.content.match(/^(\d+) concepts grounded/m)?.[1] ?? '0'} concepts · last run ${formatDate(data.modified_at)}`, 'Not generated yet for this run'),
      job: latestJobOfKind('concepts', runId),
      onRun: () => generateConcepts.mutate(),
      runLabel: 'Generate',
      runDisabled: running('concepts') || !analysisDone,
      locked: analysisDone ? undefined : 'Analyze the corpus first',
      files: stepFor('concepts')?.files,
    },
  ]

  return <section className="pipeline">
    <RunHeader
      run={currentRun}
      onChangeRun={() => setRunId(null)}
      writerModels={writerModels}
      embeddingModels={embeddingModels}
      modelName={modelName}
      onModelNameChange={onModelNameChange}
      embeddingModel={embeddingModel}
      onEmbeddingModelChange={onEmbeddingModelChange}
    />
    <ol className="pipeline-stages">
      {stages.map((stage) => {
        const active = stage.job && (stage.job.status === 'queued' || stage.job.status === 'running')
        return <li key={stage.key} className="pipeline-stage panel">
          <div className="pipeline-stage-icon">{stage.icon}</div>
          <div className="pipeline-stage-body">
            <div className="pipeline-stage-head">
              <h3>{stage.title}</h3>
              {stage.job && <span className={`pill ${stage.job.status}`}>{stage.job.status}</span>}
            </div>
            <p className="pipeline-stage-desc">{stage.description}</p>
            <p className="pipeline-stage-stat">{stage.locked ? `Locked — ${stage.locked}` : stage.stat}</p>
            {active && stage.job && <JobBanner job={stage.job} onOpenLogs={onOpenJob} onCancel={(id) => cancel.mutate(id)} className="pipeline-stage-banner" />}
            {!active && stage.files && stage.files.length > 0 && <ul className="pipeline-stage-files">
              {stage.files.map((file) => <li key={file} title={file}>{file.split(/[\\/]/).pop()}</li>)}
            </ul>}
          </div>
          <div className="pipeline-stage-actions">
            <button className="primary" disabled={stage.runDisabled} onClick={stage.onRun}><Play size={14} /> {stage.runLabel}</button>
            {stage.onOpen && <button className="text-button" onClick={stage.onOpen}>{stage.openLabel}</button>}
            {!active && stage.job && <button className="text-button" onClick={() => onOpenJob(stage.job!.id)}><Terminal size={13} /> Logs</button>}
          </div>
        </li>
      })}
      <WriteStage
        conceptsDone={conceptsDone}
        run={currentRun}
        runId={runId}
        systems={systemsQuery.data ?? []}
        jobs={jobs}
        startOutline={startOutline}
        startManuscript={startManuscript}
        onOpenJob={onOpenJob}
        onCancel={(id) => cancel.mutate(id)}
        onOpenArtifact={onOpenArtifact}
        onOpenWorkspace={() => onNavigate('workspace')}
      />
    </ol>
  </section>
}

function RunPicker({ runs, loading, creating, onCreate, onSelect }: {
  runs: PipelineRun[]
  loading: boolean
  creating: boolean
  onCreate: () => void
  onSelect: (runId: string) => void
}) {
  return <section className="pipeline">
    <div className="pipeline-intro panel">
      <p className="eyebrow">Corpus to manuscript</p>
      <h2>Start or continue a run</h2>
      <p>Every stage — organize chaos, index, analyze, concepts, write — shares one run, so output lands together and each step can build on the last.</p>
      <button className="primary run-create" disabled={creating} onClick={onCreate}><Plus size={15} /> {creating ? 'Starting...' : 'Start a new run'}</button>
    </div>
    <div className="panel run-list">
      <div className="panel-title"><div><p className="eyebrow">History</p><h2>Continue an existing run</h2></div></div>
      {loading && <p className="empty-copy">Loading runs...</p>}
      {!loading && runs.length === 0 && <p className="empty-copy">No runs yet — start one above.</p>}
      {runs.map((run) => {
        const doneCount = run.steps.filter((step) => step.done).length
        return <button key={run.run_id} onClick={() => onSelect(run.run_id)}>
          <strong>{run.run_id.replace('generated', '')}</strong>
          <span>{formatDate(run.created_at)} · {doneCount}/{run.steps.length} steps done</span>
          <ChevronRight size={15} />
        </button>
      })}
    </div>
  </section>
}

function RunHeader({ run, onChangeRun, writerModels, embeddingModels, modelName, onModelNameChange, embeddingModel, onEmbeddingModelChange }: {
  run: PipelineRun
  onChangeRun: () => void
  writerModels: ModelOption[]
  embeddingModels: ModelOption[]
  modelName: string
  onModelNameChange: (value: string) => void
  embeddingModel: string
  onEmbeddingModelChange: (value: string) => void
}) {
  return <div className="panel pipeline-run-header">
    <div className="pipeline-run-id">
      <p className="eyebrow">Current run</p>
      <h2>{run.run_id.replace('generated', '')}</h2>
      <span>Started {formatDate(run.created_at)}</span>
    </div>
    <label>Generation model<select value={modelName} onChange={(event) => onModelNameChange(event.target.value)}>{writerModels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label>Embedding model<select value={embeddingModel} onChange={(event) => onEmbeddingModelChange(event.target.value)}>{embeddingModels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <button className="text-button" onClick={onChangeRun}>Change run</button>
  </div>
}

function WriteStage({ conceptsDone, run, runId, systems, jobs, startOutline, startManuscript, onOpenJob, onCancel, onOpenArtifact, onOpenWorkspace }: {
  conceptsDone: boolean
  run: PipelineRun
  runId: string
  systems: { name: string; sections: number }[]
  jobs: Job[]
  startOutline: { mutate: (system: string) => void }
  startManuscript: { mutate: (system: string) => void }
  onOpenJob: (jobId: string) => void
  onCancel: (jobId: string) => void
  onOpenArtifact: (runId: string, system: string, kind: Artifact['kind']) => void
  onOpenWorkspace: () => void
}) {
  const running = (system: string) => jobs.some((job) => (job.kind === 'outline' || job.kind === 'manuscript') && job.system === system && (job.status === 'queued' || job.status === 'running'))
  return <li className="pipeline-stage panel pipeline-write-stage">
    <div className="pipeline-stage-icon"><BookOpenText /></div>
    <div className="pipeline-stage-body">
      <div className="pipeline-stage-head"><h3>Write manuscripts</h3></div>
      <p className="pipeline-stage-desc">Plan and draft manuscript prose per system, grounded in retrieved note excerpts, using this run's generation model.</p>
      <p className="pipeline-stage-stat">{conceptsDone ? 'Ready — pick a system below' : 'Locked — generate concepts first'}</p>
      {conceptsDone && <ul className="pipeline-write-systems">
        {systems.map((system) => {
          const step = run.steps.find((entry) => entry.label === `Write · ${system.name}`)
          const job = jobs.filter((item) => (item.kind === 'outline' || item.kind === 'manuscript') && item.system === system.name)
            .reduce((left: Job | null, right) => (!left || right.created_at > left.created_at ? right : left), null)
          const active = job && (job.status === 'queued' || job.status === 'running')
          return <li key={system.name}>
            <div className="pipeline-write-system-head">
              <strong>{system.name}</strong>
              {step?.done && <span className="pill completed">manuscript done</span>}
              {job && !step?.done && <span className={`pill ${job.status}`}>{job.status}</span>}
            </div>
            {active && job && <JobBanner job={job} onOpenLogs={onOpenJob} onCancel={onCancel} className="pipeline-stage-banner" />}
            <div className="pipeline-write-actions">
              <button disabled={running(system.name)} onClick={() => startOutline.mutate(system.name)}><Play size={13} /> Outline</button>
              <button className="primary" disabled={running(system.name)} onClick={() => startManuscript.mutate(system.name)}><BookOpenText size={13} /> Manuscript</button>
              {step?.files.map((file) => <button key={file} className="text-button" onClick={() => onOpenArtifact(runId, system.name, file.endsWith('manuscript.md') ? 'manuscript' : 'outline')}><FileText size={13} /> {file.split(/[\\/]/).pop()}</button>)}
            </div>
          </li>
        })}
      </ul>}
      {conceptsDone && <button className="text-button" onClick={onOpenWorkspace}>Open Workspace for advanced options (writing plans, caches)</button>}
    </div>
  </li>
}
