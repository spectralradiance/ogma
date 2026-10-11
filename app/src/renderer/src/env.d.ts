import type { OgmaApi } from '../../shared/ipc'

declare global {
  interface Window {
    ogma: OgmaApi
  }
}

export {}
