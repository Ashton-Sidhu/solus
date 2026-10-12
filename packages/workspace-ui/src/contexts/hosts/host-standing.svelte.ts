import { EVERY_HOST_ACTION, grantsAllow, isResourceVerb, type HostAction, type ResourceVerb } from '@solus/contracts/permissions'
import type { ShareResource } from '@solus/contracts/sharing'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostFact } from '@solus/client-core/host-facts'
import { resourceMay } from '../sharing/resource-roles'

/**
 * This client's standing on one host (docs/plans/permissions.md §4): "may I,
 * here". The host answers the grants with its server info; a resource verb is
 * answered by the share role on that resource. The same tables gate the host, so
 * a control is disabled exactly when the call would be refused. Until the host
 * answers, the client assumes the owner's standing, so an owner's controls never
 * flicker on.
 */
export class HostStanding {
  constructor(private readonly serverId: string, private readonly serverInfo: () => HostFact<ConnectionsServerInfo>) {}

  /** The host actions this connection holds, as prefixes; the owner's until the host answers. */
  get grants(): readonly HostAction[] {
    const fact = this.serverInfo()
    if (fact.state !== 'ready') return EVERY_HOST_ACTION
    if (Array.isArray(fact.value.grants)) return fact.value.grants
    // A host running an older server can answer before it supports grants.
    return fact.value.principal === 'local-owner' ? EVERY_HOST_ACTION : []
  }

  /** How the host admitted this client; undefined until it answers. */
  get principal(): ConnectionsServerInfo['principal'] | undefined {
    const fact = this.serverInfo()
    return fact.state === 'ready' ? fact.value.principal : undefined
  }

  get isGuest(): boolean {
    return this.principal === 'guest'
  }

  /** Whether this client holds a host action here, or may do `verb` on one resource of this host. */
  may(action: HostAction): boolean
  may(verb: ResourceVerb, resource: ShareResource): boolean
  may(action: HostAction | ResourceVerb, resource?: ShareResource): boolean {
    if (resource && isResourceVerb(action)) return resourceMay(this.serverId, resource, action)
    return grantsAllow(this.grants, action)
  }
}
