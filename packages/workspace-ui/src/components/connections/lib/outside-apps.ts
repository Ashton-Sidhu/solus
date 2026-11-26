import type { AppEndpoint } from '../../../contexts/connections/connections.store.svelte'

/** One address of a host's MCP endpoint, and where it works. */
export interface AppEndpointAddress {
  kind: 'local' | 'public'
  label: string
  url: string
}

/** The addresses an outside app can use: always the one on the host's machine, and the public tunnel address when the host has one. */
export function appEndpointAddresses(endpoint: AppEndpoint): AppEndpointAddress[] {
  const local: AppEndpointAddress = { kind: 'local', label: "On the host's computer", url: endpoint.localUrl }
  if (!endpoint.publicUrl) return [local]
  return [local, { kind: 'public', label: 'From anywhere', url: endpoint.publicUrl }]
}

/** The Claude Code command that adds the host as an MCP server. It uses the public address when there is one, as it works from every computer. */
export function claudeMcpAddCommand(endpoint: AppEndpoint): string {
  return `claude mcp add --transport http solus ${endpoint.publicUrl ?? endpoint.localUrl}`
}

/** When a pairing code stops working: "Expires in 9:41", or "Expired". */
export function pairingCodeExpiry(expiresAt: number, now: number): string {
  const msLeft = expiresAt - now
  if (msLeft <= 0) return 'Expired'
  const totalSeconds = Math.ceil(msLeft / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`
}
