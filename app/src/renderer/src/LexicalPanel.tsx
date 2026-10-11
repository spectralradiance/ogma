import { useCallback, useEffect, useMemo, useState } from 'react'

import { parseEtymology } from '../../shared/etymology'
import type { DictionaryDownload, DictionaryEntry, DictionarySearchResult, DictionaryStatus, LexiconEntry } from '../../shared/ipc'
import { matchesLexiconQuery, splitList } from '../../shared/lexicon'
import { readPref, writePref } from './prefs'
import { errorMessage } from './target'

export interface LexicalQuery {
  word: string
  /** Sentence the word came from, saved with lexicon entries. */
  context: string
  source: string | null
}

type Tab = 'define' | 'etymology' | 'thesaurus' | 'lexicon' | 'external'

const TABS: { id: Tab; label: string }[] = [
  { id: 'define', label: 'Define' },
  { id: 'etymology', label: 'Etymology' },
  { id: 'thesaurus', label: 'Thesaurus' },
  { id: 'lexicon', label: 'Lexicon' },
  { id: 'external', label: 'Web' },
]

// Aisling's lookup table, https only.
const EXTERNAL_SITES: { label: string; url: (word: string) => string }[] = [
  { label: 'Wiktionary', url: (word) => `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` },
  { label: 'Etymonline', url: (word) => `https://www.etymonline.com/search?q=${encodeURIComponent(word)}` },
  { label: 'Merriam-Webster', url: (word) => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}` },
  { label: 'Merriam-Webster Thesaurus', url: (word) => `https://www.merriam-webster.com/thesaurus/${encodeURIComponent(word)}` },
  { label: 'Dictionary.com', url: (word) => `https://www.dictionary.com/browse/${encodeURIComponent(word)}` },
  { label: 'Thesaurus.com', url: (word) => `https://www.thesaurus.com/browse/${encodeURIComponent(word)}` },
  { label: 'RhymeZone', url: (word) => `https://www.rhymezone.com/r/rhyme.cgi?Word=${encodeURIComponent(word)}&typeofrhyme=perfect` },
]

