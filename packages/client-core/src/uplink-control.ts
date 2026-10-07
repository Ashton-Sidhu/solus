import type { ConnectionsServerInfo } from '@solus/contracts/host-api'

/**
 * What this client may do with a host's Solus Cloud link. Linking changes how
 * the host is reached, so the host accepts it only from a `local-owner`: the
 * desktop on that machine or a paired device (pairing is local authorization).
 * The owner who arrived through the tunnel sees the link but cannot change it:
 * an unlink would cut the connection it arrived on. A managed host's link is
 * system-owned and the workspace service has none, so neither shows one.
 */
export type UplinkControl = 'manage' | 'view' | 'none'

export function uplinkControl(info: Pick<ConnectionsServerInfo, 'principal' | 'hostKind'>): UplinkControl {
  if (info.hostKind !== 'personal') return 'none'
  if (info.principal === 'local-owner') return 'manage'
  if (info.principal === 'remote-owner') return 'view'
  return 'none'
}
