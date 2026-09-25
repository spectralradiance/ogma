import { useEffect, useMemo, useState } from 'react'

import { applyHunks, changeIndexes, diffLines } from '../../shared/diff'

interface SynthesisReviewProps {
  title: string
  /** The output as it is now. */
  before: string
  /** The AI's draft. */
  after: string
  provenance: string
  onApply: (text: string) => void
  onClose: () => void
}

/**
 * Review an AI draft against the current output, change by change. Nothing is
 * written until Apply, and applying is one undoable edit in the output editor.
 */
export function SynthesisReview({ title, before, after, provenance, onApply, onClose }: SynthesisReviewProps) {
  const hunks = useMemo(() => diffLines(before, after), [before, after])
  const changes = useMemo(() => changeIndexes(hunks), [hunks])
  const [accepted, setAccepted] = useState<Set<number>>(() => new Set(changes))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (index: number) => {
    setAccepted((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal review" role="dialog" aria-label={`Review draft for ${title}`}>
        <header className="modal-header">
          <div>
            <h2>Review draft · {title}</h2>
            <p className="modal-subtitle">{provenance}</p>
          </div>
          <div className="modal-actions">
            <span className="review-count">{accepted.size} of {changes.length} changes kept</span>
            <button type="button" onClick={() => setAccepted(new Set(changes))}>Keep all</button>
            <button type="button" onClick={() => setAccepted(new Set())}>Reject all</button>
          </div>
        </header>
        <div className="review-body">
          {changes.length === 0 && <p className="lexical-message">The draft is identical to the current output.</p>}
          {hunks.map((hunk, index) => hunk.kind === 'same' ? (
            <div key={index} className="review-same">{hunk.lines.join('\n') || ' '}</div>
          ) : (
            <div key={index} className={`review-change${accepted.has(index) ? ' kept' : ' rejected'}`}>
              <div className="review-change-body">
                {hunk.before.length > 0 && <div className="review-before">{hunk.before.join('\n') || ' '}</div>}
                {hunk.after.length > 0 && <div className="review-after">{hunk.after.join('\n') || ' '}</div>}
              </div>
              <label className="review-toggle">
                <input type="checkbox" checked={accepted.has(index)} onChange={() => toggle(index)} />
                {accepted.has(index) ? 'Keep' : 'Rejected'}
              </label>
            </div>
          ))}
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={accepted.size === 0} onClick={() => onApply(applyHunks(hunks, accepted))}>
            Apply to output
          </button>
        </footer>
      </section>
    </div>
  )
}
