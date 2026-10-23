import { randomUUID } from 'node:crypto'
import {
  DEFAULT_INTEGRATION_ACCOUNT,
  integrationCatalogListRequestSchema,
  integrationConnectCancelRequestSchema,
  integrationConnectStartRequestSchema,
  integrationConnectSubmitRequestSchema,
  integrationCreateRequestSchema,
  integrationAccountRequestSchema,
  integrationIdRequestSchema,
  integrationProbeRequestSchema,
  integrationUpdateRequestSchema,
  type Integration,
  type IntegrationAuth,
  type IntegrationOAuthClientInput,
} from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { OAuthClientRequiredError } from '@solus/contracts/integrations/oauth-protocol'
import { roleOf } from '../../admission/access'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { recordScopeOf, type Principal } from '../../admission/principal'
import type { IntegrationCatalog } from '../../integrations/catalog'
import type { IntegrationClients, IntegrationConnectionStore } from '../../integrations/connection-store'
import type { IntegrationConnections } from '../../integrations/connections'
import type { IntegrationGateway } from '../../integrations/gateway'
import type { IntegrationStore } from '../../integrations/integration-store'
import type { IntegrationOAuth } from '../../integrations/oauth'
import { createIntegration, probeAddress, probeForWrite } from '../../integrations/integration-create'
import { createLogger } from '../../logger'
import { currentPersonKey, requirePersonKey } from '../../vault/acting-scope'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { SolusServer } from '../server'

const log = createLogger('integrations', 'integration-handlers.ts')

/**
 * The auth after the owner's OAuth client change: `clientId` and
 * `hasClientSecret` set from the input, or cleared for `null`. The secret is
 * saved by the caller and never kept on the record.
 */
function withOAuthClient(auth: IntegrationAuth, input: IntegrationOAuthClientInput | null): IntegrationAuth {
  if (auth.kind !== 'oauth') throw new Error('This integration does not sign in with OAuth.')
  const rest: IntegrationAuth = { kind: 'oauth', discover: auth.discover, registration: auth.registration }
  return input ? { ...rest, clientId: input.clientId, hasClientSecret: Boolean(input.clientSecret) } : rest
}

/**
 * An integration as the actor reads it, with their role on it (docs/plans/access-model.md
 * §2.7). An integration is personal, so only its owner holds a role on it (§2.3, D3).
 */
function forReader(actor: Actor, integration: Integration): Integration {
  return { ...integration, role: roleOf(actor, { kind: 'integration', id: integration.id, organizationId: integration.organizationId, ownerKey: integration.ownerKey, acl: [] }) }
}

/**
 * Integrations (docs/plans/mcp-integrations.md §12): the remote MCP servers this
 * host knows. Every one is its creator's own: reads take the caller's record
 * scope and answer the caller's records only; a new integration starts in the
 * caller's organization for new records. Every write tells the gateway and sends `integration.changed`.
 */
