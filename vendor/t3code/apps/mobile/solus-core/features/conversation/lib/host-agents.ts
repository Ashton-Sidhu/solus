import type { AgentMetadata } from '@solus/contracts/types'
import type { HostConnection } from '../../hosts/host-connections'

/** The host's agents and their capabilities, or null when the host cannot say.
 *  The host's facts hold one read per server session; a failed read is asked
 *  again by the next conversation. */
export function hostAgents(connection: HostConnection): Promise<readonly AgentMetadata[] | null> {
  return connection.facts.when('machine').then((info) => info.agents ?? null, () => null)
}
