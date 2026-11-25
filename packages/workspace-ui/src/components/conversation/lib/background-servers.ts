import type { RunningServers } from '@solus/client-core/running-servers'
import { agentServersOf } from '@solus/client-core/background-work'

export interface BackgroundServers {
  /** The processes that the session's agent started and that still listen. */
  count: number
  /** Their addresses, as the row prints them: `localhost:5177`. */
  addresses: string[]
}

export const NO_BACKGROUND_SERVERS: BackgroundServers = { count: 0, addresses: [] }

/** The servers of one session's agent, from its host's Running servers list. */
export function backgroundServersOf(servers: readonly RunningServers[], sessionId: string): BackgroundServers {
  const own = agentServersOf(servers, sessionId)
  if (own.length === 0) return NO_BACKGROUND_SERVERS
  const addresses = own.flatMap((server) => server.endpoints.map((endpoint) => endpoint.url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')))
  return { count: own.length, addresses: [...new Set(addresses)] }
}
