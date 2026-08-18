import type { Job } from './types'


export interface JobProgress {
  percent: number
  label: string
  detail: string
}

function latestMatch(logs: string[], pattern: RegExp): RegExpMatchArray | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const match = logs[index]?.match(pattern)
    if (match) return match
  }
  return null
}

export function generationProgress(job: Job): JobProgress {
  if (job.status === 'completed') return { percent: 100, label: 'Generation complete', detail: job.logs.at(-1) ?? 'Complete' }
  if (job.status === 'queued') return { percent: 0, label: 'Generation queued', detail: 'Waiting for the background worker' }

  const architecture = latestMatch(job.logs, /Architecture:\s*(\d+)\s*\/\s*(\d+)/)
  const outline = latestMatch(job.logs, /Outline:\s*(\d+)\s*\/\s*(\d+)/)
  const prosePlan = latestMatch(job.logs, /Step 2: generate\s+(\d+)\s*\/\s*(\d+) manuscript sections/)
  const architectureStart = Number(architecture?.[1] ?? 0)
  const architectureTotal = Number(architecture?.[2] ?? 0)
  const outlineStart = Number(outline?.[1] ?? 0)
  const outlineTotal = Number(outline?.[2] ?? 0)
  const proseTotal = job.kind === 'manuscript' ? Number(prosePlan?.[2] ?? 0) : 0
  const grounded = job.logs.filter((line) => /^\s*Grounded\s+/.test(line)).length
  const planned = job.logs.filter((line) => /^\s*Planned\s+/.test(line)).length
  const prose = Number(latestMatch(job.logs, /\[(\d+)\/(\d+)\]\s+/)?.[1] ?? 0)
  const total = architectureTotal + outlineTotal + proseTotal
  const complete = Math.min(architectureTotal, architectureStart + grounded)
    + Math.min(outlineTotal, outlineStart + planned)
    + Math.min(proseTotal, prose)
  const percent = total > 0 ? Math.min(99, Math.round((complete / total) * 100)) : 1

  const latest = [...job.logs].reverse().find((line) => (
    /^\s*(Grounded|Planned)\s+/.test(line)
    || /\[\d+\/\d+\]\s+/.test(line)
    || line.includes('Loading ')
    || line.includes('Model ready')
    || line.includes('Grounding ')
    || line.includes('Planning ')
  )) ?? job.logs.at(-1) ?? 'Starting generation process'

  let label = 'Preparing generation model'
  if (prose > 0 || job.logs.some((line) => /\[\d+\/\d+\]\s+/.test(line))) label = 'Writing manuscript'
  else if (planned > 0 || job.logs.some((line) => line.startsWith('Planning '))) label = 'Planning sections'
  else if (grounded > 0 || job.logs.some((line) => line.startsWith('Grounding '))) label = 'Grounding chapter structure'

  return { percent, label, detail: latest.trim() }
}