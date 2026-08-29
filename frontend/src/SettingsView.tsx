import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CloudDownload, Plus, Trash2 } from 'lucide-react'
import { api } from './api'
import { JobBanner } from './JobBanner'
import type { Job, ModelCatalogEntry } from './types'

/**
 * Generation models are instruction-tuned chat LLMs that write prose; embedding
 * models are encoder-only models that turn text into vectors for search and
 * similarity. Those are different architectures doing different jobs, so a
 * catalog entry serves exactly one of the two lists rather than both.
 */
export function SettingsView({ jobs, onTrack, onOpenJob, onCancel }: {
  jobs: Job[]
  onTrack: (job: Job) => void
  onOpenJob: (jobId: string) => void
  onCancel: (jobId: string) => void
}) {
  const queryClient = useQueryClient()
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: api.models, refetchInterval: 5000 })
  const invalidateModels = () => void queryClient.invalidateQueries({ queryKey: ['models'] })
  const download = useMutation({ mutationFn: api.downloadModel, onSuccess: onTrack })
  const remove = useMutation({ mutationFn: api.removeModel, onSuccess: invalidateModels })
  const add = useMutation({
    mutationFn: api.addModel,
    onSuccess: () => { setValue(''); setLabel(''); invalidateModels() },
  })

  const [kind, setKind] = useState<'generation' | 'embedding'>('generation')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')

  const models = modelsQuery.data ?? []
  const generationModels = models.filter((entry) => entry.kind === 'generation')
  const embeddingModels = models.filter((entry) => entry.kind === 'embedding')

  return <section className="pipeline settings-view">
    <div className="panel pipeline-intro">
      <p className="eyebrow">Local models</p>
      <h2>Settings</h2>
      <p>
        Generation models write outlines and manuscript prose. Embedding models turn text into vectors
        for the shared search index and corpus analysis. A model can't do both jobs in this pipeline —
        that's why the two lists below don't overlap. Add more of either kind, and download them ahead
        of time so the first real run doesn't pay the download cost.
      </p>
    </div>
    <ModelCatalogSection
      title="Generation models"
      description="Write outlines and manuscript prose"
      entries={generationModels}
      jobs={jobs}
      onDownload={(model) => download.mutate(model)}
      onRemove={(model) => remove.mutate(model)}
      onOpenJob={onOpenJob}
      onCancel={onCancel}
    />
    <ModelCatalogSection
      title="Embedding models"
      description="Power the shared index and corpus analysis"
      entries={embeddingModels}
      jobs={jobs}
      onDownload={(model) => download.mutate(model)}
      onRemove={(model) => remove.mutate(model)}
      onOpenJob={onOpenJob}
      onCancel={onCancel}
    />
    <div className="panel settings-add">
      <div className="panel-title"><div><p className="eyebrow">Add a model</p><h2>Register a Hugging Face model</h2></div></div>
      <p className="empty-copy">
        Paste any Hugging Face repo id — e.g. <code>Qwen/Qwen2.5-32B-Instruct</code> for generation or{' '}
        <code>intfloat/e5-large-v2</code> for embedding. Pick the kind that matches what the model actually
        does; an unloadable or wrong-kind entry only surfaces as a failure once a job tries to use it.
      </p>
      <form
        className="settings-add-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim() && label.trim()) add.mutate({ value: value.trim(), label: label.trim(), kind })
        }}
      >
        <label>Hugging Face repo id<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="org/model-name" /></label>
        <label>Display label<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Shown in the model picker" /></label>
        <label>Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as 'generation' | 'embedding')}>
            <option value="generation">Generation · writes prose</option>
            <option value="embedding">Embedding · search &amp; similarity</option>
          </select>
        </label>
        <button className="primary" type="submit" disabled={add.isPending || !value.trim() || !label.trim()}>
          <Plus size={14} /> Add model
        </button>
      </form>
      {add.isError && <span className="request-error">{(add.error as Error).message}</span>}
    </div>
  </section>
}

function ModelCatalogSection({ title, description, entries, jobs, onDownload, onRemove, onOpenJob, onCancel }: {
  title: string
  description: string
  entries: ModelCatalogEntry[]
  jobs: Job[]
  onDownload: (value: string) => void
  onRemove: (value: string) => void
  onOpenJob: (jobId: string) => void
  onCancel: (jobId: string) => void
}) {
  return <div className="panel settings-section">
    <div className="panel-title"><div><p className="eyebrow">{title}</p><h2>{description}</h2></div></div>
    {entries.length === 0 && <p className="empty-copy">None yet.</p>}
    <ul className="settings-model-list">
      {entries.map((entry) => {
        const job = jobs.find((item) =>
          item.kind === 'download_model'
          && (item.status === 'queued' || item.status === 'running')
          && item.command.includes(entry.value))
        return <li key={entry.value}>
          <div className="settings-model-row">
            <div className="settings-model-info">
              <strong>{entry.label}</strong>
              <code>{entry.value}</code>
            </div>
            <div className="settings-model-status">
              {entry.provider === 'claude'
                ? <span className="pill">Claude API</span>
                : entry.downloaded
                  ? <span className="pill completed"><CheckCircle2 size={12} /> Downloaded</span>
                  : <span className="pill">Not cached yet</span>}
            </div>
            <div className="settings-model-actions">
              {entry.provider === 'local' && !entry.downloaded && !job
                && <button className="secondary" onClick={() => onDownload(entry.value)}><CloudDownload size={14} /> Download</button>}
              {!entry.builtin && <button className="icon-button" title="Remove" onClick={() => onRemove(entry.value)}><Trash2 size={15} /></button>}
            </div>
          </div>
          {job && <JobBanner job={job} onOpenLogs={onOpenJob} onCancel={onCancel} className="settings-model-job" />}
        </li>
      })}
    </ul>
  </div>
}
