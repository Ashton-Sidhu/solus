import type { RecordPublication } from '@solus/contracts/types'
import { solusApiId } from '@solus/contracts/uplink'

/** The connections a session's home is found among. */
export interface SessionHomeConnections {
  connectedServerIds(): string[]
}

/**
 * The host that keeps a session's records: its list state, its pull requests,
 * and its record (docs/plans/session-archive.md). A published organization
 * session's home is the organization's Solus API, because the machines that
 * run sessions rotate and go offline. Every other session's home is its
 * machine: a personal session, and an organization session that is not
 * published, which belongs to the organization only for its Insights and never
 * reaches the Solus API. Execution (prompt, stop, the live transcript) stays on
 * the machine either way.
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
  if (!organizationId || organizationId === 'local' || publication !== 'published') return machineServerId
  const serviceId = solusApiId(organizationId)
  return connections.connectedServerIds().includes(serviceId) ? serviceId : machineServerId
}
