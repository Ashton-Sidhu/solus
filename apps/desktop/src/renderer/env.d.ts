/// <reference types="vite/client" />

import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { LocalApi } from '@solus/client-core/host-api'
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
