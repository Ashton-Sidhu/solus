import { isLoopbackHostname } from '../integration-types'

/**
 * The MCP servers that run on a host's own loopback (docs/plans/mcp-first-class.md
 * §9), apart from `integration-types.ts` so the first screen does not carry them.
 */

/**
 * Where the host saw a running local server (§9.2): an HTTP listener on its own
 * loopback that answered `server/discover` as an MCP server. `processName` is the
 * name the running-servers list gives; `checkout` is the branch, or else the
 * folder name, of the checkout the process runs in; `serverInfo` is what the
 * server said about itself, absent for a server of revision 2025, which does not
 * answer `server/discover`. Solus verified none of it: any local process can
 * answer on a port. `startedBySessionId`: the Solus session whose agent started
 * the process (§9.4). No host path crosses.
 */
export interface FoundPortPlace {
  kind: 'port'
  runningServerId: string
  endpointId: string
  port: number
  processName: string
  checkout?: string
  serverInfo?: { name: string; title?: string; version?: string }
  startedBySessionId?: string
}

/**
 * Whether the host could look for MCP servers that run on its loopback (§9.1).
 * `unavailable`: it could not list its listeners, and `reason` says why, so no
 * port row can show.
 */
export type FoundPortScan = { state: 'ready' } | { state: 'unavailable'; reason: string }

/**
 * Whether a server on the host's own loopback runs (§9.3). `running`: the host's
 * last running-servers list, at most 10 seconds old, has a listener on its port.
 * `not-running`: that list has none. `unknown`: no such list, because no client
 * watches the host's running servers or the host cannot list them. Derived,
 * never saved; a row never shows "Not running" from an old list.
 */
export type IntegrationReachable = 'running' | 'not-running' | 'unknown'

/** The port of a server address on the host's own loopback, or null for any other address (§9.3). */
export function loopbackServerPort(address: string): number | null {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHostname(url.hostname)) return null
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
}
