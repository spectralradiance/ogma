import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { AiConfig, AiEvent, AiRunRequest } from '../shared/ai'
import { type PromptStore, renderTemplate } from './prompts'

export interface SidecarConnection {
  baseUrl: string
  token: string
}

/** Splits a server-sent-events buffer into complete `data:` events and the unfinished rest. */
export function parseSse(buffer: string): { events: AiEvent[]; rest: string } {
  const events: AiEvent[] = []
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    try {
      events.push(JSON.parse(data) as AiEvent)
    } catch {
      // ignore a malformed event rather than failing the run
    }
  }
  return { events, rest }
}

interface BridgeDependencies {
  connection: () => SidecarConnection | null
  prompts: PromptStore
  config: () => AiConfig
  historyDir: string
  send: (runId: string, event: AiEvent) => void
}

/** Runs AI tasks through the sidecar and relays their events to the renderer. */
export class AiBridge {
  private readonly runs = new Map<string, AbortController>()
  private readonly deps: BridgeDependencies

  constructor(deps: BridgeDependencies) {
    this.deps = deps
  }

  async start(request: AiRunRequest): Promise<string> {
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, controller)
    void this.execute(runId, request, controller.signal).finally(() => this.runs.delete(runId))
    return runId
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort()
  }

  private async execute(runId: string, request: AiRunRequest, signal: AbortSignal): Promise<void> {
    const emit = (event: AiEvent) => this.deps.send(runId, event)
    const connection = this.deps.connection()
    if (!connection) {
      emit({ type: 'error', kind: 'unavailable', message: 'The AI server is not running. Check the status bar.' })
      return
    }

    const config = this.deps.config()
    const rendered = renderTemplate(await this.deps.prompts.template(request.task), request.variables)
    const system = rendered.system
    const messages = [...(request.history ?? []), ...(request.continuation ?? rendered.messages)]
    const body = {
      task: request.task === 'test' ? 'default' : request.task,
      system,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      mode: request.mode ?? config.mode,
      profile_id: request.profileId ?? null,
      profile_only: request.profileOnly === true,
      profiles: config.profiles.map(({ id, provider, model, params }) => ({ id, provider, model, params })),
      routing: config.routing,
      tools: request.tools ?? [],
    }

    const record: Record<string, unknown> = {
      at: new Date().toISOString(),
      task: request.task,
      source: request.source ?? null,
      inputSha256: createHash('sha256').update(JSON.stringify({ system, messages })).digest('hex'),
    }
    let output = ''
    try {
      const response = await fetch(`${connection.baseUrl}/ai/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok || !response.body) {
        emit({ type: 'error', kind: 'bad_request', message: `AI server returned ${response.status}: ${await response.text()}` })
        return
      }
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const parsed = parseSse(buffer + decoder.decode(chunk, { stream: true }))
        buffer = parsed.rest
        for (const event of parsed.events) {
          if (event.type === 'text') output += event.text
          if (event.type === 'start') Object.assign(record, { profile: event.profile, provider: event.provider, model: event.model, fallback: event.fallback })
          if (event.type === 'usage') record.usage = { input: event.input_tokens, output: event.output_tokens }
          if (event.type === 'done') record.stopReason = event.stop_reason
          if (event.type === 'error') record.error = `${event.kind}: ${event.message}`
          emit(event)
        }
      }
    } catch (error) {
      if (signal.aborted) {
        record.error = 'cancelled'
        emit({ type: 'error', kind: 'cancelled', message: 'Cancelled.' })
      } else {
        record.error = error instanceof Error ? error.message : String(error)
        emit({ type: 'error', kind: 'unavailable', message: `Lost the AI server: ${record.error}` })
      }
    } finally {
      await this.log({ ...record, output })
    }
  }

  private async log(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.deps.historyDir, { recursive: true })
      const file = path.join(this.deps.historyDir, `${new Date().toISOString().slice(0, 7)}.jsonl`)
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // history is best-effort
    }
  }
}
