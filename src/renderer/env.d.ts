import type { NativeSolusAPI, SolusAPI } from '../preload/index'
import type { IconifyIcon } from '@iconify/types'

declare module 'virtual:solus-icons' {
  const icons: Array<{ name: string; data: IconifyIcon }>
  export default icons
}

declare global {
  interface Window {
    solus: SolusAPI
    solusNative: NativeSolusAPI
  }
}
