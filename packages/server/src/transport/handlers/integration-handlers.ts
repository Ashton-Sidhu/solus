import {
  integrationCatalogListRequestSchema,
  integrationConnectCancelRequestSchema,
  integrationConnectStartRequestSchema,
  integrationConnectSubmitRequestSchema,
  integrationCreateRequestSchema,
  integrationIdRequestSchema,
  integrationProbeRequestSchema,
  integrationSlug,
  integrationUpdateRequestSchema,
  type Integration,
  type IntegrationAuth,
  type IntegrationOAuthClientInput,
  type IntegrationProbeUndeterminedReason,
} from '@solus/contracts/integration-types'
import { isHostAdmin, organizationForNew, personalRecordOwnerOf, recordScopeOf, type Principal, type RecordScope } from '../../admission/principal'
import type { IntegrationCatalog } from '../../integrations/catalog'
import type { IntegrationConnectionStore, IntegrationSecrets } from '../../integrations/connection-store'
import type { IntegrationConnections } from '../../integrations/connections'
import type { IntegrationGateway } from '../../integrations/gateway'
import type { IntegrationStore } from '../../integrations/integration-store'
import type { IntegrationOAuth } from '../../integrations/oauth'
import { probeMcpServer } from '../../integrations/probe'
import { currentCredentialUserId } from '../../vault/acting-scope'
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
 * The auth after an administrator's OAuth client change: `clientId` and
 * `hasClientSecret` set from the input, or cleared for `null`. The secret is
 * saved by the caller and never kept on the record.
 */
function withOAuthClient(auth: IntegrationAuth, input: IntegrationOAuthClientInput | null): IntegrationAuth {
  if (auth.kind !== 'oauth') throw new Error('This integration does not sign in with OAuth.')
  const rest: IntegrationAuth = { kind: 'oauth', discover: auth.discover, registration: auth.registration }
  return input ? { ...rest, clientId: input.clientId, hasClientSecret: Boolean(input.clientSecret) } : rest
}

/**
 * Who may change a record (plans/020-agent-profile.md §2.1): a personal
 * integration is its owner's; a shared one is the host administrator's.
 */
function mayChange(principal: Principal, integration: Integration): boolean {
  return integration.ownerUserId !== null ? integration.ownerUserId === personalRecordOwnerOf(principal) : isHostAdmin(principal)
}

/**
 * Integrations (docs/plans/mcp-integrations.md §12): the remote MCP servers this
 * host knows. Reads take the caller's record scope and include the caller's own
 * personal records; a new integration starts in the caller's organization for
 * new records. Every write tells the gateway and sends `integration.changed`.
 */
