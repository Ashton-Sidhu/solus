import type { SolusAPI } from '../preload/index'

declare global {
  interface Window {
    solus: SolusAPI
  }
}