export function registerIntegrationHandlers(server: SolusServer, deps: {
  store: IntegrationStore
  catalog: IntegrationCatalog
  gateway: IntegrationGateway
  events: HostEventPublisher
  /** Per-person sign-in (§4). Every handler runs in the caller's acting scope, so `currentPersonKey()` is the caller. */
  connectionStore: IntegrationConnectionStore
  connections: IntegrationConnections
  oauth: IntegrationOAuth
  /** Where the owner's OAuth client secret is kept; `oauth` reads it from the same store. */
  clients: Pick<IntegrationClients, 'saveClient' | 'removeClient'>
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
  const { store, catalog, gateway, events, connectionStore, connections, oauth, clients } = deps
  const requireIntegration = (id: string, actor: Actor) => {
    const integration = store.get(id, recordScopeOf(actor.principal))
    if (!integration || forReader(actor, integration).role !== 'owner') throw new Error('That integration is no longer on this host.')
    return integration
  }

  server.register('integrationCatalogList', (args) => catalog.list(integrationCatalogListRequestSchema.parse(args[0] ?? {})))

  server.register('integrationProbe', (args) => probeAddress(integrationProbeRequestSchema.parse(args[0]).url))

  server.register('integrationList', (_args, ctx) => store.list(recordScopeOf(ctx.principal), ownerKeyOf(ctx.actor)).map((integration) => forReader(ctx.actor, integration)))

  server.register('integrationGet', (args, ctx) => {
    const integration = store.getOwned(integrationIdRequestSchema.parse(args[0]).id, recordScopeOf(ctx.principal), ownerKeyOf(ctx.actor))
    return integration && forReader(ctx.actor, integration)
  })

  server.register('integrationCreate', async (args, ctx) => {
    const request = integrationCreateRequestSchema.parse(args[0])
    // A server is its creator's own, on every host (D3); the host's own work adds none.
    const owner = ownerKeyOf(ctx.actor)
    if (owner === null) throw new Error('An integration belongs to a person, and this connection acts for none.')
    return forReader(ctx.actor, await createIntegration({ store, events, profile: deps.profile }, ctx.principal, owner, request))
  })

  server.register('integrationUpdate', async (args, ctx) => {
    const { id, name, url, oauthClient, disabledTools } = integrationUpdateRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    const existing = requireIntegration(id, ctx.actor)
    let auth = url !== undefined && url !== existing.url ? (await probeForWrite(url)).auth : undefined
    if (oauthClient !== undefined) {
      auth = withOAuthClient(auth ?? existing.auth, oauthClient)
      if (oauthClient === null) clients.removeClient(id)
      else {
        const { clientId, clientSecret } = oauthClient
        clients.saveClient(id, clientSecret
          ? { clientId, clientSecret, tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] }
          : { clientId, tokenEndpointAuthMethod: 'none', redirectUris: [] })
      }
    }
    const integration = store.update(id, { name, url, auth, disabledTools }, scope)
    if (!integration) throw new Error('That integration is no longer on this host.')
    // Turning tools on or off keeps the upstream session: the filter is on the record.
    if (name !== undefined || url !== undefined || oauthClient !== undefined) gateway.invalidate(id)
    void events.broadcast('integration.changed', { integrationId: id, change: 'updated' })
    void deps.profile?.saved(ctx.principal, integration)
    return forReader(ctx.actor, integration)
  })

  server.register('integrationRemove', async (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    const scope = recordScopeOf(ctx.principal)
    const integration = store.getOwned(id, scope, ownerKeyOf(ctx.actor))
    if (!integration) return { removed: false }
    // It leaves the caller's profile first, so no host's next pull brings it back.
    await deps.profile?.removing(ctx.principal, integration)
    gateway.invalidate(id)
    const removed = store.remove(id, scope)
    if (removed) connections.removeAllFor(integration)
    if (removed) void events.broadcast('integration.changed', { integrationId: id, change: 'removed' })
    return { removed }
  })

  server.register('integrationTools', (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    requireIntegration(id, ctx.actor)
    return gateway.tools(id)
  })

  server.register('integrationConnectionList', () => {
    const personKey = currentPersonKey()
    return personKey === null ? [] : connectionStore.list(personKey)
  })

  /**
   * The probe saw a registration endpoint, but the sign-in found the server
   * will not register Solus. The record says so now, so every client shows the
   * client form and "Set up with an agent" instead of a sign-in that cannot work.
   */
  function needsOwnerClient(integration: Integration): void {
    if (integration.auth.kind !== 'oauth' || integration.auth.registration === 'client-required') return
    store.update(integration.id, { auth: { ...integration.auth, registration: 'client-required' } }, integration.organizationId)
    log.info('integration_registration_refused', { integrationId: integration.id })
    void events.broadcast('integration.changed', { integrationId: integration.id, change: 'updated' })
  }

  server.register('integrationConnectStart', async (args, ctx) => {
    const request = integrationConnectStartRequestSchema.parse(args[0])
    const integration = requireIntegration(request.id, ctx.actor)
    const user = requirePersonKey()
    // One more account gets a name of its own, or the one its waiting sign-in has; it lives on this host (§13.3).
    const accountId = request.newAccount
      ? oauth.pendingAddedAccount(integration.id, user) ?? randomUUID().slice(0, 12)
      : request.accountId ?? DEFAULT_INTEGRATION_ACCOUNT
    switch (integration.auth.kind) {
      case 'none':
        return { kind: 'connected' as const, connection: connections.connectAnonymous(integration, user) }
      case 'bearer':
        return { kind: 'token' as const, integrationId: integration.id, accountId }
      case 'oauth': {
        // The person's Solus GitHub connection is the credential: no sign-in here (§13.1).
        if (new IntegrationSignIn(integration).usesSolusGithub) {
          // That connection is one GitHub account, so there is no other to add.
          if (accountId !== DEFAULT_INTEGRATION_ACCOUNT) throw new Error(`${integration.name} uses your Solus GitHub connection, which is one GitHub account.`)
          return { kind: 'connected' as const, connection: await connections.connectFirstParty(integration, user) }
        }
        const { host, port } = deps.getServerInfo()
        try {
          return await oauth.start(integration, { callbackBaseUrl: request.callbackBaseUrl, fallbackHost: host, fallbackPort: port }, accountId)
        } catch (error) {
          if (error instanceof OAuthClientRequiredError) needsOwnerClient(integration)
          throw error
        }
      }
    }
  })

  server.register('integrationConnectSubmit', async (args, ctx) => {
    const request = integrationConnectSubmitRequestSchema.parse(args[0])
    if (request.flowId !== undefined) {
      await oauth.submitRedirect(request.flowId, request.value)
    } else if (request.id !== undefined) {
      await connections.submitKey(requireIntegration(request.id, ctx.actor), requirePersonKey(), request.value, request.accountId)
    }
    return { submitted: true as const }
  })

  server.register('integrationConnectCancel', (args) => ({ cancelled: oauth.cancel(integrationConnectCancelRequestSchema.parse(args[0]).flowId) }))

  server.register('integrationDisconnect', async (args, ctx) => {
    const { id, accountId } = integrationAccountRequestSchema.parse(args[0])
    return { disconnected: await connections.disconnect(requireIntegration(id, ctx.actor), requirePersonKey(), accountId) }
  })
}