export function registerIntegrationHandlers(server: SolusServer, deps: {
  store: IntegrationStore
  catalog: IntegrationCatalog
  gateway: IntegrationGateway
  events: HostEventPublisher
  /** Per-person sign-in (§4). Every handler runs in the caller's acting scope, so `currentCredentialUserId()` is the caller. */
  connectionStore: IntegrationConnectionStore
  connections: IntegrationConnections
  oauth: IntegrationOAuth
  /** Where an administrator's OAuth client secret is kept; `oauth` reads it from the same store. */
  secrets: Pick<IntegrationSecrets, 'saveClient' | 'removeClient'>
  getServerInfo(): { host: string; port: number }
  /**
   * The caller's agent profile (plans/020-agent-profile.md): signed in, the
   * caller's own servers are part of it, so a change here goes to their account
   * and every host follows. Absent where no profile applies.
   */
  profile?: {
    saved(principal: Principal, integration: Integration): Promise<void>
    removing(principal: Principal, integration: Integration): Promise<void>
  }
}): void {
  const { store, catalog, gateway, events, connectionStore, connections, oauth, secrets } = deps
  const requireIntegration = (id: string, scope: RecordScope, viewer: string | null) => {
    const integration = store.getVisible(id, scope, viewer)
    if (!integration) throw new Error('That integration is no longer on this host.')
    return integration
  }
  const requireOwn = (id: string, principal: Principal) => {
    const integration = requireIntegration(id, recordScopeOf(principal), personalRecordOwnerOf(principal))
    if (!mayChange(principal, integration)) throw new Error(integration.ownerUserId ? 'That integration is not yours to change.' : 'Only the host administrator changes a shared integration.')
    return integration
  }

  server.register('integrationCatalogList', (args) => catalog.list(integrationCatalogListRequestSchema.parse(args[0] ?? {})))

  server.register('integrationProbe', (args) => probeMcpServer(integrationProbeRequestSchema.parse(args[0]).url))

  server.register('integrationList', (_args, ctx) => store.list(recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal)))

  server.register('integrationGet', (args, ctx) => store.getVisible(integrationIdRequestSchema.parse(args[0]).id, recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal)))

  server.register('integrationCreate', async (args, ctx) => {
    const request = integrationCreateRequestSchema.parse(args[0])
    // A person's own record on a host they do not administer; on their own host every record is the host's.
    const ownerUserId = request.personal ? personalRecordOwnerOf(ctx.principal) : null
    if (ownerUserId === null && !isHostAdmin(ctx.principal)) throw new Error('Only the host administrator adds a shared integration.')
    const probe = await probeForWrite(request.url)
    const createdBy = ctx.principal.kind === 'org-member' ? ctx.principal.userId : null
    const integration = store.create(
      { name: request.name, url: request.url, slug: integrationSlug(request.slug ?? request.name), auth: probe.auth },
      organizationForNew(ctx.principal),
      createdBy,
      ownerUserId,
    )
    void events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
    void gateway.warm(integration.id)
    void deps.profile?.saved(ctx.principal, integration)
    return integration
  })

  server.register('integrationUpdate', async (args, ctx) => {
    const { id, name, url, oauthClient, disabledTools } = integrationUpdateRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    const existing = requireOwn(id, ctx.principal)
    let auth = url !== undefined && url !== existing.url ? (await probeForWrite(url)).auth : undefined
    if (oauthClient !== undefined) {
      auth = withOAuthClient(auth ?? existing.auth, oauthClient)
      if (oauthClient === null) secrets.removeClient(id)
      else {
        const { clientId, clientSecret } = oauthClient
        secrets.saveClient(id, clientSecret
          ? { clientId, clientSecret, tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] }
          : { clientId, tokenEndpointAuthMethod: 'none', redirectUris: [] })
      }
    }
    const integration = store.update(id, { name, url, auth, disabledTools }, scope)
    if (!integration) throw new Error('That integration is no longer on this host.')
    // Turning tools on or off keeps the upstream session: the filter is on the record.
    if (name !== undefined || url !== undefined || oauthClient !== undefined) {
      gateway.invalidate(id)
      void gateway.warm(id)
    }
    void events.broadcast('integration.changed', { integrationId: id, change: 'updated' })
    void deps.profile?.saved(ctx.principal, integration)
    return integration
  })

  server.register('integrationRemove', async (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    if (!store.getVisible(id, scope, personalRecordOwnerOf(ctx.principal))) return { removed: false }
    const integration = requireOwn(id, ctx.principal)
    // It leaves the caller's profile first, so no host's next pull brings it back.
    await deps.profile?.removing(ctx.principal, integration)
    gateway.invalidate(id)
    const removed = store.remove(id, scope)
    if (removed) connections.removeAllFor(id)
    if (removed) void events.broadcast('integration.changed', { integrationId: id, change: 'removed' })
    return { removed }
  })

  server.register('integrationTools', (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    requireIntegration(id, recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal))
    return gateway.tools(id)
  })

  server.register('integrationConnectionList', () => connectionStore.list(currentCredentialUserId()))

  server.register('integrationConnectStart', async (args, ctx) => {
    const request = integrationConnectStartRequestSchema.parse(args[0])
    const integration = requireIntegration(request.id, recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal))
    const user = currentCredentialUserId()
    switch (integration.auth.kind) {
      case 'none':
        return { kind: 'connected' as const, connection: connections.connectAnonymous(integration, user) }
      case 'bearer':
        return { kind: 'token' as const, integrationId: integration.id }
      case 'oauth': {
        const { host, port } = deps.getServerInfo()
        return oauth.start(integration, { callbackBaseUrl: request.callbackBaseUrl, fallbackHost: host, fallbackPort: port })
      }
    }
  })

  server.register('integrationConnectSubmit', async (args, ctx) => {
    const request = integrationConnectSubmitRequestSchema.parse(args[0])
    if (request.flowId !== undefined) {
      await oauth.submitRedirect(request.flowId, request.value)
    } else if (request.id !== undefined) {
      await connections.submitKey(requireIntegration(request.id, recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal)), currentCredentialUserId(), request.value)
    }
    return { submitted: true as const }
  })

  server.register('integrationConnectCancel', (args) => ({ cancelled: oauth.cancel(integrationConnectCancelRequestSchema.parse(args[0]).flowId) }))

  server.register('integrationDisconnect', async (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    return { disconnected: await connections.disconnect(requireIntegration(id, recordScopeOf(ctx.principal), personalRecordOwnerOf(ctx.principal)), currentCredentialUserId()) }
  })
}
