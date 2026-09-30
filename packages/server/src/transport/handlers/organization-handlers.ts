import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { shareResourceSchema } from '@solus/contracts/sharing'
import { hostUserKey } from '../../host/host-user'
import { isAnyOrganization, recordScopeOf } from '../../admission/principal'
import { ownerKeyOf } from '../../admission/actor'
import { hostCategory } from '../../host/host-category'
import { organizationAttachedAt } from '../../host/organization-attachment'
import type { HostOrganizations } from '../../host/organizations'
import { getInsightsOptIn, setInsightsOptIn } from '../../host/settings'
import type { PublicationCoordinator } from '../../sync/publication'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { SolusServer } from '../server'

/**
 * Organization scope over RPC (docs/plans/organization-scope.md): what this
 * machine stands in, the person's Insights opt-ins, publication into an
 * organization, and one organization's Insights as the Solus API holds them.
 */

export interface OrganizationHandlerDeps {
  hostOrganizations: HostOrganizations
  publications: PublicationCoordinator | null
  events: HostEventPublisher
  linkHostId: () => string | null
  /** The Solus API the link names; null while unlinked. */
  apiUrl: () => string | null
  /** What waits to reach each organization, and the last delivery error. */
  delivery: () => { backlog: HostOrganizationsStatus['delivery']; error: string | null }
}

export function hostOrganizationsStatus(deps: Pick<OrganizationHandlerDeps, 'hostOrganizations' | 'linkHostId' | 'apiUrl' | 'delivery'>): HostOrganizationsStatus {
  const standing = deps.hostOrganizations.current()
  const delivery = deps.delivery()
  return {
    linked: deps.linkHostId() !== null,
    hostId: deps.linkHostId(),
    category: standing?.category ?? hostCategory(),
    owner: standing?.owner ?? null,
    organizations: standing?.organizations ?? [],
    insightsOptIn: getInsightsOptIn(),
    attachedAt: organizationAttachedAt(),
    apiUrl: deps.apiUrl(),
    delivery: delivery.backlog,
    deliveryError: delivery.error,
  }
}

export function registerOrganizationHandlers(server: SolusServer, deps: OrganizationHandlerDeps): void {
  const status = () => hostOrganizationsStatus(deps)
  deps.hostOrganizations.onChanged(() => deps.events.broadcast('host.organizationsChanged', status()))

  server.register('hostOrganizations', async () => {
    // A read older than half a minute asks the control plane again first, so a
    // policy edit reaches the settings page that is looking at it.
    const standing = deps.hostOrganizations.current()
    if (!standing || Date.now() - standing.refreshedAt > 30_000) await deps.hostOrganizations.refresh()
    return status()
  })

  server.register('hostSetInsightsOptIn', (args) => {
    const [organizationId, enabled] = args
    if (!organizationId?.trim()) throw new Error('hostSetInsightsOptIn requires an organization')
    setInsightsOptIn(organizationId, enabled)
    const next = status()
    deps.events.broadcast('host.organizationsChanged', next)
    return next
  })

  server.register('publicationStart', async (args, ctx) => {
    const [request] = args
    if (!deps.publications) throw new Error('Publishing is available on a host, not on the Solus API.')
    const resource = shareResourceSchema.parse(request.resource)
    if (!request.organizationId?.trim()) throw new Error('Choose an organization to publish to.')
    if (!deps.hostOrganizations.organization(request.organizationId)) throw new Error('This host cannot deliver to that organization. Sign in and check your memberships.')
    const scope = recordScopeOf(ctx.principal)
    if (!isAnyOrganization(scope) && scope !== request.organizationId) throw new Error('You can publish only into your own organization.')
    return deps.publications.start({ resource, organizationId: request.organizationId }, ownerKeyOf(ctx.actor) ?? hostUserKey())
  })

  server.register('publicationList', (args) => {
    const [resource] = args
    if (!deps.publications) return []
    return deps.publications.list(resource ? shareResourceSchema.parse(resource) : undefined)
  })

}
