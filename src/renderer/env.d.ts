import type { NativeSolusAPI, SolusAPI } from '../preload/index'

declare global {
  interface Window {
    solus: SolusAPI
    solusNative: NativeSolusAPI
  }
}
