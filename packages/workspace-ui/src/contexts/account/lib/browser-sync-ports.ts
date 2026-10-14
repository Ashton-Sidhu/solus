import type {
  DocumentSyncBroadcast,
  DocumentSyncClock,
  DocumentSyncEnvironment,
  DocumentSyncMessage,
  DocumentSyncSignal,
} from '@solus/client-core/document-sync'
import { z } from 'zod'

/** The browser as the sync engines see it: network and visibility, timers, and the other tabs. */

export function browserSyncEnvironment(): DocumentSyncEnvironment {
  return {
    isOnline: () => globalThis.navigator?.onLine !== false,
    isForeground: () => globalThis.document?.visibilityState !== 'hidden',
    subscribe(listener: (signal: DocumentSyncSignal) => void) {
      const online = () => listener('online')
      const offline = () => listener('offline')
      const visibility = () => listener(document.visibilityState === 'hidden' ? 'background' : 'foreground')
      globalThis.window?.addEventListener('online', online)
      globalThis.window?.addEventListener('offline', offline)
      globalThis.document?.addEventListener('visibilitychange', visibility)
      return () => {
        globalThis.window?.removeEventListener('online', online)
        globalThis.window?.removeEventListener('offline', offline)
        globalThis.document?.removeEventListener('visibilitychange', visibility)
      }
    },
  }
}

export const browserSyncClock: DocumentSyncClock = {
  now: () => Date.now(),
  setTimer(callback, ms) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * Tabs of one browser profile share a sync record; this tells the others it
 * changed. One channel per synced document. Absent without BroadcastChannel.
 */
const syncMessageSchema = z.object({ accountKey: z.string() })

export function browserSyncBroadcast(channelName: string): DocumentSyncBroadcast | undefined {
  if (!('BroadcastChannel' in globalThis)) return undefined
  const channel = new BroadcastChannel(channelName)
  return {
    post: (message: DocumentSyncMessage) => channel.postMessage(message),
    subscribe(listener) {
      const receive = (event: MessageEvent) => {
        const message = syncMessageSchema.safeParse(event.data)
        if (message.success) listener(message.data)
      }
      channel.addEventListener('message', receive)
      return () => channel.removeEventListener('message', receive)
    },
  }
}
