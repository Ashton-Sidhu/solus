import type { SavedServer } from '@solus/client-core/server-registry'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'

/**
 * How often the client reads the account's host directory. Nothing pushes it, so a
 * host added on the account site, or a managed host that finishes starting, reaches
 * a running client only on a read. A settling managed host is read for often, so it
 * becomes pickable soon after it is ready; the rest of the time a slow read finds a
 * host added elsewhere. Both run only while the window is active.
 */
export const DIRECTORY_REFRESH_MS = 60_000
export const DIRECTORY_SETTLING_REFRESH_MS = 10_000
/** A window that gets focus reads the directory, unless a read was this recent. */
export const DIRECTORY_FOCUS_GAP_MS = 15_000

/** States a managed host leaves by itself. `stopped` and `failed` wait for a person. */
const SETTLING_STATES: ReadonlySet<ManagedHostLifecycle> = new Set(['provisioning', 'starting', 'stopping', 'deleting'])

export function directoryRefreshDelayMs(servers: readonly SavedServer[]): number {
  const settling = servers.some(
    (server) => server.uplink?.kind === 'managed' && !!server.uplink.managedState && SETTLING_STATES.has(server.uplink.managedState),
  )
  return settling ? DIRECTORY_SETTLING_REFRESH_MS : DIRECTORY_REFRESH_MS
}
