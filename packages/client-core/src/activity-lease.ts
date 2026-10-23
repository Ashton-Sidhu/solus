import { serverConnections } from './server-connections'

/**
 * The client half of activity leases (dispatch-client step 7): every
 * connected host hears whether this client is foregrounded, on a heartbeat
 * comfortably inside the host's lease TTL.
 */

const HEARTBEAT_MS = 10_000

let started = false

export function startActivityLeaseHeartbeat(): void {
  if (started || !('window' in globalThis)) return
  started = true

  const beat = () => {
    const foreground = !('document' in globalThis) || document.visibilityState === 'visible'
    for (const serverId of serverConnections.connectedServerIds()) {
      // Best effort: an older host does not know the method, and a host that
      // is reconnecting misses a beat. The next beat reports again.
      void serverConnections.apiFor(serverId).activityLease(foreground).catch(() => {})
    }
  }

  setInterval(beat, HEARTBEAT_MS)
  beat()
}
