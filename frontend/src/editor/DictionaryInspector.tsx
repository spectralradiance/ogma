import { BookOpen, Languages, Volume2 } from 'lucide-react'

import type { DictionaryEntry } from '../types'


interface DictionaryInspectorProps {
  word: string | null
  entries: DictionaryEntry[] | undefined
  loading: boolean
  error: string | null
}

export function DictionaryInspector({ word, entries, loading, error }: DictionaryInspectorProps) {
  if (!word) return <div className="lexicon-empty"><BookOpen /><h3>Lexicon inspector</h3><p>Select one word in the editor to inspect its senses and history.</p></div>
  return <div className="lexicon-inspector">
    <div className="lexicon-word"><p className="eyebrow">Selected word</p><h2>{word}</h2></div>
    {loading && <p className="lexicon-state">Looking up local Wiktionary...</p>}
    {error && <p className="lexicon-error">{error}</p>}
    {!loading && !error && !entries?.length && <p className="lexicon-state">No entry found.</p>}
    {entries?.map((entry) => <article key={entry.id} className="lexicon-entry">
      <div className="lexicon-entry-head"><strong>{entry.pos ?? 'unclassified'}</strong>{entry.data.ipa.length > 0 && <span><Volume2 />{entry.data.ipa.join(' · ')}</span>}</div>
      {entry.etymology && <div className="etymology"><Languages /><div><span>Etymology</span><p>{entry.etymology}</p></div></div>}
      <ol>{entry.data.senses.map((sense, index) => <li key={`${entry.id}-${index}`}>
        {sense.glosses.join('; ') || 'No definition available'}
        {sense.examples[0] && <blockquote>{sense.examples[0].text}</blockquote>}
      </li>)}</ol>
      <Relations label="Synonyms" values={entry.data.synonyms} />
      <Relations label="Antonyms" values={entry.data.antonyms} />
      <Relations label="Derived" values={entry.data.derived} />
      <Relations label="Related" values={entry.data.related} />
    </article>)}
  </div>
}

function Relations({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null
  return <div className="lexicon-relations"><span>{label}</span><div>{values.slice(0, 12).map((value) => <i key={value}>{value}</i>)}</div></div>
}