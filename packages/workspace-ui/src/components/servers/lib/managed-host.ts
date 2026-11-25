import { awaitsManagedCompute, type KnownHostUplink } from '@solus/client-core/known-host'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'

/**
 * How a host row shows a cloud machine (docs/plans/managed-hosts.md). Its name is
 * the name members gave it (`hostRowLabel`). When Solus Cloud operates its compute,
 * the row also says what state the compute is in until it is `ready`. No row names
 * the organization.
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

/** A cloud machine of an organization: its mark is the cloud, whatever it runs on. */
export function isCloudHost(uplink: KnownHostUplink | undefined): boolean {
  return uplink?.kind === 'cloud'
}

/** The same question of a resolved host row, which a forgotten host answers with no uplink at all. */
export function hostIsCloud(host: { uplink?: KnownHostUplink } | { unknown: true } | null | undefined): boolean {
  return !!host && 'uplink' in host && isCloudHost(host.uplink)
}

/**
 * Solus Cloud operates this cloud machine's compute, so a member can start, stop,
 * restart, and delete it from here. A cloud machine that its operator runs has no
 * such lifecycle: it is dialed like any other host.
 */
export function hostHasManagedCompute(host: { uplink?: KnownHostUplink } | { unknown: true } | null | undefined): boolean {
  return !!host && 'uplink' in host && host.uplink?.hasManagedCompute === true
}

/**
 * The state of managed compute that is not ready ("Provisioning", "Stopped"), so a
 * disabled row says why. Null when ready, for a host with no managed compute, and
 * for a state this client does not know.
 */
export function managedHostStateLabel(uplink: KnownHostUplink | undefined): string | null {
  const state = uplink?.managedState
  return awaitsManagedCompute(uplink) && state ? LIFECYCLE_LABELS[state] : null
}

/** A machine with managed compute takes work only when the compute is ready; it stays listed the rest of the time so its state is visible. */
export function canRunOnHost(uplink: KnownHostUplink | undefined): boolean {
  return !awaitsManagedCompute(uplink)
}
