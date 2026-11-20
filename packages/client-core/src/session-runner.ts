import type { HostReadiness } from './host-readiness'
import { serverConnections } from './server-connections'
import { hostCatalog } from './host-catalog'
import type { KnownHost } from './known-host'

/**
 * The known host a cloud record's runner host id names, connected or not; null
 * when this client knows none. A record kept by the workspace service names its
 * runner by its account host id (`uplink.hostId`), not by the id this client gave
 * the server, so every surface that moves from a record to the live session goes
 * through here.
 */
export function knownRunnerFor(
  runnerHostId: string,
  known: readonly Pick<KnownHost, 'id' | 'uplink'>[] = hostCatalog.hosts(),
): string | null {
  return known.find((host) => host.uplink?.hostId === runnerHostId)?.id ?? null
}

/** The known runner (`knownRunnerFor`) when it is ready on this client; null otherwise. */
export function connectedRunnerFor(
  runnerHostId: string,
  known: readonly Pick<KnownHost, 'id' | 'uplink'>[] = hostCatalog.hosts(),
  readinessFor: (serverId: string) => HostReadiness = (serverId) => serverConnections.readinessFor(serverId).readiness,
): string | null {
  const runnerId = knownRunnerFor(runnerHostId, known)
  return runnerId && readinessFor(runnerId) === 'ready' ? runnerId : null
}
