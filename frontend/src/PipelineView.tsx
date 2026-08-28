import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenText, Database, Network, Play, Shuffle, Tags, Terminal, TriangleAlert, X } from 'lucide-react'
import { api } from './api'
import { JobBanner } from './JobBanner'
import type { Job } from './types'

type View = 'workspace' | 'editor' | 'analysis' | 'runs' | 'jobs'

const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Never'

/** Most recent job of a kind, active or finished, so a stage always has a status to show. */
function latestJobOfKind(jobs: Job[], kind: Job['kind']): Job | null {
  const matches = jobs.filter((job) => job.kind === kind)
  if (!matches.length) return null
  return matches.reduce((left, right) => (left.created_at > right.created_at ? left : right))
}

/** A query's stat line: still loading, failed (with a way to say so), or resolved. */
function queryStat<T>(query: { data?: T; isError: boolean }, render: (data: T) => string, emptyMessage?: string): string {
  if (query.data !== undefined) return render(query.data)
  if (query.isError) return emptyMessage ?? 'Status unavailable — retrying'
  return 'Loading status...'
}

interface Stage {
  key: string
  icon: ReactNode
  title: string
  description: string
  stat: string
  job: Job | null
  onRun: () => void
  runLabel: string
  runDisabled: boolean
  onOpen?: () => void
  openLabel?: string
}

/**
 * A single at-a-glance view of the full corpus-to-manuscript flow: raw chaos
 * notes are routed into the organized note tree, indexed for retrieval,
 * analyzed for topics/keywords, distilled into a concept glossary, and
 * finally drafted into manuscripts. Each stage keeps its own workspace tab
 * for deep configuration; this view exists so the sequence and each stage's
 * current status are visible in one place. Every stage's trigger, progress,
 * and review controls go through the same job-queue primitives (JobBanner,
 * progressFor, the shared job drawer) rather than bespoke per-stage UI.
 */
