/// <reference types="vite/client" />

import type { NativeSolusAPI } from '../preload/index'
import type { LocalApi } from '../client-core/host-api'
import type { IconifyIcon } from '@iconify/types'

declare module 'virtual:solus-icons' {
  const icons: Array<{ name: string; data: IconifyIcon }>
  export default icons
}

declare global {
  interface Window {
    solus: LocalApi
    solusNative: NativeSolusAPI
  }
}
