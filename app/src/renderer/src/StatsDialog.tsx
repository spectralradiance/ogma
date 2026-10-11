import { useEffect, useState } from 'react'

import type { DailyWords, DocumentStats } from '../../shared/ipc'
import { errorMessage } from './target'
import { X } from 'lucide-react'

import { Modal } from './Modal'

interface StatsDialogProps {
  folder: string
  title: string
  onOpenSection: (stem: string) => void
  onClose: () => void
}

function DailyChart({ days }: { days: DailyWords[] }) {
  const values = days.map((day) => day.notes + day.output)
  const peak = Math.max(1, ...values.map(Math.abs))
  const width = 16
  const height = 64
  return (
    <svg className="daily-chart" viewBox={`0 0 ${days.length * width} ${height + 16}`} role="img"
      aria-label="Net words written per day for the last two weeks">
      <line x1="0" x2={days.length * width} y1={height / 2} y2={height / 2} className="daily-axis" />
      {days.map((day, index) => {
        const value = day.notes + day.output
        const bar = (Math.abs(value) / peak) * (height / 2 - 2)
        return (
          <g key={day.day}>
            <title>{`${day.day}: ${value >= 0 ? '+' : ''}${value} words (output ${day.output}, notes ${day.notes})`}</title>
            <rect x={index * width + 3} width={width - 6} y={value >= 0 ? height / 2 - bar : height / 2} height={Math.max(bar, value ? 1 : 0)}
              className={value >= 0 ? 'daily-up' : 'daily-down'} />
            {(index === 0 || index === days.length - 1) && (
              <text x={index === 0 ? 0 : days.length * width} y={height + 12} className="daily-label"
                textAnchor={index === 0 ? 'start' : 'end'}>{index === days.length - 1 ? 'today' : day.day.slice(5)}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function StatsDialog({ folder, title, onOpenSection, onClose }: StatsDialogProps) {
  const [stats, setStats] = useState<DocumentStats | null>(null)
  const [days, setDays] = useState<DailyWords[]>([])
  const [goal, setGoal] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.ogma.stats.document(folder).then((result) => {
      setStats(result)
      setGoal(result.goal ? String(result.goal) : '')
    }, (reason: unknown) => setError(errorMessage(reason)))
    void window.ogma.stats.daily(14).then(setDays)
  }, [folder])

  const saveGoal = () => {
    const words = Number(goal.replace(/[^\d]/g, ''))
    window.ogma.stats.setGoal(folder, words > 0 ? words : null).then(setStats, (reason: unknown) => setError(errorMessage(reason)))
  }

  const progress = stats?.goal ? Math.min(1, stats.outputWords / stats.goal) : null
  const week = days.slice(-7).reduce((sum, day) => sum + day.notes + day.output, 0)
  const today = days.at(-1)

  return (
    <Modal label={`Statistics for ${title}`} className="stats-dialog" onClose={onClose}>
      <header className="modal-header">
        <h2>Statistics · {title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <div className="settings-body">
        {error && <p className="lexical-message status-error">{error}</p>}
        {stats && (
          <div className="settings-section">
            <div className="stats-summary">
              <div><strong>{stats.outputWords.toLocaleString()}</strong><span>output words</span></div>
              <div><strong>{stats.notesWords.toLocaleString()}</strong><span>notes words</span></div>
              <div><strong>{stats.sections.filter((section) => section.outputWords > 0).length}/{stats.sections.length}</strong><span>sections with output</span></div>
            </div>

            <div className="stats-goal">
              <label>
                Output goal
                <input value={goal} inputMode="numeric" placeholder="e.g. 5000" onChange={(event) => setGoal(event.target.value)}
                  onBlur={saveGoal} onKeyDown={(event) => { if (event.key === 'Enter') saveGoal() }} />
                words
              </label>
              {progress !== null && (
                <div className="goal-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${progress * 100}%` }} />
                  <span>{Math.round(progress * 100)}% · {Math.max(0, stats.goal! - stats.outputWords).toLocaleString()} to go</span>
                </div>
              )}
            </div>

            <table className="settings-table stats-table">
              <thead>
                <tr><th /><th>Section</th><th>Notes</th><th>Output</th><th>Last changed</th></tr>
              </thead>
              <tbody>
                {stats.sections.map((section) => (
                  <tr key={section.stem}>
                    <td className="section-ordinal">{section.ordinal}</td>
                    <td><button type="button" className="link-button" onClick={() => onOpenSection(section.stem)}>{section.title}</button></td>
                    <td>{section.notesWords.toLocaleString()}</td>
                    <td>{section.outputWords ? section.outputWords.toLocaleString() : <span className="lexical-hint">none yet</span>}</td>
                    <td className="lexical-hint">{section.modified ? new Date(section.modified).toLocaleDateString() : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 className="stats-heading">Words written, last two weeks <span className="lexical-hint">(all documents)</span></h3>
            <DailyChart days={days} />
            <p className="lexical-hint">
              Today {today ? `${today.notes + today.output >= 0 ? '+' : ''}${(today.notes + today.output).toLocaleString()}` : '0'} ·
              {' '}last 7 days {week >= 0 ? '+' : ''}{week.toLocaleString()} (net: cuts count as negative)
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
