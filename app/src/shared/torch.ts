// Choosing a PyTorch build for the local model.

/** PyTorch wheel indexes offered for installing, newest CUDA last. */
export const CUDA_INDEXES = ['cu126', 'cu128', 'cu130'] as const
export type CudaIndex = (typeof CUDA_INDEXES)[number]

// Oldest Windows driver each CUDA runtime accepts (NVIDIA's CUDA toolkit release notes).
const MIN_DRIVER: Record<CudaIndex, number> = { cu126: 560.76, cu128: 572.16, cu130: 580.88 }

/** The newest wheel index the installed driver can run, or cu126 when the driver is unknown. */
export function suggestCudaIndex(driverVersion: string | null | undefined): CudaIndex {
  const driver = Number.parseFloat(driverVersion ?? '')
  if (!Number.isFinite(driver)) return 'cu126'
  return [...CUDA_INDEXES].reverse().find((index) => driver >= MIN_DRIVER[index]) ?? 'cu126'
}
