import {
  integrationCatalogListRequestSchema,
  integrationCreateRequestSchema,
  integrationIdRequestSchema,
  integrationProbeRequestSchema,
  integrationSlug,
  integrationUpdateRequestSchema,
  type IntegrationProbeUndeterminedReason,
} from '@solus/contracts/integration-types'
import { organizationForNew, recordScopeOf, type RecordScope } from '../../admission/principal'
import type { IntegrationCatalog } from '../../integrations/catalog'
import type { IntegrationGateway } from '../../integrations/gateway'
import type { IntegrationStore } from '../../integrations/integration-store'
import { probeMcpServer } from '../../integrations/probe'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { SolusServer } from '../server'

/** Why a probe decided nothing, as the person reads it. */
const UNDETERMINED_MESSAGES = {
  unavailable: 'The server is unavailable right now. Try again later.',
  unreachable: 'Solus could not reach the server.',
  timeout: 'The server did not answer in time.',
  redirected: 'The server redirected the request. Use the address it redirects to.',
  refused: 'The server refused the request, or the address is not public.',
  not_mcp: 'The address did not answer as an MCP server.',
  initialize_error: 'The server refused to start an MCP session.',
  tools_error: 'The server did not list its tools.',
  oauth_unusable: 'The server advertises a sign-in that Solus cannot use.',
} satisfies Record<IntegrationProbeUndeterminedReason, string>

/** The probe decided nothing, so no integration is written. */
export class IntegrationProbeRefusedError extends Error {
  constructor(readonly reason: IntegrationProbeUndeterminedReason) {
    super(UNDETERMINED_MESSAGES[reason])
    this.name = 'IntegrationProbeRefusedError'
  }
}

/** Probe an address before it is stored; an undetermined answer refuses the write. */
async function probeForWrite(url: string) {
  const probe = await probeMcpServer(url)
  if (probe.outcome === 'undetermined') throw new IntegrationProbeRefusedError(probe.reason)
  return probe
}

/**
 * Integrations (docs/plans/mcp-integrations.md §12): the remote MCP servers this
 * host knows. Reads take the caller's record scope; a new integration starts in
 * the caller's organization for new records. Every write tells the gateway and
 * sends `integration.changed`.
 */
export function registerIntegrationHandlers(server: SolusServer, deps: {
  store: IntegrationStore
  catalog: IntegrationCatalog
  gateway: IntegrationGateway
  events: HostEventPublisher
}): void {
  const { store, catalog, gateway, events } = deps
  const requireIntegration = (id: string, scope: RecordScope) => {
    const integration = store.get(id, scope)
    if (!integration) throw new Error('That integration is no longer on this host.')
    return integration
  }

  server.register('integrationCatalogList', (args) => catalog.list(integrationCatalogListRequestSchema.parse(args[0] ?? {})))

  server.register('integrationProbe', (args) => probeMcpServer(integrationProbeRequestSchema.parse(args[0]).url))

  server.register('integrationList', (_args, ctx) => store.list(recordScopeOf(ctx.principal)))

  server.register('integrationGet', (args, ctx) => store.get(integrationIdRequestSchema.parse(args[0]).id, recordScopeOf(ctx.principal)))

  server.register('integrationCreate', async (args, ctx) => {
    const request = integrationCreateRequestSchema.parse(args[0])
    const probe = await probeForWrite(request.url)
    const createdBy = ctx.principal.kind === 'org-member' ? ctx.principal.userId : null
    const integration = store.create(
      { name: request.name, url: request.url, slug: integrationSlug(request.slug ?? request.name), auth: probe.auth },
      organizationForNew(ctx.principal),
      createdBy,
    )
    void events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
    void gateway.warm(integration.id)
    return integration
  })

  server.register('integrationUpdate', async (args, ctx) => {
    const { id, name, url } = integrationUpdateRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    const existing = requireIntegration(id, scope)
    const auth = url !== undefined && url !== existing.url ? (await probeForWrite(url)).auth : undefined
    const integration = store.update(id, { name, url, auth }, scope)
    if (!integration) throw new Error('That integration is no longer on this host.')
    gateway.invalidate(id)
    void gateway.warm(id)
    void events.broadcast('integration.changed', { integrationId: id, change: 'updated' })
    return integration
  })

  server.register('integrationRemove', (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    if (!store.get(id, scope)) return { removed: false }
    gateway.invalidate(id)
    const removed = store.remove(id, scope)
    if (removed) void events.broadcast('integration.changed', { integrationId: id, change: 'removed' })
    return { removed }
  })

  server.register('integrationTools', (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    requireIntegration(id, recordScopeOf(ctx.principal))
    return gateway.tools(id)
  })
}
