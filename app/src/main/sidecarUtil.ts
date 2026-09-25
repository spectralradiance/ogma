import { join, resolve } from 'node:path'

import { CUDA_INDEXES } from '../shared/torch'

export interface SidecarPaths {
  sidecarDir: string
  python: string
}

/**
 * In development the app lives in `oisin/app`, so the sidecar is its sibling.
 * OISIN_SIDECAR_DIR and OISIN_PYTHON override either location.
 */
export function resolveSidecarPaths(
  appPath: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SidecarPaths {
  const sidecarDir = env.OISIN_SIDECAR_DIR ?? resolve(appPath, '..', 'sidecar')
  const venvPython = platform === 'win32'
    ? join(sidecarDir, '.venv', 'Scripts', 'python.exe')
    : join(sidecarDir, '.venv', 'bin', 'python')
  return { sidecarDir, python: env.OISIN_PYTHON ?? venvPython }
}

export function restartDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000)
}

/** Keeps the most recent lines of sidecar output for the details panel. */
export class LogRing {
  private readonly lines: string[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  add(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity)
  }

  snapshot(): string[] {
    return [...this.lines]
  }
}

/** Turns a stream of text chunks into whole lines. Each stream needs its own splitter. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let partial = ''
  return (chunk) => {
    const parts = (partial + chunk).split(/\r?\n/)
    partial = parts.pop() ?? ''
    for (const line of parts) {
      if (line) onLine(line)
    }
  }
}

/** The pip commands (arguments after the venv's python) that install PyTorch and the local-model libraries. */
export function torchInstallCommands(sidecarDir: string, index: string): string[][] {
  if (!(CUDA_INDEXES as readonly string[]).includes(index)) throw new Error(`Unknown PyTorch index "${index}".`)
  return [
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off', 'torch', '--index-url', `https://download.pytorch.org/whl/${index}`],
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off', '-r', join(sidecarDir, 'requirements-local.txt')],
  ]
}
