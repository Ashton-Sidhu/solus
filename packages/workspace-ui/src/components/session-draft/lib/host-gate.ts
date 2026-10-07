import { RECONNECT_ESCALATE_MS } from '@solus/client-core/connection-display'
import { awaitsManagedCompute, managedHostNeedsStart } from '@solus/client-core/server-registry'
import type { ServerItem } from '../../../contexts/connections/servers.store.svelte'
import { relativeTime } from '../../../lib/relative-time'
import { managedHostStateLabel } from '../../servers/lib/managed-host'

/**
 * Whether a draft can be written now (docs/plans/draft-connect-host.md). A
 * draft that no host can run is not a composer: the pane asks the person to
 * connect a host instead, and keeps the draft's text until one answers.
 */

export interface GatedHost extends ServerItem {
  /** When the host last stopped being connected; null while up or before it was dialed. */
  offlineSince: number | null
}

export type DraftHostGate = 'compose' | 'connect'

/**
 * One host online is enough to compose. The page replaces the composer only on
 * a known answer: a host still dialing within the reconnect grace, or one never
 * checked, keeps the composer, so a short drop or a slow first connect does not
 * swap the page out from under the person typing.
 */
export function draftHostGate(hosts: readonly GatedHost[], now: number): DraftHostGate {
  if (hosts.some((host) => host.status === 'online')) return 'compose'
  const isUndecided = hosts.some(
    (host) =>
      host.status === 'saved' ||
      (host.status === 'connecting' &&
        (host.offlineSince === null || now - host.offlineSince < RECONNECT_ESCALATE_MS)),
  )
  return isUndecided ? 'compose' : 'connect'
}

/** The one thing a host's card does when chosen; null when there is nothing to do but wait. */
export type ConnectHostAction = 'retry' | 'start' | 'pair-again'

export interface ConnectHostRow {
  hostId: string
  label: string
  detail: string
  action: ConnectHostAction | null
}

export const CONNECT_HOST_ACTION_LABELS = {
  retry: 'Retry',
  start: 'Start',
  'pair-again': 'Pair again',
} satisfies Record<ConnectHostAction, string>

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
  if (host.status === 'connecting') return { ...row, detail: 'Connecting', action: null }
  if (host.status === 'different-server') {
    return { ...row, detail: 'Different server than expected', action: 'pair-again' }
  }
  return {
    ...row,
    detail: host.offlineSince === null ? 'Offline' : `Offline · last seen ${relativeTime(host.offlineSince, now)}`,
    action: 'retry',
  }
}

/** The headline names the host when there is only one, so the person knows which machine to wake. */
export function connectHostHeadline(hosts: readonly GatedHost[], connectingLabel: string | null): string {
  if (connectingLabel) return `Connecting to ${connectingLabel}`
  if (hosts.length === 0) return 'Connect a host to start'
  if (hosts.length === 1) return `${hosts[0].label} is offline`
  return 'Your hosts are offline'
}
