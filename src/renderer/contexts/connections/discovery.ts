import type { SavedServer } from '@client-core/server-registry'
import type { DiscoveredServer } from '../../../shared/types'

export interface DiscoveryFilterInput {
  discovered: DiscoveredServer[]
  savedServers: SavedServer[]
  selfInstallationId?: string
}

export interface NearbyHost {
  server: DiscoveredServer
  lastSeenAt: number
}

export const NEARBY_HOST_TTL_MS = 90_000

export function discoveredServerUrl(server: Pick<DiscoveredServer, 'host' | 'port'>): string {
  return `http://${server.host}:${server.port}`
}

export function unannouncedDiscoveredServers(
  discovered: DiscoveredServer[],
  announcedInstallationIds: ReadonlySet<string>,
): DiscoveredServer[] {
  return discovered.filter((server) => !announcedInstallationIds.has(server.installationId))
}

export function filterUnsavedDiscoveredServers(input: DiscoveryFilterInput): DiscoveredServer[] {
  const registered = new Set<string>()
  for (const server of input.savedServers) {
    if (server.installationId) registered.add(server.installationId)
    registered.add(server.id)
  }

  const out: DiscoveredServer[] = []
  const seen = new Set<string>()
  for (const server of input.discovered) {
    if (!server.installationId) continue
    if (server.installationId === input.selfInstallationId) continue
    if (registered.has(server.installationId)) continue
    if (seen.has(server.installationId)) continue
    seen.add(server.installationId)
    out.push(server)
  }
  return out
}

/** Claimable hosts first — they are the one-click case — then alphabetical. */
export function compareNearbyHosts(a: NearbyHost, b: NearbyHost): number {
  if (a.server.claimable !== b.server.claimable) return a.server.claimable ? -1 : 1
  return a.server.name.localeCompare(b.server.name)
}

/** Merges a scan into the known set, refreshing lastSeenAt and evicting stale hosts. */
export function mergeNearbyHosts(
  known: ReadonlyMap<string, NearbyHost>,
  scanned: DiscoveredServer[],
  now: number,
): NearbyHost[] {
  const merged = new Map<string, NearbyHost>()
  for (const [installationId, nearbyHost] of known) {
    if (now - nearbyHost.lastSeenAt < NEARBY_HOST_TTL_MS) {
      merged.set(installationId, nearbyHost)
    }
  }
  for (const server of scanned) {
    merged.set(server.installationId, { server, lastSeenAt: now })
  }
  return [...merged.values()].sort(compareNearbyHosts)
}
