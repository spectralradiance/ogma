import { useDeferredValue, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { BarChart3, Network, Play, Tags } from 'lucide-react'
import ForceGraph2D from 'react-force-graph-2d'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from './api'
import type { AnalysisResult, Job } from './types'

export function AnalysisView({ onTrack }: { onTrack: (job: Job) => void }) {
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  // Defer loading a potentially large graph payload so selecting a history row
  // remains responsive while React transitions to the new visualization.
  const deferredRun = useDeferredValue(selectedRun)
  const analyses = useQuery({ queryKey: ['analyses'], queryFn: api.analyses, refetchInterval: 5000 })
  const result = useQuery({
    queryKey: ['analysis', deferredRun],
    queryFn: () => api.analysis(deferredRun!),
    enabled: Boolean(deferredRun),
  })
  const start = useMutation({ mutationFn: api.startAnalysis, onSuccess: onTrack })

  return <>
    <section className="analysis-toolbar panel">
      <div><p className="eyebrow">BERTopic + KeyBERT</p><h2>Corpus analysis</h2><span>Analyze every eligible note across the complete directory tree.</span>{start.error && <strong className="request-error">{start.error.message}</strong>}</div>
      <button className="primary-command" onClick={() => start.mutate()} disabled={start.isPending}><Play /> {start.isPending ? 'Queueing...' : 'Run analysis'}</button>
    </section>

    <section className="analysis-layout">
      <div className="panel analysis-list"><div className="panel-title"><div><p className="eyebrow">History</p><h2>Analysis runs</h2></div></div>{analyses.data?.length ? analyses.data.map((item) => <button key={item.run_id} className={selectedRun === item.run_id ? 'selected' : ''} onClick={() => setSelectedRun(item.run_id)}><strong>{item.run_id.replace('generated', '')}</strong><span>{item.document_count} docs · {item.topic_count} topics</span></button>) : <p className="empty-copy">No analyses yet.</p>}</div>
      <div className="analysis-results">
        {!result.data ? <div className="panel analysis-empty"><Network /><h2>Select an analysis run</h2><p>Completed keyword, topic, and graph results appear here.</p></div> : <AnalysisResultView result={result.data} />}
      </div>
    </section>
  </>
}

function AnalysisResultView({ result }: { result: AnalysisResult }) {
  // BERTopic may include the -1 outlier cluster. Excluding it keeps the chart
  // focused on modeled topics while the document payload still retains outliers.
  const topicData = result.topics.filter((topic) => topic.Topic >= 0).slice(0, 12).map((topic) => ({ name: topic.Name.replace(/^\d+_/, '').slice(0, 22), count: topic.Count }))
  // NetworkX serializes links under `edges`; react-force-graph expects `links`.
  const graphData = { nodes: result.graph.nodes, links: result.graph.edges }
  return <>
    <div className="analysis-stat-row"><div className="panel"><Tags /><strong>{result.keywords.length}</strong><span>keywords</span></div><div className="panel"><BarChart3 /><strong>{topicData.length}</strong><span>modeled topics</span></div><div className="panel"><Network /><strong>{result.graph.nodes.length}</strong><span>graph nodes</span></div></div>
    <div className="analysis-panels">
      <div className="panel chart-panel"><div className="panel-title"><h2>Topic frequency</h2></div><ResponsiveContainer width="100%" height={330}><BarChart data={topicData} layout="vertical" margin={{ left: 8, right: 18 }}><CartesianGrid stroke="#e1e5e0" horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={122} tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="count" fill="#1d604d" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
      <div className="panel keyword-panel"><div className="panel-title"><h2>Distinct keywords</h2></div><div className="keyword-list">{result.keywords.map((keyword, index) => <div key={keyword.term}><span>{index + 1}</span><strong>{keyword.term}</strong><meter min={0} max={result.keywords[0]?.score || 1} value={keyword.score} /></div>)}</div></div>
    </div>
    <div className="panel graph-panel"><div className="panel-title"><div><p className="eyebrow">Documents · topics · concepts</p><h2>Relationship graph</h2></div></div><div className="graph-canvas"><ForceGraph2D graphData={graphData} width={900} height={440} nodeLabel="label" nodeAutoColorBy="kind" linkColor={() => '#cbd3ce'} linkWidth={0.7} nodeRelSize={4} /></div></div>
  </>
}
