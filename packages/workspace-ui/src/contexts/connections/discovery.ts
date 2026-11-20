import type { KnownHost } from '@solus/client-core/known-host'
import type { DiscoveredServer } from '@solus/contracts/types'

export interface DiscoveryFilterInput {
  discovered: DiscoveredServer[]
  knownHosts: readonly Pick<KnownHost, 'id' | 'installationId'>[]
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

export function filterUnsavedDiscoveredServers(input: DiscoveryFilterInput): DiscoveredServer[] {
  const registered = new Set<string>()
  for (const server of input.knownHosts) {
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

export function compareNearbyHosts(a: NearbyHost, b: NearbyHost): number {
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
