import { useEffect, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import { MATCH_END, MATCH_START, type SearchHit, type SearchStatus } from '../../shared/ipc'
import { dirname } from '../../shared/paths'
import { errorMessage } from './target'

interface SearchPanelProps {
  roots: string[]
  /** The focused editor's text and the files to leave out, for "related"; null when nothing is focused. */
  relatedSource: () => { label: string; text: string; exclude: string[] } | null
  onOpen: (hit: SearchHit) => void
  autoFocus: boolean
}

function Snippet({ text }: { text: string }) {
  // Split on the markers: odd parts are matches.
  const parts = text.split(new RegExp(`${MATCH_START}|${MATCH_END}`))
  return (
    <span className="search-snippet">
      {parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}
    </span>
  )
}

function relativeFolder(file: string, roots: string[]): string {
  const folder = dirname(file)
  const root = roots.find((candidate) => folder.toLowerCase().startsWith(candidate.toLowerCase()))
  const relative = root ? folder.slice(root.length).replace(/^[\\/]/, '') : folder
  return relative || folderName(root ?? folder)
}

function groupByFile(hits: SearchHit[]): [string, SearchHit[]][] {
  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit])
  return [...groups.entries()]
}

export function SearchPanel({ roots, relatedSource, onOpen, autoFocus }: SearchPanelProps) {
  const [status, setStatus] = useState<SearchStatus | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ title: string; hits: SearchHit[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const unsubscribe = window.ogma.search.onProgress(setStatus)
    // Building the index reads every text file once; later passes only re-read changed files.
    window.ogma.search.sync().then(setStatus, (reason: unknown) => setError(errorMessage(reason)))
    return unsubscribe
  }, [roots])

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const text = query.trim()
    if (!text) return
    let active = true
    const timer = window.setTimeout(() => {
      window.ogma.search.query(text).then(
        (hits) => { if (active) setResults({ title: `${hits.length}${hits.length === 100 ? '+' : ''} matches`, hits }) },
        (reason: unknown) => { if (active) setError(errorMessage(reason)) },
      )
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query, status?.ready])

  const findRelated = () => {
    const source = relatedSource()
    if (!source) {
      setError('Click into a document first.')
      return
    }
    setError(null)
    window.ogma.search.related(source.text, source.exclude).then(
      (hits) => setResults({ title: `Related to ${source.label}`, hits }),
      (reason: unknown) => setError(errorMessage(reason)),
    )
  }

  const indexing = status?.indexing
  return (
    <div className="search-panel">
      <div className="search-box">
        <input
          ref={input}
          value={query}
          placeholder="Search all folders"
          onChange={(event) => {
            setQuery(event.target.value)
            if (!event.target.value.trim()) setResults(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
              setResults(null)
            }
          }}
        />
        <button type="button" className="link-button" onClick={findRelated} title="Paragraphs elsewhere that share the focused passage's key words">
          Related to the current passage
        </button>
        <p className="lexical-hint">
          {indexing
            ? `Indexing ${status.done.toLocaleString()} of ${status.total.toLocaleString()} files…`
            : status ? `${status.files.toLocaleString()} files indexed` : 'Opening the index…'}
        </p>
      </div>
      {error && <p className="lexical-message status-error search-message">{error}</p>}
      {results && (
        <div className="search-results">
          <h3 className="search-title">{results.title}</h3>
          {results.hits.length === 0 && <p className="lexical-message search-message">Nothing found{indexing ? ' yet — still indexing' : ''}.</p>}
          {groupByFile(results.hits).map(([file, hits]) => (
            <section key={file} className="search-file">
              <h4 title={file}>
                <span>{folderName(file)}</span>
                <span className="search-folder">{relativeFolder(file, roots)}</span>
              </h4>
              {hits.map((hit) => (
                <button key={`${hit.line}:${hit.snippet.slice(0, 20)}`} type="button" className="search-hit" onClick={() => onOpen(hit)}>
                  <span className="search-line">{hit.line}</span>
                  <Snippet text={hit.snippet} />
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
