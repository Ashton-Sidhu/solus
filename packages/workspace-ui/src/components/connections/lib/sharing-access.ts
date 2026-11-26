import type { RouteRef } from '../../../contexts/workspace/routing/route-registry'
import { connectionsNav } from '../connections-nav.svelte'

/** Settings → Sharing & access for one host (`settings/sharing/<host>`), as T3 Code's `/settings/access?machine=`. */
export function sharingAccessRoute(serverId: string): RouteRef<'settings'> {
  return { name: 'settings', params: { tab: 'sharing', host: serverId } }
}

/**
 * Opens Sharing & access or Solus Cloud for a host from Settings → Hosts: the
 * host's Overview and its menu. It replaces the page, as a change of settings tab
 * does, and closes the host page, so Hosts opens on its list when the person
 * comes back.
 */
export function openHostSettings(
  router: { navigate(ref: RouteRef, opts: { replace: boolean }): void },
  serverId: string,
  tab: 'sharing' | 'cloud',
): void {
  router.navigate({ name: 'settings', params: { tab, host: serverId } }, { replace: true })
  connectionsNav.back()
}

/** What a person sees on Sharing & access, from how the host admitted them and what they may do there. */
export interface SharingAccessRights {
  /** Pairing exists only on a personal host: the control plane owns how a cloud host is reached. */
  hasPairing: boolean
  /** Only a local owner changes how the host is reached. */
  canChangeNetwork: boolean
  /** A local owner of a personal host makes pairing codes. */
  showsPairCode: boolean
  /** Only the host's owner reads and revokes its pairings and the apps that signed in (plans/033 §4.4). */
  showsPairedDevices: boolean
  /** A principal with `host.local.reach` lists and decides approval requests. */
  showsApprovals: boolean
  /** Every person who uses the host connects outside apps that act as them (plans/035 §0.3), on a cloud machine too. */
  showsOutsideApps: boolean
}

export function sharingAccessRights(
  info: { hostKind: string; principal: string } | null,
  may: (permission: 'host.local.reach' | 'host.use') => boolean,
): SharingAccessRights {
  const hasPairing = info?.hostKind === 'personal'
  const isOwner = info?.principal === 'local-owner' || info?.principal === 'remote-owner'
  const canChangeNetwork = info?.principal === 'local-owner'
  return {
    hasPairing,
    canChangeNetwork,
    showsPairCode: hasPairing && canChangeNetwork,
    showsPairedDevices: hasPairing && isOwner,
    showsApprovals: hasPairing && info !== null && may('host.local.reach'),
    showsOutsideApps: info !== null && may('host.use'),
  }
}
