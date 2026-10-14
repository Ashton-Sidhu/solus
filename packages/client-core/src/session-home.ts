import { solusApiId } from '@solus/contracts/uplink'

/** The connections a session's home is found among. */
export interface SessionHomeConnections {
  connectedServerIds(): string[]
}

/**
 * The host that keeps a session's records: its list state, its pull requests,
 * and its record (docs/plans/session-archive.md). An organization session's
 * home is the organization's Solus API, because the machines that run sessions
 * rotate and go offline; a personal session's home is its machine. Execution
 * (prompt, stop, the live transcript) stays on the machine either way.
 *
 * A client that is not connected to the organization's Solus API reaches the
 * session only through its machine, so the machine stands in.
 */
export function sessionHomeId(
  machineServerId: string,
  organizationId: string | null | undefined,
  connections: SessionHomeConnections,
): string {
  if (!organizationId || organizationId === 'local') return machineServerId
  const serviceId = solusApiId(organizationId)
  return connections.connectedServerIds().includes(serviceId) ? serviceId : machineServerId
}
