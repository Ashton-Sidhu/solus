import type { MetricsTurnHost } from '@solus/contracts/observability-types'
import { shortId } from './format'

// The host a turn ran on (docs/plans/insights-across-hosts.md). A host reads its
// own turns and the turns its owner ran elsewhere, pulled from the workspace
// service. A pulled turn names its host by the workspace service's id; this
// client knows that id for every host the account directory lists.

/** A host as this client saved it: its own id, and its id at the workspace service. */
export interface KnownHost {
  id: string
  label: string
  uplink?: { hostId: string }
}

/**
 * What the Host column calls a turn's host: the host being read for its own
 * turns, a directory host by the name the user knows it by, then the machine
 * name the turn recorded, then a short id.
 */
export function turnHostLabel(
  turn: { hostId: string | null; hostname: string | null },
  hosts: readonly KnownHost[],
  readHostId: string | null,
): string {
  if (turn.hostId === null) {
    return hosts.find((host) => host.id === readHostId)?.label ?? turn.hostname ?? 'This host'
  }
  return hosts.find((host) => host.uplink?.hostId === turn.hostId)?.label ?? turn.hostname ?? shortId(turn.hostId)
}

/** The connected host a pulled turn ran on, so its diff can be read there. */
export function turnHostServerId(hostId: string, hosts: readonly KnownHost[]): string | null {
  return hosts.find((host) => host.uplink?.hostId === hostId)?.id ?? null
}

/** One choice of the Host filter. `value` is the menu's key; `hostId` is the filter. */
export interface TurnHostChoice {
  value: string
  hostId: string | null | undefined
  label: string
  count: number | null
}

const ALL_HOSTS = 'all'
const valueOf = (hostId: string | null): string => hostId === null ? 'this' : `host:${hostId}`

/** Every host first, then each host with turns in the window, busiest first. */
export function turnHostChoices(
  hosts: readonly MetricsTurnHost[],
  label: (host: MetricsTurnHost) => string,
): TurnHostChoice[] {
  return [
    { value: ALL_HOSTS, hostId: undefined, label: 'All hosts', count: null },
    ...hosts.map((host) => ({ value: valueOf(host.hostId), hostId: host.hostId, label: label(host), count: host.count })),
  ]
}

/** The menu key of the host filter in force. */
export function turnHostValue(hostId: string | null | undefined): string {
  return hostId === undefined ? ALL_HOSTS : valueOf(hostId)
}
