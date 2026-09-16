import type { SavedServerUplink } from '@solus/client-core/server-registry'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'

/**
 * How a host row names a managed host (docs/plans/managed-hosts.md). A managed host
 * has no owner person, so the line under its name says what it is and, until the
 * compute is `ready`, what state it is in.
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

/**
 * The line under a managed host's name: `Managed · <team>` when the compute is ready,
 * `Managed · <state>` while it is not. Null for a personal host, whose line is its
 * owner's name or nothing. A managed host the directory named no state for is
 * treated as ready: an older control plane simply did not say.
 */
export function managedHostSubtitle(uplink: SavedServerUplink | undefined, organizationName: string | null | undefined): string | null {
  if (!isManagedHost(uplink)) return null
  const state = uplink?.managedState ?? 'ready'
  if (state !== 'ready') return `Managed · ${LIFECYCLE_LABELS[state]}`
  return `Managed · ${organizationName ?? 'Team host'}`
}

/** A managed host takes work only when its compute is ready; it stays listed the rest of the time so its state is visible. */
export function canRunOnHost(uplink: SavedServerUplink | undefined): boolean {
  if (!isManagedHost(uplink)) return true
  return (uplink?.managedState ?? 'ready') === 'ready'
}
