import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Readable } from 'node:stream'

import type { SidecarHealth, SidecarStatus } from '../shared/ipc'
import { LogRing, lineSplitter, restartDelayMs, type SidecarPaths, torchInstallCommands } from './sidecarUtil'

const STARTUP_TIMEOUT_MS = 90_000
const STARTUP_POLL_MS = 300
const HEALTH_POLL_MS = 10_000
/** While the sidecar is still probing PyTorch, so the answer shows up promptly. */
const HEALTH_POLL_PENDING_MS = 1_000
const HEALTH_TIMEOUT_MS = 15_000
const MAX_FAILED_POLLS = 3
const MAX_RESTARTS = 3
const STOP_GRACE_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Child = ChildProcessByStdio<null, Readable, Readable>

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port assigned'))))
    })
  })
}

/**
 * Owns the Python AI sidecar process: launches it on a free loopback port with a
 * per-launch bearer token, waits for /health, polls it, and restarts it with
 * backoff when it dies. The sidecar is given this process's id and exits when it
 * is gone, so it cannot outlive the app even if the app crashes.
 */
export class SidecarManager extends EventEmitter<{ status: [SidecarStatus] }> {
  private child: Child | null = null
  private installer: Child | null = null
  private baseUrl = ''
  private token = ''
  private generation = 0
  private stopping = false
  private restarts = 0
  private failedPolls = 0
  private pollTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private readonly logs = new LogRing(400)
  private status: SidecarStatus = { state: 'stopped', health: null, error: null, restarts: 0 }

  private readonly paths: SidecarPaths
  private readonly extraEnv: () => Record<string, string>

  /** `extraEnv` supplies stored API keys and provider settings at every launch. */
  constructor(paths: SidecarPaths, extraEnv: () => Record<string, string> = () => ({})) {
    super()
    this.paths = paths
    this.extraEnv = extraEnv
  }

  /** Where to reach the sidecar while it is online. */
  connection(): { baseUrl: string; token: string } | null {
    return this.status.state === 'online' ? { baseUrl: this.baseUrl, token: this.token } : null
  }

  getStatus(): SidecarStatus {
    return this.status
  }

  getLogs(): string[] {
    return this.logs.snapshot()
  }

