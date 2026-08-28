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

function lastMeaningfulLine(job: Job, isMeaningful: (line: string) => boolean, fallback: string): string {
  return [...job.logs].reverse().find((line) => line.trim() && isMeaningful(line)) ?? job.logs.at(-1) ?? fallback
}

function generationProgress(job: Job): JobProgress {
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

  const detail = lastMeaningfulLine(job, (line) => (
    /^\s*(Grounded|Planned)\s+/.test(line)
    || /\[\d+\/\d+\]\s+/.test(line)
    || line.includes('Loading ')
    || line.includes('Model ready')
    || line.includes('Grounding ')
    || line.includes('Planning ')
  ), 'Starting generation process')

  let label = 'Preparing generation model'
  if (prose > 0 || job.logs.some((line) => /\[\d+\/\d+\]\s+/.test(line))) label = 'Writing manuscript'
  else if (planned > 0 || job.logs.some((line) => line.startsWith('Planning '))) label = 'Planning sections'
  else if (grounded > 0 || job.logs.some((line) => line.startsWith('Grounding '))) label = 'Grounding chapter structure'

  return { percent, label, detail: detail.trim() }
}

function analysisProgress(job: Job): JobProgress {
  if (job.status === 'completed') return { percent: 100, label: 'Analysis complete', detail: job.logs.at(-1) ?? 'Complete' }
  if (job.status === 'queued') return { percent: 0, label: 'Analysis queued', detail: 'Waiting for the background worker' }

  const phaseMatches = [...job.logs.join('\n').matchAll(/Phase (\d)\/6[^\n]*/g)]
  const latestPhase = phaseMatches.at(-1)
  let percent = 2
  if (latestPhase) {
    const phase = Number(latestPhase[1])
    const within = latestPhase[0].match(/(\d+)\/(\d+) documents/)
    const withinPhase = within ? Number(within[1]) / Number(within[2]) : 0.12
    percent = Math.min(99, Math.round(((phase - 1 + withinPhase) / 6) * 100))
  }
  const detail = lastMeaningfulLine(job, (line) => (
    line.includes('Phase ') || line.startsWith('Still running:') || line.startsWith('Complete:')
  ), 'Starting analysis')

  return { percent, label: 'Analyzing corpus', detail }
}

function conceptsProgress(job: Job): JobProgress {
  if (job.status === 'completed') return { percent: 100, label: 'Concepts complete', detail: job.logs.at(-1) ?? 'Complete' }
  if (job.status === 'queued') return { percent: 0, label: 'Concepts queued', detail: 'Waiting for the background worker' }

  const batch = latestMatch(job.logs, /Generated batch (\d+)\/(\d+):/)
  const percent = batch ? Math.min(99, Math.round((Number(batch[1]) / Number(batch[2])) * 100)) : 3
  const detail = lastMeaningfulLine(job, (line) => line.startsWith('Generated batch') || line.startsWith('Provider:'), 'Starting concept generation')

  return { percent, label: 'Generating concepts', detail }
}

/** Ordered checkpoints: the last one whose pattern has appeared in the logs wins. */
function milestoneProgress(job: Job, label: string, queuedLabel: string, milestones: [RegExp, number][]): JobProgress {
  if (job.status === 'completed') return { percent: 100, label: `${label} complete`, detail: job.logs.at(-1) ?? 'Complete' }
  if (job.status === 'queued') return { percent: 0, label: queuedLabel, detail: 'Waiting for the background worker' }

  let percent = 2
  for (const [pattern, value] of milestones) {
    if (job.logs.some((line) => pattern.test(line))) percent = value
  }
  return { percent, label, detail: job.logs.at(-1) ?? 'Starting...' }
}

const ORGANIZE_CHAOS_MILESTONES: [RegExp, number][] = [
  [/Building target profiles/, 5],
  [/target files with content/, 15],
  [/Embedding device/, 20],
  [/target chunks total/, 35],
  [/Already-imported sources/, 45],
  [/chaos files found/, 55],
  [/new sections to classify/, 65],
  [/^Matched \d+, unsorted \d+ in/, 95],
]

const INDEX_MILESTONES: [RegExp, number][] = [
  [/Files found:/, 20],
  [/Existing chunks in store:/, 30],
  [/^Done\./, 95],
]

/** Single entry point: every job kind's progress, from raw process logs, in one place. */
export function progressFor(job: Job): JobProgress {
  switch (job.kind) {
    case 'outline':
    case 'manuscript':
      return generationProgress(job)
    case 'analysis':
      return analysisProgress(job)
    case 'concepts':
      return conceptsProgress(job)
    case 'organize_chaos':
      return milestoneProgress(job, 'Organizing chaos', 'Organize chaos queued', ORGANIZE_CHAOS_MILESTONES)
    case 'index':
      return milestoneProgress(job, 'Indexing notes', 'Indexing queued', INDEX_MILESTONES)
  }
}
