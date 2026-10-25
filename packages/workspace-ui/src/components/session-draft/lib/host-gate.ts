import {
  hostReadinessCopy,
  isWaitingForHost,
  lastSeenText,
  type HostReadinessAction,
  type HostReadinessState,
} from '@solus/client-core/host-readiness'
import { awaitsManagedCompute, managedHostNeedsStart } from '@solus/client-core/server-registry'
import type { ServerItem } from '../../../contexts/connections/servers.store.svelte'
import { managedHostStateLabel } from '../../servers/lib/managed-host'

/**
 * Whether a draft can be written now (docs/plans/draft-connect-host.md). A
 * draft that no host can run is not a composer: the pane asks the person to
 * connect a host instead, and keeps the draft's text until one answers.
 */

export interface GatedHost extends ServerItem {
  /** The host's readiness with its reason and last-seen time (docs/plans/host-readiness.md). */
  state: HostReadinessState
  /** The host is still making this person's Linux user and folders (docs/plans/member-isolation.md §8.1). */
  isPreparing: boolean
}

/** A host that can run the draft now: ready, and done setting this person up. */
function isUsable(host: GatedHost): boolean {
  return host.readiness === 'ready' && !host.isPreparing
}

/**
 * No host can run the draft yet, but one is setting this person's workspace up:
 * the page says so instead of asking for a host. It names no host.
 */
export function isSettingUpWorkspace(hosts: readonly GatedHost[]): boolean {
  return !hosts.some(isUsable) && hosts.some((host) => host.readiness === 'ready' && host.isPreparing)
}

export type DraftHostGate = 'compose' | 'connect'

/**
 * One ready host is enough to compose. The page replaces the composer only on
 * a known answer: a host still `checking` or `reconnecting` keeps the composer,
 * so a short drop or a slow first connect does not swap the page out from
 * under the person typing. Once the page shows, only a host that answers
 * brings the composer back: a Retry dials again, and that dial must not show
 * the composer until it is answered.
 */
export function draftHostGate(hosts: readonly GatedHost[], previous: DraftHostGate): DraftHostGate {
  if (hosts.some(isUsable)) return 'compose'
  if (previous === 'connect' || isSettingUpWorkspace(hosts)) return 'connect'
  return hosts.some((host) => isWaitingForHost(host.readiness)) ? 'compose' : 'connect'
}

export interface ConnectHostRow {
  hostId: string
  label: string
  detail: string
  action: HostReadinessAction | null
}

export function connectHostRow(host: GatedHost, now: number): ConnectHostRow {
  const row = { hostId: host.id, label: host.label }
  if (awaitsManagedCompute(host.uplink)) {
    const state = managedHostStateLabel(host.uplink)
    return {
      ...row,
      detail: state ? `Cloud host · ${state.toLowerCase()}` : 'Cloud host',
      action: managedHostNeedsStart(host.uplink?.managedState) ? 'start' : null,
    }
  }
  const copy = hostReadinessCopy(host.state, host.label, now)
  if (isWaitingForHost(host.readiness)) return { ...row, detail: `${copy.label}…`, action: null }
  const lastSeenAt = host.state.lastSeenAt
  const detail = host.state.unreachableReason === 'no-answer' && lastSeenAt !== null
    ? `${copy.label} · last seen ${lastSeenText(lastSeenAt, now)}`
    : copy.label
  return { ...row, detail, action: copy.action }
}

/** The headline names the host when there is only one, so the person knows which machine to wake. */
export function connectHostHeadline(hosts: readonly GatedHost[], connectingLabel: string | null): string {
  if (isSettingUpWorkspace(hosts)) return 'Setting up your workspace for the first time'
  if (connectingLabel) return `Connecting to ${connectingLabel}`
  if (hosts.length === 0) return 'Connect a host to start'
  if (hosts.length === 1) return `${hosts[0].label} is offline`
  return 'Your hosts are offline'
}