function wiktionaryUrl(term: string, language: string): string {
  const page = term.replace(/^\*/, 'Reconstruction:' + language.replace(/ /g, '_') + '/')
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(page).replace(/%2F/g, '/').replace(/%3A/g, ':')}#${encodeURIComponent(language.replace(/ /g, '_'))}`
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576).toLocaleString()} MB`

/** Offers to download Wiktionary and build the dictionary from it, with progress. */
function DictionaryDownloader({ onReady }: { onReady: (status: DictionaryStatus) => void }) {
  const [progress, setProgress] = useState<DictionaryDownload | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const busy = progress !== null && (progress.state === 'downloading' || progress.state === 'indexing')

  useEffect(() => window.ogma.dictionary.onDownload(setProgress), [])

  const start = () => {
    setFailure(null)
    window.ogma.dictionary.download().then(onReady, (reason: unknown) => setFailure(errorMessage(reason)))
  }

  return (
    <div className="dictionary-download">
      {busy ? (
        <>
          <progress value={progress.total ? progress.received : undefined} max={progress.total ?? undefined} />
          <p>
            {progress.state === 'indexing'
              ? 'Building the search index…'
              : `Downloading Wiktionary: ${megabytes(progress.received)}${progress.total ? ` of ${megabytes(progress.total)}` : ''} · ${progress.entries.toLocaleString()} entries`}
          </p>
          <button type="button" disabled={progress.state === 'indexing'} onClick={() => void window.ogma.dictionary.cancelDownload()}>Cancel</button>
        </>
      ) : (
        <>
          <button type="button" onClick={start}>Download Wiktionary</button>
          <p className="lexical-hint">A one-time download of about 2.5 GB from kaikki.org; it becomes a database of roughly 1 GB on this computer.</p>
        </>
      )}
      {failure && <p className="status-error">{failure}</p>}
    </div>
  )
}

interface LexicalPanelProps {
  query: LexicalQuery | null
  onLookup: (word: string) => void
  /** Replaces the current word in the active editor; false if there is none. */
  onReplace: (word: string) => boolean
}

export function LexicalPanel({ query, onLookup, onReplace }: LexicalPanelProps) {
  const [tab, setTab] = useState<Tab>(() => (readPref('lexicalTab') as Tab | null) ?? 'define')
  const [status, setStatus] = useState<DictionaryStatus | null>(null)
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lexicon, setLexicon] = useState<LexiconEntry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const word = query?.word ?? null

  const chooseTab = (next: Tab) => {
    setTab(next)
    writePref('lexicalTab', next)
  }

  const refreshLexicon = useCallback(() => window.ogma.lexicon.list().then(setLexicon, () => setLexicon([])), [])

  useEffect(() => {
    void window.ogma.dictionary.status().then(setStatus)
    void refreshLexicon()
  }, [refreshLexicon])

  useEffect(() => {
    if (!word || !status?.available) return
    let active = true
    window.ogma.dictionary.lookup(word).then(
      (result) => {
        if (!active) return
        setEntries(result)
        setLookupError(null)
      },
      (error: unknown) => {
        if (!active) return
        setEntries(null)
        setLookupError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [word, status])

  const lookUp = (next: string) => {
    if (word && next.toLocaleLowerCase() !== word.toLocaleLowerCase()) setHistory((items) => [...items.slice(-30), word])
    onLookup(next)
  }
  const back = () => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((items) => items.slice(0, -1))
    onLookup(previous)
  }

  const saved = useMemo(
    () => (word ? lexicon.find((entry) => entry.word.toLocaleLowerCase() === word.toLocaleLowerCase()) ?? null : null),
    [lexicon, word],
  )

  return (
    <div className="lexical-panel" aria-label="Words">
      <header className="lexical-header">
        <button type="button" className="icon-button" onClick={back} disabled={history.length === 0} title="Back" aria-label="Back">←</button>
        <SearchBox word={word} onLookup={lookUp} enabled={status?.available ?? false} />
      </header>
      <nav className="lexical-tabs" role="tablist">
        {TABS.map((option) => (
          <button key={option.id} type="button" role="tab" aria-selected={tab === option.id} onClick={() => chooseTab(option.id)}>
            {option.label}
          </button>
        ))}
      </nav>

      <div className="lexical-body">
        {status && !status.available && tab !== 'lexicon' && tab !== 'external' && (
          <div className="lexical-message">
            <p>{status.error}</p>
            <DictionaryDownloader onReady={setStatus} />
            <button type="button" className="link-button" onClick={() => void window.ogma.dictionary.choose().then(setStatus)}>or choose an existing wiktionary.db…</button>
          </div>
        )}
        {!word && tab !== 'lexicon' && status?.available && (
          <p className="lexical-message">Select a word, or press Ctrl+D with the cursor on one.</p>
        )}
        {lookupError && <p className="lexical-message status-error">{lookupError}</p>}

        {word && status?.available && entries && tab === 'define' && <DefineTab word={word} entries={entries} saved={saved} />}
        {word && status?.available && entries && tab === 'etymology' && <EtymologyTab word={word} entries={entries} onLookup={lookUp} />}
        {word && status?.available && entries && tab === 'thesaurus' && (
          <ThesaurusTab entries={entries} saved={saved} onLookup={lookUp} onReplace={onReplace} />
        )}
        {tab === 'lexicon' && (
          <LexiconTab
            query={query}
            entries={entries}
            saved={saved}
            lexicon={lexicon}
            onLookup={lookUp}
            onChanged={() => void refreshLexicon()}
          />
        )}
        {word && tab === 'external' && (
          <ul className="lexical-links">
            {EXTERNAL_SITES.map((site) => (
              <li key={site.label}>
                <button type="button" className="link-button" onClick={() => window.open(site.url(word), '_blank')}>
                  {site.label} ↗
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function SearchBox({ word, onLookup, enabled }: { word: string | null; onLookup: (word: string) => void; enabled: boolean }) {
  const [text, setText] = useState(word ?? '')
  const [shown, setShown] = useState(word)
  const [suggestions, setSuggestions] = useState<DictionarySearchResult[]>([])
  // Follow the looked-up word unless the user is typing a new one.
  if (word !== shown) {
    setShown(word)
    setText(word ?? '')
    setSuggestions([])
  }

  useEffect(() => {
    const trimmed = text.trim()
    if (!enabled || trimmed.length < 2 || trimmed === word) return
    let active = true
    const timer = window.setTimeout(() => {
      window.ogma.dictionary.search(trimmed, 8).then((results) => { if (active) setSuggestions(results) }, () => {})
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [text, enabled, word])

  const submit = (value: string) => {
    setSuggestions([])
    if (value.trim()) onLookup(value.trim())
  }

  return (
    <div className="lexical-search">
      <input
        value={text}
        placeholder="Look up a word"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit(text)
          if (event.key === 'Escape') setSuggestions([])
        }}
        onBlur={() => window.setTimeout(() => setSuggestions([]), 150)}
      />
      {suggestions.length > 0 && (
        <ul className="lexical-suggestions">
          {suggestions.map((result) => (
            <li key={`${result.word}|${result.pos}`}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => submit(result.word)}>
                <strong>{result.word}</strong> <em>{result.pos}</em>
                <span>{result.gloss}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DefineTab({ word, entries, saved }: { word: string; entries: DictionaryEntry[]; saved: LexiconEntry | null }) {
  const ipa = [...new Set(entries.flatMap((entry) => entry.ipa))].slice(0, 3)
  return (
    <div className="lexical-define">
      <h2 className="lexical-word">{entries[0]?.word ?? word}</h2>
      {ipa.length > 0 && <p className="lexical-ipa">{ipa.join(' · ')}</p>}
      {saved && <p className="lexical-saved" title={saved.definition}>In your lexicon{saved.tags.length ? ` · ${saved.tags.join(', ')}` : ''}</p>}
      {entries.length === 0 && <p className="lexical-message">No entry in the local Wiktionary.</p>}
      {entries.map((entry) => (
        <section key={entry.id} className="lexical-entry">
          <h3>{entry.pos ?? 'unclassified'}</h3>
          <ol>
            {entry.senses.filter((sense) => sense.glosses.length > 0).slice(0, 12).map((sense, index) => (
              <li key={index}>
                {sense.glosses.join('; ')}
                {sense.examples[0] && <blockquote>{sense.examples[0].text}</blockquote>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function EtymologyTab({ word, entries, onLookup }: { word: string; entries: DictionaryEntry[]; onLookup: (word: string) => void }) {
  // Parts of speech often share one etymology; show each distinct text once.
  const texts = [...new Set(entries.map((entry) => entry.etymology).filter((text): text is string => Boolean(text)))]
  if (texts.length === 0) return <p className="lexical-message">No etymology recorded for “{word}”.</p>
  return (
    <div className="lexical-etymology">
      {texts.map((text, index) => {
        const etymology = parseEtymology(text, entries[0]?.word ?? word)
        return (
          <section key={index} className="lexical-entry">
            {texts.length > 1 && <h3>Etymology {index + 1}</h3>}
            {etymology.tree.length > 0 && (
              <ol className="etymology-tree">
                {etymology.tree.map((step, stepIndex) => (
                  <li key={stepIndex}>
                    <span className="etymology-language">{step.language}</span>
                    {step.language === 'English' ? (
                      <button type="button" className="link-button" onClick={() => onLookup(step.term)}>{step.term}</button>
                    ) : (
                      <button type="button" className="link-button" onClick={() => window.open(wiktionaryUrl(step.term, step.language), '_blank')}>
                        {step.term} ↗
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {etymology.prose && <p className="etymology-prose">{etymology.prose}</p>}
            {etymology.cognates && (
              <details>
                <summary>Cognates</summary>
                <p className="etymology-cognates">{etymology.cognates}</p>
              </details>
            )}
          </section>
        )
      })}
    </div>
  )
}

function ThesaurusTab({ entries, saved, onLookup, onReplace }: {
  entries: DictionaryEntry[]
  saved: LexiconEntry | null
  onLookup: (word: string) => void
  onReplace: (word: string) => boolean
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const collect = (key: 'synonyms' | 'antonyms' | 'related' | 'derived') =>
    [...new Set(entries.flatMap((entry) => entry[key]))]
  // Only synonyms and antonyms are offered as replacements; related and derived words are for exploring.
  const groups: { label: string; words: string[]; replaceable: boolean }[] = [
    { label: 'Synonyms', words: [...new Set([...(saved?.synonyms ?? []), ...collect('synonyms')])], replaceable: true },
    { label: 'Antonyms', words: collect('antonyms'), replaceable: true },
    { label: 'Related', words: collect('related'), replaceable: false },
    { label: 'Derived', words: collect('derived').slice(0, 40), replaceable: false },
  ].filter((group) => group.words.length > 0)

  const replace = (word: string) => {
    setNotice(onReplace(word) ? null : 'Put the cursor on a word in the text first.')
  }

  if (groups.length === 0) return <p className="lexical-message">No related words recorded.</p>
  return (
    <div className="lexical-thesaurus">
      <p className="lexical-hint">Click to look up · on synonyms and antonyms, ↵ or Alt+click replaces the word in your text</p>
      {notice && <p className="lexical-message status-error">{notice}</p>}
      {groups.map((group) => (
        <section key={group.label} className="lexical-entry">
          <h3>{group.label}</h3>
          <div className="chips">
            {group.words.map((word) => (
              <span key={word} className="chip">
                <button type="button" onClick={(event) => (event.altKey && group.replaceable ? replace(word) : onLookup(word))}>{word}</button>
                {group.replaceable && (
                  <button type="button" className="chip-replace" title={`Replace with “${word}”`} onClick={() => replace(word)}>↵</button>
                )}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function LexiconTab({ query, entries, saved, lexicon, onLookup, onChanged }: {
  query: LexicalQuery | null
  entries: DictionaryEntry[] | null
  saved: LexiconEntry | null
  lexicon: LexiconEntry[]
  onLookup: (word: string) => void
  onChanged: () => void
}) {
  const [filter, setFilter] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [location, setLocation] = useState('')

  useEffect(() => {
    void window.ogma.lexicon.location().then(setLocation)
  }, [])

  const importAisling = () => {
    window.ogma.lexicon.importAisling().then((result) => {
      if (!result) return
      setMessage(`Imported ${result.imported} word${result.imported === 1 ? '' : 's'}; skipped ${result.skipped}.`)
      onChanged()
    }, (error: unknown) => setMessage(errorMessage(error)))
  }

  const shown = lexicon.filter((entry) => matchesLexiconQuery(entry, filter))
  return (
    <div className="lexical-lexicon">
      {query && (
        <SaveForm key={`${query.word}|${saved?.added ?? ''}`} query={query} entries={entries} saved={saved} onSaved={(text) => {
          setMessage(text)
          onChanged()
        }} />
      )}
      {message && <p className="lexical-message">{message}</p>}
      <div className="lexicon-list-head">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search · tag: syn: word: def:" />
        <span>{shown.length}/{lexicon.length}</span>
      </div>
      <ul className="lexicon-list">
        {shown.map((entry) => (
          <li key={entry.word}>
            <button type="button" onClick={() => onLookup(entry.word)}>
              <strong>{entry.word}</strong>
              {entry.tags.length > 0 && <em>{entry.tags.join(', ')}</em>}
              <span>{entry.definition}</span>
            </button>
          </li>
        ))}
        {lexicon.length === 0 && <li className="lexical-message">No saved words yet.</li>}
      </ul>
      <footer className="lexicon-footer">
        <button type="button" className="link-button" onClick={importAisling}>Import Aisling vocabulary…</button>
        <span title={location}>Stored in {location}</span>
      </footer>
    </div>
  )
}

function SaveForm({ query, entries, saved, onSaved }: {
  query: LexicalQuery
  entries: DictionaryEntry[] | null
  saved: LexiconEntry | null
  onSaved: (message: string) => void
}) {
  const firstGloss = entries?.flatMap((entry) => entry.senses.flatMap((sense) => sense.glosses))[0] ?? ''
  const [definition, setDefinition] = useState(saved?.definition ?? firstGloss)
  const [tags, setTags] = useState(saved?.tags.join(', ') ?? '')
  const [synonyms, setSynonyms] = useState(saved?.synonyms.join(', ') ?? '')
  const [context, setContext] = useState(saved?.context || query.context)
  const [note, setNote] = useState(saved?.note ?? '')
  const [busy, setBusy] = useState(false)

  const save = () => {
    setBusy(true)
    const word = saved?.word ?? entries?.[0]?.word ?? query.word
    window.ogma.lexicon.save({
      word,
      definition,
      tags: splitList(tags),
      synonyms: splitList(synonyms),
      context,
      source: saved?.source ?? query.source,
      added: saved?.added ?? '',
      note,
    }).then(
      () => onSaved(saved ? `Updated “${word}”.` : `Saved “${word}” to your lexicon.`),
      (error: unknown) => onSaved(errorMessage(error)),
    ).finally(() => setBusy(false))
  }

  const remove = () => {
    if (!saved || !window.confirm(`Move “${saved.word}” to the Recycle Bin?`)) return
    window.ogma.lexicon.remove(saved.word).then(() => onSaved(`Removed “${saved.word}”.`), (error: unknown) => onSaved(errorMessage(error)))
  }

  return (
    <form className="lexicon-form" onSubmit={(event) => { event.preventDefault(); save() }}>
      <h2 className="lexical-word">{saved?.word ?? query.word}</h2>
      <label>Definition<textarea rows={2} value={definition} onChange={(event) => setDefinition(event.target.value)} /></label>
      <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="emotion, cosmology" /></label>
      <label>Synonyms<input value={synonyms} onChange={(event) => setSynonyms(event.target.value)} /></label>
      <label>Context<textarea rows={2} value={context} onChange={(event) => setContext(event.target.value)} /></label>
      <label>Note<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="lexicon-actions">
        <button type="submit" disabled={busy}>{saved ? 'Update' : 'Save word'}</button>
        {saved && <button type="button" onClick={remove}>Remove</button>}
      </div>
    </form>
  )
}
