import type { OisinApi } from '../../shared/ipc'

declare global {
  interface Window {
    oisin: OisinApi
  }
}

export {}
