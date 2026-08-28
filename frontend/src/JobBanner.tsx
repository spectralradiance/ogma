import { Clock3, LoaderCircle, Square, Terminal } from 'lucide-react'
import { progressFor } from './jobProgress'
import type { Job } from './types'

/**
 * One progress banner for any active job kind: percent, label, latest log
 * line, run/system identifiers, and stop/logs controls. Every surface that
 * shows a running background job (Workspace, Analysis, Pipeline) renders the
 * same banner off the same job so trigger/progress/completion read the same
 * way everywhere.
 */
export function JobBanner({ job, onOpenLogs, onCancel, queuedBehind, className }: {
  job: Job
  onOpenLogs: (jobId: string) => void
  onCancel: (jobId: string) => void
  queuedBehind?: number
  className?: string
}) {
  const progress = progressFor(job)
  return <section className={`panel analysis-progress ${job.status}${className ? ` ${className}` : ''}`}>
    <div className="progress-icon">{job.status === 'running' ? <LoaderCircle className="spin" /> : <Clock3 />}</div>
    <div className="progress-copy">
      <div><strong>{progress.label}</strong><span>{progress.percent}%</span></div>
      <div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
      <p>{progress.detail}</p>
      {job.run_id && <code>{job.run_id}{job.system ? ` · ${job.system}` : ''}</code>}
    </div>
    <div className="progress-actions">
      {Boolean(queuedBehind) && <span>{queuedBehind} queued</span>}
      <button onClick={() => onOpenLogs(job.id)}><Terminal /> Logs</button>
      <button className="stop" onClick={() => onCancel(job.id)}><Square /> Stop</button>
    </div>
  </section>
}
