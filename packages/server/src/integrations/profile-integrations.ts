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
 * records on every host (docs/plans/access-model.md, D3).
 * Every write tells the gateway and the clients, as the handlers do, so a
 * profile copy and a Settings edit leave the host in one state.
 */
export function profileIntegrations(deps: {
  store: IntegrationStore
  gateway: Pick<IntegrationGateway, 'invalidate'>
  connections: Pick<IntegrationConnections, 'removeAllFor'>
  events: Pick<HostEventPublisher, 'broadcast'>
}): ProfileIntegrations {
  const { store, gateway, connections, events } = deps
  return {
    list: (owner: ProfileIntegrationOwner) => store.list(owner.organizationId, owner.ownerKey),
    findByUrl: (owner, url) => store.findByUrl(url, owner.organizationId, owner.ownerKey),
    create: (owner, entry: AgentProfileIntegrationEntry): Integration => {
      const integration = store.create({ name: entry.name, url: entry.url, slug: entry.slug, auth: entry.auth }, owner.organizationId, owner.ownerKey)
      void events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
      return integration
    },
    update: (id, entry) => {
      const integration = store.update(id, { name: entry.name, url: entry.url, auth: entry.auth }, organizationOf(id, store))
      if (!integration) return
      gateway.invalidate(id)
      void events.broadcast('integration.changed', { integrationId: id, change: 'updated' })
    },
    remove: (id) => {
      gateway.invalidate(id)
      const integration = store.get(id, ANY_ORGANIZATION)
      if (!integration) return
      if (!store.remove(id, integration.organizationId)) return
      connections.removeAllFor(integration)
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
