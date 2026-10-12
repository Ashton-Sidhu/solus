import type { AgentProfileIntegrationEntry } from '@solus/contracts/agent-profile'
import type { Integration } from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import type { ProfileIntegrationOwner, ProfileIntegrations } from '../execution/seats/agent-profile'
import type { HostEventPublisher } from '../transport/events/host-event-publisher'
import type { IntegrationConnections } from './connections'
import type { IntegrationGateway } from './gateway'
import type { IntegrationStore } from './integration-store'

/**
 * The integration records as the agent profile writes them
 * (plans/020-agent-profile.md §2): a person's MCP servers become their own
 * personal records on a shared host, or the host's own on a host they own.
 * Every write tells the gateway and the clients, as the handlers do, so a
 * profile copy and a Settings edit leave the host in one state.
 */
export function profileIntegrations(deps: {
  store: IntegrationStore
  gateway: Pick<IntegrationGateway, 'warm' | 'invalidate'>
  connections: Pick<IntegrationConnections, 'removeAllFor'>
  events: Pick<HostEventPublisher, 'broadcast'>
}): ProfileIntegrations {
  const { store, gateway, connections, events } = deps
  return {
    list: (owner: ProfileIntegrationOwner) => store.listOwned(owner.organizationId, owner.ownerUserId),
    findByUrl: (owner, url) => {
      const integration = store.findByUrl(url, owner.organizationId, owner.ownerUserId)
      return integration ? { integration, own: integration.ownerUserId === owner.ownerUserId } : null
    },
    create: (owner, entry: AgentProfileIntegrationEntry): Integration => {
      const integration = store.create({ name: entry.name, url: entry.url, slug: entry.slug, auth: entry.auth }, owner.organizationId, owner.ownerUserId, owner.ownerUserId)
      void events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
      void gateway.warm(integration.id)
      return integration
    },
    update: (id, entry) => {
      const integration = store.update(id, { name: entry.name, url: entry.url, auth: entry.auth }, organizationOf(id, store))
      if (!integration) return
      gateway.invalidate(id)
      void gateway.warm(id)
      void events.broadcast('integration.changed', { integrationId: id, change: 'updated' })
    },
    remove: (id) => {
      gateway.invalidate(id)
      if (!store.remove(id, organizationOf(id, store))) return
      connections.removeAllFor(id)
      void events.broadcast('integration.changed', { integrationId: id, change: 'removed' })
    },
  }
}

/** The organization a record is in, so a write names its scope; `ANY_ORGANIZATION` is not a write scope. */
function organizationOf(id: string, store: Pick<IntegrationStore, 'get'>): string {
  const record = store.get(id, ANY_ORGANIZATION)
  if (!record) throw new Error('That integration is no longer on this host.')
  return record.organizationId
}
