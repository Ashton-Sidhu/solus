import type { RecordPublication } from '@solus/contracts/types'
import { solusApiId } from '@solus/contracts/uplink'

/** The connections a session's home is found among. */
export interface SessionHomeConnections {
  serverIds(): string[]
  /** A machine provisioned for an organization, whose sessions the Solus API keeps. Absent: every machine is personal. */
  isCloudHost?(serverId: string): boolean
  /**
   * Whether the organization saves the conversations of its sessions in Solus
   * Cloud: its policy limit `sessionCloudSync`, as the directory gives it
   * (`DirectoryWorkspace.sessionCloudSync`). Absent: it does.
   */
  savesSessionsToCloud?(organizationId: string): boolean
}

/**
 * Where the sessions of an organization are read from (docs/session-cloud-copy.md).
 * The first question is the setting, the second is the kind of the machine:
 *
 * | The organization saves sessions to Solus Cloud | The session ran on | Source |
 * | --- | --- | --- |
 * | no | any machine | the machine |
 * | yes | a personal machine | the machine |
 * | yes | a cloud machine | the organization's Solus API |
 *
 * `false` here means the first row: no conversation of these sessions is in
 * Solus Cloud, so the Solus API is not a source of them and each machine
 * answers for its own.
 */
export function readsSessionsFromSolusApi(organizationId: string, connections: Pick<SessionHomeConnections, 'savesSessionsToCloud'>): boolean {
  return connections.savesSessionsToCloud?.(organizationId) !== false
}

/**
 * Whether a machine is asked for its own sessions, in a list or a search. A
 * personal machine always is. A cloud machine is asked only when the Solus API
 * of its organization does not answer for it: the organization keeps its
 * sessions on their hosts, or this client has no connection to that Solus API.
 */
export function answersForOwnSessions(machine: { serverId: string; organizationId: string | null }, connections: SessionHomeConnections): boolean {
  if (!connections.isCloudHost?.(machine.serverId) || !machine.organizationId) return true
  if (!readsSessionsFromSolusApi(machine.organizationId, connections)) return true
  return !connections.serverIds().includes(solusApiId(machine.organizationId))
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
 * session only through its machine, so the machine stands in. So does the
 * machine of an organization that keeps its sessions on their hosts
 * (`readsSessionsFromSolusApi`): the Solus API has no conversation of them.
 */
export function sessionHomeId(
  machineServerId: string,
  session: { organizationId?: string | null; publication?: RecordPublication },
  connections: SessionHomeConnections,
): string {
  const { organizationId, publication } = session
  if (!organizationId || organizationId === 'local' || publication !== 'published' || !connections.isCloudHost?.(machineServerId)) return machineServerId
  if (!readsSessionsFromSolusApi(organizationId, connections)) return machineServerId
  const serviceId = solusApiId(organizationId)
  return connections.serverIds().includes(serviceId) ? serviceId : machineServerId
}