export function PipelineView({ jobs, onTrack, onOpenJob, onNavigate }: {
  jobs: Job[]
  onTrack: (job: Job) => void
  onOpenJob: (jobId: string) => void
  onNavigate: (view: View) => void
}) {
  const queryClient = useQueryClient()
  const chaosStatus = useQuery({ queryKey: ['chaos-status'], queryFn: api.chaosStatus, refetchInterval: 5000 })
  const indexStatus = useQuery({ queryKey: ['index'], queryFn: api.indexStatus, refetchInterval: 5000 })
  const analyses = useQuery({ queryKey: ['analyses'], queryFn: api.analyses, refetchInterval: 5000 })
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 5000 })
  // A missing glossary is an expected 404, not a transient failure, so it does not retry or read as an error.
  const concepts = useQuery({ queryKey: ['concepts'], queryFn: api.concepts, retry: false })

  const organizeChaos = useMutation({ mutationFn: () => api.startOrganizeChaos(false), onSuccess: onTrack })
  const reindex = useMutation({ mutationFn: api.startIndex, onSuccess: onTrack })
  const analyze = useMutation({ mutationFn: () => api.startAnalysis(), onSuccess: onTrack })
  const generateConcepts = useMutation({ mutationFn: () => api.startConcepts(200, 'local'), onSuccess: onTrack })
  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  })

  const running = (kind: Job['kind']) => jobs.some((job) => job.kind === kind && (job.status === 'queued' || job.status === 'running'))

  const stages: Stage[] = [
    {
      key: 'organize_chaos',
      icon: <Shuffle />,
      title: 'Organize chaos',
      description: 'Semantically route raw dumped notes under chaos/ into the organized notes/ tree. Chaos files are never modified; unmatched sections land in notes/_unsorted for review.',
      stat: queryStat(chaosStatus, (data) => `${data.imported_files} note files matched · ${data.unsorted_files} unsorted · last run ${formatDate(data.last_run_at)}`),
      job: latestJobOfKind(jobs, 'organize_chaos'),
      onRun: () => organizeChaos.mutate(),
      runLabel: 'Run',
      runDisabled: running('organize_chaos'),
    },
    {
      key: 'index',
      icon: <Database />,
      title: 'Index notes',
      description: 'Embed the organized note tree into the ChromaDB vector store that every retrieval, analysis, and generation step reads from.',
      stat: queryStat(indexStatus, (data) => `${data.available ? `${data.total_chunks?.toLocaleString() ?? 0} chunks indexed` : 'Not indexed yet'} · last run ${formatDate(data.completed_at ?? data.database_modified_at)}`),
      job: latestJobOfKind(jobs, 'index'),
      onRun: () => reindex.mutate(),
      runLabel: 'Reindex',
      runDisabled: running('index'),
    },
    {
      key: 'analysis',
      icon: <Network />,
      title: 'Analyze corpus',
      description: 'Extract keywords, model topics, and build the document/topic/keyword graph across the indexed corpus.',
      stat: queryStat(analyses, (data) => `${data.length} analysis run${data.length === 1 ? '' : 's'}${data[0] ? ` · last run ${formatDate(data[0].created_at)}` : ''}`),
      job: latestJobOfKind(jobs, 'analysis'),
      onRun: () => analyze.mutate(),
      runLabel: 'Run analysis',
      runDisabled: running('analysis'),
      onOpen: () => onNavigate('analysis'),
      openLabel: 'Open analysis',
    },
    {
      key: 'concepts',
      icon: <Tags />,
      title: 'Generate concepts',
      description: 'Distill a deduplicated concept glossary from indexed notes, grounded and cached across resumable batches.',
      stat: queryStat(concepts, (data) => `${data.content.match(/^(\d+) concepts grounded/m)?.[1] ?? '0'} concepts · last run ${formatDate(data.modified_at)}`, 'Not generated yet'),
      job: latestJobOfKind(jobs, 'concepts'),
      onRun: () => generateConcepts.mutate(),
      runLabel: 'Generate',
      runDisabled: running('concepts'),
    },
    {
      key: 'manuscript',
      icon: <BookOpenText />,
      title: 'Write manuscripts',
      description: 'Plan and draft manuscript prose per system, grounded in retrieved note excerpts. Configure the writer and provider in Workspace.',
      stat: queryStat(runs, (data) => `${data.length} generated run${data.length === 1 ? '' : 's'}`),
      job: latestJobOfKind(jobs, 'manuscript') ?? latestJobOfKind(jobs, 'outline'),
      onRun: () => onNavigate('workspace'),
      runLabel: 'Open workspace',
      runDisabled: false,
      onOpen: () => onNavigate('runs'),
      openLabel: 'View runs',
    },
  ]

  return <section className="pipeline">
    <div className="pipeline-intro panel">
      <p className="eyebrow">Corpus to manuscript</p>
      <h2>The full flow, end to end</h2>
      <p>Each stage below feeds the next: chaos notes are organized, indexed, analyzed, distilled into concepts, and finally written into manuscripts. Run a stage here, or open its dedicated workspace for deeper controls.</p>
    </div>
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
            <p className="pipeline-stage-stat">{stage.stat}</p>
            {active && stage.job && <JobBanner job={stage.job} onOpenLogs={onOpenJob} onCancel={(id) => cancel.mutate(id)} className="pipeline-stage-banner" />}
          </div>
          <div className="pipeline-stage-actions">
            <button className="primary" disabled={stage.runDisabled} onClick={stage.onRun}><Play size={14} /> {stage.runLabel}</button>
            {stage.onOpen && <button className="text-button" onClick={stage.onOpen}>{stage.openLabel}</button>}
            {!active && stage.job && <button className="text-button" onClick={() => onOpenJob(stage.job!.id)}><Terminal size={13} /> Logs</button>}
          </div>
        </li>
      })}
    </ol>
    {(organizeChaos.isError || reindex.isError || analyze.isError || generateConcepts.isError) &&
      <p className="request-error"><X size={12} /> Could not start that stage. Check the job console for details.</p>}
    {(chaosStatus.isError || indexStatus.isError || analyses.isError || runs.isError) &&
      <p className="request-error"><TriangleAlert size={12} /> Some stage status couldn't be reached; retrying in the background.</p>}
  </section>
}
