import type { SavedServer } from '@client-core/server-registry'
import type { DiscoveredServer } from '../../../shared/types'

export interface DiscoveryFilterInput {
  discovered: DiscoveredServer[]
  savedServers: SavedServer[]
  dismissedInstallationIds: Iterable<string>
  selfInstallationId?: string
}

export function discoveredServerUrl(server: Pick<DiscoveredServer, 'host' | 'port'>): string {
  return `http://${server.host}:${server.port}`
}

export function filterNewDiscoveredServers(input: DiscoveryFilterInput): DiscoveredServer[] {
  const dismissed = new Set(input.dismissedInstallationIds)
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
    if (dismissed.has(server.installationId)) continue
    if (seen.has(server.installationId)) continue
    seen.add(server.installationId)
    out.push(server)
  }
  return out
}
