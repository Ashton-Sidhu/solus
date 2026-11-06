import type { RecordPublication } from '@solus/contracts/types'
import { solusApiId } from '@solus/contracts/uplink'

/** The connections a session's home is found among. */
export interface SessionHomeConnections {
  connectedServerIds(): string[]
  /** A machine provisioned for an organization, whose sessions the Solus API keeps. Absent: every machine is personal. */
  isManagedHost?(serverId: string): boolean
}

/**
 * The host that keeps a session's records: its list state, its pull requests,
 * and its record (docs/plans/session-archive.md). A published organization
 * session on a managed machine has the organization's Solus API as its home,
 * because managed machines rotate and go offline. Every other session's home is
 * its machine: a session on a personal machine is its owner's, published or not
 * (plans/031 rule 1), and so is its list state. Execution (prompt, stop, the live
 * transcript) stays on the machine either way.
 *
 * A client that is not connected to the organization's Solus API reaches the
 * session only through its machine, so the machine stands in.
 */
export function sessionHomeId(
  machineServerId: string,
  session: { organizationId?: string | null; publication?: RecordPublication },
  connections: SessionHomeConnections,
): string {
  const { organizationId, publication } = session
  if (!organizationId || organizationId === 'local' || publication !== 'published' || !connections.isManagedHost?.(machineServerId)) return machineServerId
  const serviceId = solusApiId(organizationId)
  return connections.connectedServerIds().includes(serviceId) ? serviceId : machineServerId
}
