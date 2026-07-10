import type { NativeSolusAPI, SolusAPI } from '../preload/index'
import type { SolusServerTarget, LocalConnectionInfoLike } from '@client-core/server-connection'
import type { ConnectionStatus } from '@client-core/ws-transport'

declare global {
  interface Window {
    solus: SolusAPI
    solusNative: NativeSolusAPI
    __solusServerConnection?: {
      local: LocalConnectionInfoLike
      target: SolusServerTarget
      status?: ConnectionStatus
      attempt?: number
    }
  }
}
