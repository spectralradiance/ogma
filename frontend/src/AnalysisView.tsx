import { useDeferredValue, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Network, Play, Tags } from 'lucide-react'
import ForceGraph2D from 'react-force-graph-2d'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from './api'
import { CorpusBrowser } from './CorpusBrowser'
import { JobBanner } from './JobBanner'
import type { AnalysisResult, Job } from './types'
import { useJobEvents } from './useJobEvents'

const exportMetadataTerm = /(?:^|\s)(?:zim|wiki format|text zim wiki)(?:\s|$)/i
// Analysis embeds its own working set fresh each run (it never touches the
// ChromaDB index), so unlike the index's embedding model this one is a free
// per-run choice with no downstream consistency requirement.
const ANALYSIS_MODELS = [
  { value: 'BAAI/bge-large-en-v1.5', label: 'BGE large · best quality' },
  { value: 'BAAI/bge-base-en-v1.5', label: 'BGE base · faster' },
  { value: 'all-MiniLM-L6-v2', label: 'MiniLM · fastest' },
]

function legacyTopicLabel(name: string) {
  const generic = new Set(['self', 'thing', 'things', 'world', 'write', 'writing'])
  const seen = new Set<string>()
  return name.replace(/^\d+_/, '').split('_').filter((word) => {
    const key = word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
    if (generic.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 3).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' / ')
}

export function AnalysisView({ jobs, onTrack, onOpenJob }: { jobs: Job[]; onTrack: (job: Job) => void; onOpenJob: (jobId: string) => void }) {
  const queryClient = useQueryClient()
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [embeddingModel, setEmbeddingModel] = useState(ANALYSIS_MODELS[0].value)
  // Defer loading a potentially large graph payload so selecting a history row
  // remains responsive while React transitions to the new visualization.
  const deferredRun = useDeferredValue(selectedRun)
  const analyses = useQuery({ queryKey: ['analyses'], queryFn: api.analyses, refetchInterval: 5000 })
  const result = useQuery({
    queryKey: ['analysis', deferredRun],
    queryFn: () => api.analysis(deferredRun!),
    enabled: Boolean(deferredRun),
  })
  const start = useMutation({ mutationFn: () => api.startAnalysis(embeddingModel), onSuccess: onTrack })
  const cancel = useMutation({ mutationFn: api.cancelJob })
  const activeAnalysisJobs = jobs
    .filter((job) => job.kind === 'analysis' && (job.status === 'queued' || job.status === 'running'))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
  const activeFromPoll = activeAnalysisJobs.find((job) => job.status === 'running')
    ?? activeAnalysisJobs[0]
    ?? null
  const queuedBehind = activeAnalysisJobs.filter((job) => job.status === 'queued' && job.id !== activeFromPoll?.id).length
  const liveJob = useJobEvents(activeFromPoll?.id ?? null)
  const currentJob = liveJob ?? activeFromPoll
  const activeJob = currentJob && (currentJob.status === 'queued' || currentJob.status === 'running')
    ? currentJob
    : null

  useEffect(() => {
    if (liveJob?.status === 'completed') {
      void queryClient.invalidateQueries({ queryKey: ['analyses'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    }
  }, [liveJob?.status, liveJob?.run_id, queryClient])

  return <>
    <section className="analysis-toolbar panel">
      <div><p className="eyebrow">BERTopic + KeyBERT</p><h2>Corpus analysis</h2><span>Analyze every eligible note across the complete directory tree.</span>{start.error && <strong className="request-error">{start.error.message}</strong>}</div>
      <label>Embeddings<select value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)}>{ANALYSIS_MODELS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <button className="primary-command" onClick={() => start.mutate()} disabled={start.isPending || Boolean(activeJob)}><Play /> {start.isPending ? 'Queueing...' : activeJob ? 'Analysis running' : 'Run analysis'}</button>
    </section>

    {activeJob && <JobBanner job={activeJob} onOpenLogs={onOpenJob} onCancel={cancel.mutate} queuedBehind={queuedBehind} />}

    <section className="analysis-layout">
      <div className="panel analysis-list"><div className="panel-title"><div><p className="eyebrow">History</p><h2>Analysis runs</h2></div></div>{analyses.data?.length ? analyses.data.map((item) => <button key={item.run_id} className={selectedRun === item.run_id ? 'selected' : ''} onClick={() => setSelectedRun(item.run_id)}><strong>{item.run_id.replace('generated', '')}</strong><span>{item.document_count} docs · {item.topic_count} topics{item.embedding_model ? ` · ${item.embedding_model.split('/').pop()}` : ''}</span></button>) : <p className="empty-copy">No analyses yet.</p>}</div>
      <div className="analysis-results">
        {!result.data ? <div className="panel analysis-empty"><Network /><h2>Select an analysis run</h2><p>Completed keyword, topic, and graph results appear here.</p></div> : <AnalysisResultView result={result.data} />}
      </div>
    </section>
  </>
}

function AnalysisResultView({ result }: { result: AnalysisResult }) {
  // BERTopic may include the -1 outlier cluster. Excluding it keeps the chart
  // focused on modeled topics while the document payload still retains outliers.
  const modeledTopics = result.topics.filter((topic) => topic.Topic >= 0)
  const topicData = modeledTopics.slice(0, 12).map((topic) => ({
    name: topic.DisplayName ?? legacyTopicLabel(topic.Name),
    count: topic.Count,
  }))
  // NetworkX serializes links under `edges`; react-force-graph expects `links`.
  const graphData = { nodes: result.graph.nodes, links: result.graph.edges }
  const [levelMode, setLevelMode] = useState<'topic' | 'keyword'>('topic')
  const topicOptions = modeledTopics.map((topic) => ({
    value: String(topic.Topic),
    label: topic.DisplayName ?? legacyTopicLabel(topic.Name),
  }))
  const keywordOptions = result.keywords
    .filter((keyword) => !exportMetadataTerm.test(keyword.term))
    .map((keyword) => ({ value: keyword.term, label: keyword.term }))
  const options = levelMode === 'topic' ? topicOptions : keywordOptions
  const [levelSelection, setLevelSelection] = useState(topicOptions[0]?.value ?? '')
  const selectedOption = options.some((option) => option.value === levelSelection)
    ? levelSelection
    : options[0]?.value ?? ''
  const selectedFrequencies = levelMode === 'topic'
    ? (result.topics_by_level ?? []).filter((row) => String(row.topic) === selectedOption)
    : (result.keywords_by_level ?? []).filter((row) => row.term === selectedOption)
  const frequencyByLevel = new Map(selectedFrequencies.map((row) => [row.level, row]))
  const levelData = (result.documents_by_level ?? []).map((row) => ({
    level: row.level,
    range: row.level_range,
    documents: row.document_count,
    prevalence: (frequencyByLevel.get(row.level)?.prevalence ?? 0) * 100,
    matches: frequencyByLevel.get(row.level)?.document_count ?? 0,
  }))
  return <>
    <div className="analysis-stat-row"><div className="panel"><Tags /><strong>{result.keywords.length}</strong><span>keywords</span></div><div className="panel"><BarChart3 /><strong>{modeledTopics.length}</strong><span>modeled topics</span></div><div className="panel"><Network /><strong>{result.graph.nodes.length}</strong><span>graph nodes</span></div></div>
    <CorpusBrowser result={result} />
    <div className="analysis-panels">
      <div className="panel chart-panel"><div className="panel-title"><h2>Topic frequency</h2></div><ResponsiveContainer width="100%" height={330}><BarChart data={topicData} layout="vertical" margin={{ left: 8, right: 18 }}><CartesianGrid stroke="#e1e5e0" horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={122} tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="count" fill="#1d604d" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
      <div className="panel keyword-panel"><div className="panel-title"><h2>Distinct keywords</h2></div><div className="keyword-list">{result.keywords.filter((keyword) => !exportMetadataTerm.test(keyword.term)).map((keyword, index, keywords) => <div key={keyword.term}><span>{index + 1}</span><strong>{keyword.term}</strong><meter min={0} max={keywords[0]?.score || 1} value={keyword.score} /></div>)}</div></div>
    </div>
    <div className="panel level-panel">
      <div className="panel-title"><div><p className="eyebrow">chaos / range / level</p><h2>Frequency across numbered levels</h2></div><div className="level-controls"><select value={levelMode} onChange={(event) => { const mode = event.target.value as 'topic' | 'keyword'; setLevelMode(mode); const nextOptions = mode === 'topic' ? topicOptions : keywordOptions; setLevelSelection(nextOptions[0]?.value ?? '') }}><option value="topic">Topic</option><option value="keyword">Keyword</option></select><select value={selectedOption} onChange={(event) => setLevelSelection(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></div>
      {levelData.length ? <ResponsiveContainer width="100%" height={300}><LineChart data={levelData} margin={{ left: 8, right: 18, top: 8 }}><CartesianGrid stroke="#e1e5e0" vertical={false} /><XAxis dataKey="level" tick={{ fontSize: 10 }} minTickGap={20} /><YAxis tick={{ fontSize: 10 }} unit="%" width={42} /><Tooltip formatter={(value, name, item) => name === 'prevalence' ? [`${Number(value).toFixed(1)}% (${item.payload.matches}/${item.payload.documents} docs)`, 'frequency'] : [value, name]} labelFormatter={(level, payload) => `Level ${level} · ${payload[0]?.payload.range ?? ''}`} /><Line type="monotone" dataKey="prevalence" stroke="#1d604d" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer> : <div className="level-empty">Run a new analysis to calculate numbered-level frequencies.</div>}
    </div>
    <div className="panel graph-panel"><div className="panel-title"><div><p className="eyebrow">Documents · topics · concepts</p><h2>Relationship graph</h2></div></div><div className="graph-canvas"><ForceGraph2D graphData={graphData} width={900} height={440} nodeLabel="label" nodeAutoColorBy="kind" linkColor={() => '#cbd3ce'} linkWidth={0.7} nodeRelSize={4} /></div></div>
  </>
}
