import type { AgentMetadata } from '@solus/contracts/types'
import type { HostConnection } from '../../hosts/host-connections'

/** One read per connection: what an agent can do does not change while it lasts. */
const agentsByConnection = new WeakMap<HostConnection, Promise<readonly AgentMetadata[] | null>>()

/** The host's agents and their capabilities, or null when the host cannot say.
 *  A failed read is not kept, so the next conversation asks again. */
export function hostAgents(connection: HostConnection): Promise<readonly AgentMetadata[] | null> {
  const known = agentsByConnection.get(connection)
  if (known) return known
  const read = connection.api.start().then((info) => info.agents ?? null, () => {
    agentsByConnection.delete(connection)
    return null
  })
  agentsByConnection.set(connection, read)
  return read
}