  async start(): Promise<void> {
    if (this.child || this.installer) return
    this.stopping = false
    this.clearTimers()
    const generation = ++this.generation

    if (!existsSync(this.paths.python)) {
      this.setStatus({
        state: 'error',
        health: null,
        error: `Python environment not found at ${this.paths.python}. Run scripts/setup-sidecar.ps1.`,
      })
      return
    }

    const port = await freePort()
    if (generation !== this.generation) return
    this.token = randomBytes(32).toString('hex')
    this.baseUrl = `http://127.0.0.1:${port}`
    this.setStatus({ state: 'starting', health: null, error: this.status.error })
    this.logs.add(`[oisin] starting sidecar on port ${port}`)

    const child = spawn(
      this.paths.python,
      ['-m', 'oisin_ai', '--host', '127.0.0.1', '--port', String(port), '--parent-pid', String(process.pid)],
      {
        cwd: this.paths.sidecarDir,
        env: { ...process.env, ...this.extraEnv(), OISIN_SIDECAR_TOKEN: this.token, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', lineSplitter((line) => this.logs.add(line)))
    child.stderr.on('data', lineSplitter((line) => this.logs.add(line)))

    let gone = false
    const onGone = (reason: string): void => {
      if (gone) return
      gone = true
      this.handleExit(generation, reason)
    }
    child.once('error', (error) => onGone(`failed to start: ${error.message}`))
    child.once('exit', (code, signal) => onGone(`exited with ${signal ?? `code ${code}`}`))

    const health = await this.waitForStartup(generation)
    if (!health || generation !== this.generation) return
    this.restarts = 0
    this.failedPolls = 0
    this.setStatus({ state: 'online', health, error: null })
    this.schedulePoll(generation)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    this.killTree(this.installer?.pid)
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.setStatus({ state: 'stopped', health: null, error: null })
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // Ask it to exit; a server that does not answer is killed after the grace period.
    void fetch(`${this.baseUrl}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(STOP_GRACE_MS),
    }).catch(() => {})
    const graceful = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)])
    if (!graceful) {
      this.killChild()
      await Promise.race([exited, delay(STOP_GRACE_MS)])
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    this.restarts = 0
    await this.start()
  }

  /**
   * Stops the server, installs PyTorch (from the given CUDA wheel index) and the
   * local-model libraries into its environment, then starts it again. Output
   * goes to the server log. Rejects if an install step fails; the server is
   * restarted either way.
   */
  async installTorch(index: string): Promise<void> {
    if (this.installer) throw new Error('PyTorch is already being installed.')
    const commands = torchInstallCommands(this.paths.sidecarDir, index)
    if (!existsSync(this.paths.python)) throw new Error(`Python environment not found at ${this.paths.python}. Run scripts/setup-sidecar.ps1.`)
    await this.stop()
    this.setStatus({ state: 'installing', health: null, error: null })
    let failure: Error | null = null
    for (const args of commands) {
      this.logs.add(`[oisin] python ${args.join(' ')}`)
      const result = await this.runInstallStep(args)
      if (result !== 0) {
        failure = new Error(`Installing PyTorch failed (${result}). The log has pip's output.`)
        break
      }
    }
    this.logs.add(failure ? `[oisin] ${failure.message}` : '[oisin] PyTorch installed')
    if (this.stopping && this.status.state !== 'installing') return // the app is quitting
    this.restarts = 0
    await this.start()
    if (failure) throw failure
  }

  private runInstallStep(args: string[]): Promise<number | string> {
    return new Promise((resolve) => {
      const child = spawn(this.paths.python, args, {
        cwd: this.paths.sidecarDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.installer = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', lineSplitter((line) => this.logs.add(line)))
      child.stderr.on('data', lineSplitter((line) => this.logs.add(line)))
      const finish = (result: number | string) => {
        this.installer = null
        resolve(result)
      }
      child.once('error', (error) => finish(error.message))
      child.once('exit', (code, signal) => finish(code ?? `killed by ${signal}`))
    })
  }

  private async waitForStartup(generation: number): Promise<SidecarHealth | null> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (generation !== this.generation || !this.child) return null
      try {
        return await this.fetchHealth()
      } catch {
        await delay(STARTUP_POLL_MS)
      }
    }
    this.logs.add('[oisin] sidecar did not answer /health in time')
    this.killChild()
    return null
  }

  private async fetchHealth(): Promise<SidecarHealth> {
    const response = await fetch(`${this.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`/health returned ${response.status}`)
    return (await response.json()) as SidecarHealth
  }

  private schedulePoll(generation: number): void {
    const pending = this.status.health?.torch.state === 'pending'
    this.pollTimer = setTimeout(() => void this.poll(generation), pending ? HEALTH_POLL_PENDING_MS : HEALTH_POLL_MS)
  }

  private async poll(generation: number): Promise<void> {
    try {
      const health = await this.fetchHealth()
      if (generation !== this.generation) return
      this.failedPolls = 0
      this.setStatus({ state: 'online', health, error: null })
    } catch (error) {
      if (generation !== this.generation) return
      this.failedPolls += 1
      this.logs.add(`[oisin] health check failed (${this.failedPolls}/${MAX_FAILED_POLLS}): ${errorMessage(error)}`)
      if (this.failedPolls >= MAX_FAILED_POLLS) {
        this.killChild() // the exit handler restarts it
        return
      }
    }
    if (generation === this.generation && this.child) this.schedulePoll(generation)
  }

  private handleExit(generation: number, reason: string): void {
    if (generation !== this.generation) return
    this.child = null
    this.clearTimers()
    this.logs.add(`[oisin] sidecar ${reason}`)

    if (this.stopping) {
      this.setStatus({ state: 'stopped', health: null, error: null })
      return
    }
    if (this.restarts >= MAX_RESTARTS) {
      this.setStatus({ state: 'error', health: null, error: `AI server ${reason}. Check the logs, then restart it.` })
      return
    }
    const wait = restartDelayMs(this.restarts)
    this.restarts += 1
    this.setStatus({
      state: 'starting',
      health: null,
      error: `AI server ${reason}; restarting (attempt ${this.restarts} of ${MAX_RESTARTS})`,
    })
    this.restartTimer = setTimeout(() => void this.start(), wait)
  }

  private killChild(): void {
    this.killTree(this.child?.pid)
  }

  private killTree(pid: number | undefined): void {
    if (!pid) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      process.kill(pid, 'SIGKILL')
    }
  }

  private clearTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.pollTimer = null
    this.restartTimer = null
  }

  private setStatus(next: Omit<SidecarStatus, 'restarts'>): void {
    this.status = { ...next, restarts: this.restarts }
    this.emit('status', this.status)
  }
}
