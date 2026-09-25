import { describe, expect, it } from 'vitest'

import { LogRing, lineSplitter, resolveSidecarPaths, restartDelayMs, torchInstallCommands } from './sidecarUtil'
import { suggestCudaIndex } from '../shared/torch'

describe('resolveSidecarPaths', () => {
  it('uses the sibling sidecar venv on Windows', () => {
    const paths = resolveSidecarPaths('C:\\code\\oisin\\app', {}, 'win32')
    expect(paths.sidecarDir.replaceAll('\\', '/')).toMatch(/oisin\/sidecar$/)
    expect(paths.python.replaceAll('\\', '/')).toMatch(/sidecar\/\.venv\/Scripts\/python\.exe$/)
  })

  it('uses bin/python elsewhere', () => {
    const paths = resolveSidecarPaths('/code/oisin/app', {}, 'linux')
    expect(paths.python.replaceAll('\\', '/')).toMatch(/sidecar\/\.venv\/bin\/python$/)
  })

  it('honours environment overrides', () => {
    const paths = resolveSidecarPaths('/x', { OISIN_SIDECAR_DIR: '/s', OISIN_PYTHON: '/py' }, 'linux')
    expect(paths).toEqual({ sidecarDir: '/s', python: '/py' })
  })
})

describe('restartDelayMs', () => {
  it('backs off exponentially with a ceiling', () => {
    expect([0, 1, 2, 3].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000])
    expect(restartDelayMs(10)).toBe(15_000)
  })
})

describe('LogRing', () => {
  it('keeps only the newest lines', () => {
    const ring = new LogRing(2)
    ring.add('a')
    ring.add('b')
    ring.add('c')
    expect(ring.snapshot()).toEqual(['b', 'c'])
  })
})

describe('lineSplitter', () => {
  it('joins lines split across chunks and drops blank lines', () => {
    const lines: string[] = []
    const push = lineSplitter((line) => lines.push(line))
    push('INFO: star')
    push('ted\r\n\r\nsecond')
    push(' line\n')
    expect(lines).toEqual(['INFO: started', 'second line'])
  })
})

describe('suggestCudaIndex', () => {
  it('picks the newest index the driver supports', () => {
    expect(suggestCudaIndex('581.15')).toBe('cu130')
    expect(suggestCudaIndex('576.02')).toBe('cu128')
    expect(suggestCudaIndex('561.09')).toBe('cu126')
    expect(suggestCudaIndex('531.2')).toBe('cu126')
    expect(suggestCudaIndex(undefined)).toBe('cu126')
  })
})

describe('torchInstallCommands', () => {
  it('installs torch from the chosen index, then the local-model libraries', () => {
    const [torch, local] = torchInstallCommands('C:\\oisin\\sidecar', 'cu128')
    expect(torch.slice(-3)).toEqual(['torch', '--index-url', 'https://download.pytorch.org/whl/cu128'])
    expect(local.at(-1)).toMatch(/requirements-local\.txt$/)
    expect(() => torchInstallCommands('x', 'cu999; rm -rf')).toThrow(/Unknown/)
  })
})
