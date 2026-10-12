import type { HostRoute } from '@solus/contracts/uplink'
import type { ReachableEndpoint } from '../transport/endpoints'

/**
 * The routes a host offers for its own share links (docs/plans/host-sharing.md
 * §4.1 step 2): the tunnel when it is online, else the direct endpoints a visitor
 * off this machine can dial — the tailnet first, then each LAN address. Loopback
 * is never a share route. Empty when the host has no tunnel and allows no LAN
 * connection, which the dialog reports.
 */
export function shareRoutesFor(tunnelUrl: string | null, endpoints: ReachableEndpoint[]): HostRoute[] {
  if (tunnelUrl) return [{ kind: 'tunnel', url: tunnelUrl }]
  const direct = (kind: ReachableEndpoint['kind']) => endpoints
    .filter((endpoint) => endpoint.kind === kind)
    .map((endpoint): HostRoute => ({ kind: 'direct', url: `http://${endpoint.host}:${endpoint.port}` }))
  return [...direct('tailnet'), ...direct('lan')]
}
