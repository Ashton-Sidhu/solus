import { serverConnections } from './server-connections'
import { loadServers, type SavedServer } from './server-registry'

/**
 * The saved server a cloud record's runner host id names, connected or not; null
 * when this client keeps none. A record kept by the workspace service names its
 * runner by its account host id (`uplink.hostId`), not by the id this client gave
 * the server, so every surface that moves from a record to the live session goes
 * through here.
 */
export function savedRunnerFor(
  runnerHostId: string,
  saved: readonly Pick<SavedServer, 'id' | 'uplink'>[] = loadServers(),
): string | null {
  return saved.find((server) => server.uplink?.hostId === runnerHostId)?.id ?? null
}

/** The saved runner (`savedRunnerFor`) when this client is connected to it; null otherwise. */
export function connectedRunnerFor(
  runnerHostId: string,
  saved: readonly Pick<SavedServer, 'id' | 'uplink'>[] = loadServers(),
  statusFor: (serverId: string) => string = (serverId) => serverConnections.statusFor(serverId),
): string | null {
  const runnerId = savedRunnerFor(runnerHostId, saved)
  return runnerId && statusFor(runnerId) === 'connected' ? runnerId : null
}
