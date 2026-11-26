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
