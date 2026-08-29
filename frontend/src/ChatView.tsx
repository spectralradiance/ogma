import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { api } from './api'
import { JobBanner } from './JobBanner'
import type { Job } from './types'
import { useJobEvents } from './useJobEvents'

const CHAT_MODELS = [
  { value: 'Qwen/Qwen2.5-7B-Instruct', label: 'Local GPU · Qwen2.5 7B' },
  { value: 'Qwen/Qwen2.5-14B-Instruct', label: 'Local GPU · Qwen2.5 14B' },
  { value: 'claude-opus-5', label: 'Claude API · Opus 5' },
  { value: 'claude-sonnet-5', label: 'Claude API · Sonnet 5' },
]
const SESSION_STORAGE_KEY = 'ogma-chat-session-id'
const newSessionId = () => `chat-${Date.now().toString(36)}`

const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Never'

/** Chat over the indexed notes: every question is answered with retrieved excerpts as context (RAG), same retrieval path write_book.py uses. */
export function ChatView({ jobs, onTrack, onOpenJob }: { jobs: Job[]; onTrack: (job: Job) => void; onOpenJob: (jobId: string) => void }) {
  const queryClient = useQueryClient()
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(SESSION_STORAGE_KEY) || newSessionId())
  const [draft, setDraft] = useState('')
  const [modelName, setModelName] = useState(CHAT_MODELS[0].value)
  const scrollRef = useRef<HTMLDivElement>(null)
  const provider = modelName.toLowerCase().startsWith('claude') ? 'claude' : 'local'

  useEffect(() => localStorage.setItem(SESSION_STORAGE_KEY, sessionId), [sessionId])

  const sessions = useQuery({ queryKey: ['chat-sessions'], queryFn: api.chatSessions, refetchInterval: 10000 })
  const session = useQuery({ queryKey: ['chat-session', sessionId], queryFn: () => api.chatSession(sessionId) })

  const activeJob = jobs.find((job) => job.kind === 'chat' && job.system === sessionId && (job.status === 'queued' || job.status === 'running')) ?? null
  const liveJob = useJobEvents(activeJob?.id ?? null)
  const currentJob = liveJob ?? activeJob

  useEffect(() => {
    if (currentJob?.status === 'completed') {
      void queryClient.invalidateQueries({ queryKey: ['chat-session', sessionId] })
      void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
    }
  }, [currentJob?.status, sessionId, queryClient])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [session.data?.messages.length, currentJob?.logs.length])

  const send = useMutation({
    mutationFn: () => api.startChat(sessionId, draft.trim(), provider, modelName),
    onSuccess: (job) => { onTrack(job); setDraft('') },
  })
  const cancel = useMutation({ mutationFn: api.cancelJob })
  const clear = useMutation({
    mutationFn: () => api.clearChatSession(sessionId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat-session', sessionId] }),
  })

  const submit = () => {
    if (!draft.trim() || send.isPending || Boolean(activeJob)) return
    send.mutate()
  }

  return <section className="chat-view">
    <div className="panel chat-sidebar">
      <div className="panel-title"><div><p className="eyebrow">RAG chat</p><h2>Sessions</h2></div><button className="icon-button" title="New chat" onClick={() => setSessionId(newSessionId())}><MessageSquarePlus /></button></div>
      <div className="chat-session-list">
        {(sessions.data ?? []).length === 0 && <p className="empty-copy">No sessions yet — send a message to start one.</p>}
        {(sessions.data ?? []).map((item) => <button key={item.session_id} className={item.session_id === sessionId ? 'selected' : ''} onClick={() => setSessionId(item.session_id)}>
          <strong>{item.session_id}</strong>
          <span>{item.messages.length} messages · {formatDate(item.updated_at)}</span>
        </button>)}
      </div>
    </div>

    <div className="panel chat-main">
      <div className="chat-head">
        <div><strong>{sessionId}</strong><span>{session.data?.messages.length ?? 0} messages, grounded in the indexed notes</span></div>
        <div className="chat-head-actions">
          <select value={modelName} onChange={(event) => setModelName(event.target.value)}>{CHAT_MODELS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <button className="icon-button" title="Refresh" onClick={() => void session.refetch()}><RefreshCw /></button>
          <button className="icon-button" title="Clear this session" onClick={() => clear.mutate()}><Trash2 /></button>
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {!session.data?.messages.length && !currentJob && <div className="chat-empty">
          <p>Ask anything about the indexed writing notes. Each answer retrieves the most relevant excerpts first, same as <code>chat.py</code> or the manuscript generator.</p>
        </div>}
        {(session.data?.messages ?? []).map((message, index) => <div key={index} className={`chat-bubble ${message.role}`}>
          <span className="chat-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
          <p>{message.content}</p>
        </div>)}
        {currentJob && <JobBanner job={currentJob} onOpenLogs={onOpenJob} onCancel={cancel.mutate} className="chat-progress" />}
        {send.error && <p className="request-error">{send.error.message}</p>}
      </div>

      <div className="chat-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }}
          placeholder="Ask about the indexed notes..."
          rows={2}
        />
        <button className="primary" disabled={!draft.trim() || send.isPending || Boolean(activeJob)} onClick={submit}><Send size={15} /> Send</button>
      </div>
    </div>
  </section>
}
