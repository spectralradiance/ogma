import type { GpuStatus, TorchStatus } from './ipc'

export function formatMegabytes(megabytes: number): string {
  return `${(megabytes / 1024).toFixed(1)} GB`
}

export function describeGpu(gpu: GpuStatus): string {
  const device = gpu.devices[0]
  if (!device) return gpu.error ? `No GPU (${gpu.error})` : 'No GPU'
  const name = device.name.replace(/^NVIDIA\s+(GeForce\s+)?/, '')
  return `${name} · ${formatMegabytes(device.memory_free_mb)} free of ${formatMegabytes(device.memory_total_mb)}`
}

export function describeTorch(torch: TorchStatus): string {
  if (torch.state === 'pending') return 'PyTorch: checking…'
  if (torch.error) return 'PyTorch: failed to load'
  if (!torch.installed) return 'PyTorch: not installed'
  if (!torch.cuda_available) return `PyTorch ${torch.version} · CPU only`
  return `PyTorch ${torch.version} · CUDA ${torch.cuda_version}`
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}
