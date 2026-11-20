import { hostInOrganization, managedHostNeedsStart, type KnownHost } from '@solus/client-core/known-host'

/**
 * Which directory hosts the selected organization shows. The selection is a
 * view filter (organization-scope §2): it never changes a host's access. A host
 * shared with no organization is the person's own and shows in every view.
 */
export function cloudHostsFor(hosts: readonly KnownHost[], organizationId: string | null): KnownHost[] {
  return hosts.filter((host) => {
    if (!host.uplink) return false
    const organizations = host.uplink.organizationIds ?? []
    return organizations.length === 0 || hostInOrganization(host.uplink, organizationId)
  })
}

export type CloudHostState = 'ready' | 'stopped' | 'starting' | 'unavailable' | 'no-route'

/** What a cloud host's row says and offers, from the directory's own words. */
export function cloudHostState(host: KnownHost): CloudHostState {
  const uplink = host.uplink
  if (uplink?.kind === 'managed') {
    if (uplink.managedState === 'ready') return host.routes.length ? 'ready' : 'no-route'
    if (managedHostNeedsStart(uplink.managedState)) return 'stopped'
    if (uplink.managedState === 'deleting') return 'unavailable'
    return 'starting'
  }
  return host.routes.length ? 'ready' : 'no-route'
}
