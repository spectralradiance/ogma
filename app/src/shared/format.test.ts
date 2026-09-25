import { describe, expect, it } from 'vitest'

import { describeGpu, describeTorch, folderName } from './format'
import type { TorchStatus } from './ipc'

const torch: TorchStatus = {
  state: 'ready',
  installed: true,
  version: '2.14.0',
  cuda_available: true,
  cuda_version: '12.6',
  error: null,
}

describe('describeGpu', () => {
  it('shortens NVIDIA names and reports free memory', () => {
    const text = describeGpu({
      available: true,
      error: null,
      devices: [{
        index: 0,
        name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
        memory_total_mb: 8188,
        memory_used_mb: 1024,
        memory_free_mb: 7164,
        driver_version: '610.88',
      }],
    })
    expect(text).toBe('RTX 4070 Laptop GPU · 7.0 GB free of 8.0 GB')
  })

  it('explains a missing GPU', () => {
    expect(describeGpu({ available: false, devices: [], error: 'nvidia-smi not found' }))
      .toBe('No GPU (nvidia-smi not found)')
  })
})

describe('describeTorch', () => {
  it('covers each probe outcome', () => {
    expect(describeTorch({ ...torch, state: 'pending' })).toBe('PyTorch: checking…')
    expect(describeTorch({ ...torch, installed: false })).toBe('PyTorch: not installed')
    expect(describeTorch({ ...torch, cuda_available: false })).toBe('PyTorch 2.14.0 · CPU only')
    expect(describeTorch(torch)).toBe('PyTorch 2.14.0 · CUDA 12.6')
  })
})

describe('folderName', () => {
  it('handles Windows and POSIX paths with trailing separators', () => {
    expect(folderName('C:\\Users\\snowb\\notes\\')).toBe('notes')
    expect(folderName('/home/me/writing')).toBe('writing')
  })
})
