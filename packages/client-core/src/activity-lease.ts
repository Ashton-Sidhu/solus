import { serverConnections } from './server-connections'

/**
 * The client half of activity leases (dispatch-client step 7): every
 * connected host hears whether this client is foregrounded, on a heartbeat
 * comfortably inside the host's lease TTL.
 */

const HEARTBEAT_MS = 10_000

let started = false
const failedServerIds = new Set<string>()

export function startActivityLeaseHeartbeat(): void {
  if (started || !('window' in globalThis)) return
  started = true

  const beat = () => {
    const foreground = !('document' in globalThis) || document.visibilityState === 'visible'
    for (const serverId of serverConnections.connectedServerIds()) {
      void serverConnections.apiFor(serverId).activityLease(foreground)
        .then(() => failedServerIds.delete(serverId))
        .catch((error: unknown) => {
          if (failedServerIds.has(serverId)) return
          failedServerIds.add(serverId)
          console.warn('[solus:activity-lease] heartbeat failed', {
            serverId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
  }

  setInterval(beat, HEARTBEAT_MS)
  beat()
}
