import { cloudHostState } from '../account/lib/host-scope'
import type { HostConnectionPhase, HostConnectionState } from '../hosts/host-connections'
import type { NativeHost } from '../hosts/host-registry'

/**
 * Whether a new task can be written now (docs/plans/draft-connect-host.md). A
 * task no host can run is not a composer: the sheet asks the person to connect
 * a host instead, and keeps the draft's text until one answers.
 */

export type NewTaskHostGate = 'compose' | 'connect'

/**
 * One connected host is enough to compose. The connect screen replaces the
 * composer only on a known answer: a host not yet dialed, or one still dialing,
 * keeps the composer, so a short drop does not take the composer away. The
 * supervisor says `offline` only after its retry ladder gives up.
 */
export function newTaskHostGate(phases: readonly (HostConnectionPhase | null)[]): NewTaskHostGate {
  if (phases.length === 0) return 'connect'
  const isUndecided = phases.some(
    (phase) => phase === null || phase === 'connected' || phase === 'connecting' || phase === 'reconnecting',
  )
  return isUndecided ? 'compose' : 'connect'
}

/** The one thing a host's card does when chosen. */
export type ConnectHostAction = 'retry' | 'start' | 'pair-again'

export const CONNECT_HOST_ACTION_LABELS = {
  retry: 'Retry',
  start: 'Start',
  'pair-again': 'Pair again',
} satisfies Record<ConnectHostAction, string>

/** Null when there is nothing to do but wait: dialing, or a cloud host on its way up. */
export function connectHostAction(host: NativeHost, state: HostConnectionState | null): ConnectHostAction | null {
  if (host.uplink?.kind === 'managed' && cloudHostState(host) === 'stopped') return 'start'
  if (state?.phase === 'blocked') return 'pair-again'
  if (!state || state.phase === 'offline') return 'retry'
  return null
}

/** The headline names the host when there is only one, so the person knows which machine to wake. */
export function connectHostHeadline(hosts: readonly NativeHost[], connectingLabel: string | null): string {
  if (connectingLabel) return `Connecting to ${connectingLabel}`
  if (hosts.length === 0) return 'Connect a host to start'
  if (hosts.length === 1) return `${hosts[0].label} is offline`
  return 'Your hosts are offline'
}
