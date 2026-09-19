import { isLoopbackAddress } from '../transports/websocket'
import { tailnetAddresses } from './endpoints'
import { isManagedHost } from './managed-mode'
import { getServerSettings } from './settings'
import { isWorkspaceMode } from './workspace-mode'

/**
 * Whether a connected requester may use the server without pairing, even when
 * the bind policy demands auth.
 *
 * - The machine itself: a loopback caller already has the same filesystem
 *   access as the server, so a pairing code protects nothing.
 * - The host's own tailnet: tailscale has already identity-checked every
 *   member device, which is exactly the trust the 6-digit code establishes.
 * - The local network, only when the owner opted in via the
 *   "trust my local network" server setting: a shared network is not an
 *   identity, so this is never the default.
 *
 * On a managed host (docs/plans/managed-hosts.md §1) and on the workspace service
 * (cloud-service-model.md §15) nobody is trusted by network position: loopback,
 * tailnet, and LAN are all strangers, and the setting is ignored.
 */
export async function isTrustedRequesterAddress(address: string | undefined): Promise<boolean> {
  if (!address || isManagedHost() || isWorkspaceMode()) return false
  if (isLoopbackAddress(address)) return true
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (getServerSettings().trustLocalNetwork && isPrivateLanAddress(normalized)) return true
  return (await tailnetAddresses()).has(normalized)
}

/** RFC1918 and link-local IPv4, plus IPv6 unique-local and link-local. */
export function isPrivateLanAddress(address: string): boolean {
  if (address.startsWith('10.')) return true
  if (address.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true
  if (address.startsWith('169.254.')) return true
  const lower = address.toLowerCase()
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
}
