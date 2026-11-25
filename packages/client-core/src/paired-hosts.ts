import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostPairingHealth, HostPairing, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { type HostRoute, routeForUrl } from '@solus/contracts/host-routes'
import { permissionsAllow } from '@solus/contracts/permissions'
import { lastSeenText } from './host-readiness'

/**
 * The machines a host paired (docs/host-pairing.md): a host added from chat or the
 * CLI. A person's machines reach each other with no step (docs/plans/host-reach.md),
 * so a pairing is read here, never made or removed by hand.
 */

/** A host this device is connected to as its owner, with the pairings it holds. */
export interface PairingHolder {
  label: string
  info: Pick<ConnectionsServerInfo, 'installationId'>
  snapshot: HostPairingsSnapshot | null
  isCurrent(): boolean
}

/** Only the local owner reads a host's pairings. */
export function canReadPairings(info: Pick<ConnectionsServerInfo, 'principal' | 'permissions'>): boolean {
  return info.principal === 'local-owner' && permissionsAllow(info.permissions, 'host.local.reach')
}

/** The route of a pairing: its saved route at the pairing's address, which knows a Tailscale address from another VPN. */
export function pairedHostRoute(pairing: HostPairing): HostRoute | undefined {
  if (!pairing.url) return pairing.listing.routes[0]
  return pairing.listing.routes.find((route) => route.url === pairing.url) ?? routeForUrl(pairing.url)
}

/** Pairs this device with a machine through the first host that holds a pairing for it. */
export async function connectThroughMachine(
  installationId: string,
  sources: readonly { pairAgain(id: string): Promise<boolean> }[],
): Promise<boolean> {
  for (const source of sources) {
    if (await source.pairAgain(installationId)) return true
  }
  return false
}

/* ---------- pairing health (docs/host-pairing.md, "Pairing health") ---------- */

/** A pairing this close to its expiry says so. */
export const PAIRING_EXPIRY_WARNING_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** How one pairing reads to a person, from the health its host sends. `unknown` when the host sends none (an older host). */
export type PairingHealthState =
  | { kind: 'unknown' }
  | { kind: 'working'; expiresInDays: number | null }
  | { kind: 'failing'; detail: string }
  | { kind: 'expired'; detail: string | null }

export function pairingHealthState(health: HostPairingHealth | undefined, now: number): PairingHealthState {
  if (!health) return { kind: 'unknown' }
  if (health.expiresAt === null || health.expiresAt <= now) return { kind: 'expired', detail: health.lastError }
  if (health.lastError !== null) return { kind: 'failing', detail: health.lastError }
  const days = Math.ceil((health.expiresAt - now) / DAY_MS)
  return { kind: 'working', expiresInDays: days <= PAIRING_EXPIRY_WARNING_DAYS ? days : null }
}

/** One word or a few: "Working", "Expires in 3 days", "Failing", "Expired", "Health unknown". */
export function pairingHealthText(state: PairingHealthState): string {
  switch (state.kind) {
    case 'unknown': return 'Health unknown'
    case 'working':
      return state.expiresInDays === null ? 'Working'
        : state.expiresInDays <= 1 ? 'Expires within a day' : `Expires in ${state.expiresInDays} days`
    case 'failing': return 'Failing'
    case 'expired': return 'Expired'
  }
}

/** "Last reached 4 min ago", for the details of a pairing. */
export function lastReachedText(health: HostPairingHealth, now: number): string {
  return `Last reached ${lastSeenText(health.lastReachedAt, now)}`
}
