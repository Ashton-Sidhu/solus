import type { HostRoute } from '@solus/contracts/host-routes'
import type { ReachableEndpoint } from '../transport/endpoints'

/**
 * The routes a host offers for its own share links (docs/plans/host-sharing.md
 * §4.1 step 2): the tunnel when it is online, else the tailnet. A link's secret is
 * the whole credential, so it never travels over a route that does not encrypt it:
 * the tunnel is HTTPS and the tailnet is WireGuard, but a LAN address is plain
 * HTTP that anyone on the network can read (docs/plans/custom-roles.md §9).
 * Loopback is never a share route. Empty when the host has neither, which the
 * dialog reports.
 */
export function shareRoutesFor(tunnelUrl: string | null, endpoints: ReachableEndpoint[]): HostRoute[] {
  if (tunnelUrl) return [{ kind: 'tunnel', url: tunnelUrl }]
  return endpoints
    .filter((endpoint) => endpoint.kind === 'tailnet')
    .map((endpoint): HostRoute => ({ kind: 'tailnet', url: `http://${endpoint.host}:${endpoint.port}` }))
}
