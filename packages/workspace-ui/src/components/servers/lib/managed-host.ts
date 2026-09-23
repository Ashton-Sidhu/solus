import { awaitsManagedCompute, type SavedServerUplink } from '@solus/client-core/server-registry'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'

/**
 * How a host row shows a managed host (docs/plans/managed-hosts.md). Its name is
 * the name members gave it (`hostRowLabel`); until the compute is `ready`, the row also
 * says what state it is in. No row names the organization.
 */

const LIFECYCLE_LABELS = {
  provisioning: 'Provisioning',
  starting: 'Starting',
  ready: 'Ready',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
  deleting: 'Deleting',
} satisfies Record<ManagedHostLifecycle, string>

export function isManagedHost(uplink: SavedServerUplink | undefined): boolean {
  return uplink?.kind === 'managed'
}

/** The same question of a resolved host row, which a forgotten host answers with no uplink at all. */
export function hostIsManaged(host: { uplink?: SavedServerUplink } | { unknown: true } | null | undefined): boolean {
  return !!host && 'uplink' in host && isManagedHost(host.uplink)
}

/**
 * A managed host's state while its compute is not ready ("Provisioning", "Stopped"),
 * so a disabled row says why. Null when ready, for a personal host, and for a state
 * this client does not know.
 */
export function managedHostStateLabel(uplink: SavedServerUplink | undefined): string | null {
  const state = uplink?.managedState
  return awaitsManagedCompute(uplink) && state ? LIFECYCLE_LABELS[state] : null
}

/** A managed host takes work only when its compute is ready; it stays listed the rest of the time so its state is visible. */
export function canRunOnHost(uplink: SavedServerUplink | undefined): boolean {
  return !awaitsManagedCompute(uplink)
}
