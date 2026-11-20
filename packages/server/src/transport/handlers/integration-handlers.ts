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
  integrationProcessStartRequestSchema,
  integrationResourceAttachRequestSchema,
  integrationResourceListRequestSchema,
  integrationUpdateRequestSchema,
  type Integration,
  type IntegrationAuth,
  integrationFoundAddRequestSchema,
  integrationFoundListRequestSchema,
  type IntegrationResourceLists,
  type IntegrationOAuthClientInput,
} from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { integrationPromptGetRequestSchema, integrationPromptListRequestSchema } from '@solus/contracts/integrations/prompts'
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
import { createIntegration, createStdioIntegration, probeAddress, probeForWrite, updateCommand } from '../../integrations/integration-create'
import { integrationPromptList, integrationPromptText } from '../../integrations/integration-prompts'
import { COMMAND_CHANGE_REFUSAL, mayRunCommands } from '../../integrations/command-admission'
import type { FoundServers } from '../../integrations/found-servers'
import { assertPathInScope } from '../../data/sessions/guest-path-scope'
import { cliSkipLog } from '../../integrations/cli-skips'
import { attachResource } from '../../integrations/resource-attach'
import { resourceListsOf } from '../../integrations/resource-lists'
import { RUN_LIST_TIMEOUT_MS, integrationsForRun } from '../../integrations/integration-tools'
import { uploadBucketId } from './attachment-handlers'
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
 * A command runs as code on the host, as the OS user of the Solus server: only
 * a person with `host.admin` adds one or changes its command or names
 * (docs/plans/mcp-first-class.md §7.2). The gateway checks the same rule at a
 * start (`command-admission.ts`).
 */
function requireHostAdmin(principal: Principal): void {
  if (!mayRunCommands(principal)) throw new Error(COMMAND_CHANGE_REFUSAL)
}

function requireStdio(integration: Integration): void {
  if (integration.kind !== 'stdio') throw new Error(`${integration.name} is not a command.`)
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
  /** The MCP servers in this host's config files (docs/plans/mcp-first-class.md §8). */
  found: FoundServers
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
    if ('url' in request) return forReader(ctx.actor, await createIntegration({ store, events, profile: deps.profile }, ctx.principal, owner, request))
    requireHostAdmin(ctx.principal)
    return forReader(ctx.actor, createStdioIntegration({ store, events }, ctx.principal, owner, request))
  })

  server.register('integrationUpdate', async (args, ctx) => {
    const request = integrationUpdateRequestSchema.parse(args[0])
    const { id, name, url, oauthClient, disabledTools } = request
    const scope = recordScopeOf(ctx.principal)
    const existing = requireIntegration(id, ctx.actor)
    const commandChanged = request.launch !== undefined || request.envNames !== undefined
    if (existing.kind === 'stdio' ? url !== undefined || oauthClient !== undefined : commandChanged) throw new Error(`${existing.name} cannot take that change: a command has a launch and names, a server an address.`)
    if (commandChanged) return forReader(ctx.actor, updateCommand({ store, events, gateway, connections }, existing, request, ctx.principal))
    let auth: IntegrationAuth | undefined = url !== undefined && url !== existing.url ? (await probeForWrite(url)).auth : undefined
    if (oauthClient !== undefined) {
      auth = withOAuthClient(auth ?? existing.auth, oauthClient)
      if (oauthClient === null) clients.removeClient(id)
      else {
        const { clientId, clientSecret } = oauthClient
        const issuer = await oauth.issuerOf({ ...existing, auth: auth ?? existing.auth, url: url ?? existing.url })
        clients.saveClient(id, issuer, clientSecret
          ? { clientId, clientSecret, tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] }
          : { clientId, tokenEndpointAuthMethod: 'none', redirectUris: [] })
      }
    }
    const integration = store.update(id, { name, url, auth, disabledTools }, scope)
    if (!integration) throw new Error('That integration is no longer on this host.')
    // Turning tools on or off keeps the upstream session: the filter is on the record.
    if (name !== undefined || url !== undefined || oauthClient !== undefined) gateway.invalidate(id)
    // Every tool off, or a new address, can give the CLI its copy back at the next run (§8.5).
    cliSkipLog.forget(id)
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
    // A command's process stops, and its saved facts go (§7.7). The next run gives the CLI its copy back (§8.5).
    gateway.forget(id)
    cliSkipLog.forget(id)
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

  server.register('integrationFacts', async (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    requireIntegration(id, ctx.actor)
    const facts = await gateway.facts(id)
    const cliSkips = cliSkipLog.for(id, currentPersonKey())
    return cliSkips.length ? { ...facts, cliSkips } : facts
  })

  server.register('integrationProcessStart', async (args, ctx) => {
    const { id, recheck } = integrationProcessStartRequestSchema.parse(args[0])
    const integration = requireIntegration(id, ctx.actor)
    requireStdio(integration)
    return gateway.startProcess(id, ctx.principal, recheck)
  })

  server.register('integrationProcessStop', async (args, ctx) => {
    const { id } = integrationIdRequestSchema.parse(args[0])
    requireStdio(requireIntegration(id, ctx.actor))
    return { stopped: await gateway.stopProcess(id) }
  })

  // Found servers (docs/plans/mcp-first-class.md §8): a project's files only where the caller may read that project.
  server.register('integrationFoundList', (args, ctx) => {
    const request = integrationFoundListRequestSchema.parse(args[0] ?? {})
    if (request.projectPath) assertPathInScope('integrationFoundList', ctx.principal, request.projectPath)
    return deps.found.list(ctx.principal, ownerKeyOf(ctx.actor), request)
  })

  server.register('integrationFoundAdd', async (args, ctx) => {
    const request = integrationFoundAddRequestSchema.parse(args[0])
    if (request.projectPath) assertPathInScope('integrationFoundAdd', ctx.principal, request.projectPath)
    const owner = ownerKeyOf(ctx.actor)
    if (owner === null) throw new Error('An integration belongs to a person, and this connection acts for none.')
    const result = await deps.found.add(ctx.principal, owner, request)
    return result.kind === 'saved' ? { kind: 'saved' as const, integration: forReader(ctx.actor, result.integration) } : result
  })

  // MCP prompts as slash commands (mcp-first-class.md §10): the caller's own servers, with the caller's connection.
  server.register('integrationPromptList', (args, ctx) => {
    const { projectPath } = integrationPromptListRequestSchema.parse(args[0] ?? {})
    return integrationPromptList(gateway, ctx.actor, projectPath)
  })

  server.register('integrationPromptGet', (args, ctx) => {
    const request = integrationPromptGetRequestSchema.parse(args[0])
    return integrationPromptText(gateway, ctx.actor, requireIntegration(request.integrationId, ctx.actor), request)
  })

  /**
   * The caller's MCP resources (§11.4): of one integration, or of each one that
   * joins a run in `projectPath`. A server that does not answer in 10 seconds,
   * or fails, is left out. A list starts no command.
   */
  server.register('integrationResourceList', async (args, ctx): Promise<IntegrationResourceLists> => {
    const request = integrationResourceListRequestSchema.parse(args[0] ?? {})
    const integrations = request.integrationId ? [requireIntegration(request.integrationId, ctx.actor)] : integrationsForRun(deps, ctx.actor, request.projectPath)
    const personKey = currentPersonKey()
    const answers = await Promise.all(integrations.map(async (integration) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RUN_LIST_TIMEOUT_MS) })
      try {
        const lists = await Promise.race([gateway.resourcesFor(integration.id, personKey, null), late])
        return lists && resourceListsOf(integration.id, lists)
      } catch (error) {
        log.info('integration_resources_unavailable', { integrationId: integration.id, error: error instanceof Error ? error.message : String(error) })
        return null
      } finally {
        clearTimeout(timer)
      }
    }))
    return {
      resources: answers.flatMap((answer) => answer?.resources ?? []),
      templates: answers.flatMap((answer) => answer?.templates ?? []),
    }
  })

  server.register('integrationResourceAttach', async (args, ctx) => {
    const [ipc, raw] = args
    const bucketId = uploadBucketId(ipc)
    if (!bucketId) throw new Error('A conversation is required to attach a resource.')
    const request = integrationResourceAttachRequestSchema.parse(raw)
    const integration = requireIntegration(request.integrationId, ctx.actor)
    return attachResource({ gateway, integration, request, starter: ctx.principal, bucketId, sessionId: ipc?.session?.sessionId || undefined })
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
      case 'env':
        return { kind: 'env' as const, integrationId: integration.id, accountId, names: integration.auth.names }
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
      if (request.value === undefined) throw new Error('Give the address the browser ended on.')
      await oauth.submitRedirect(request.flowId, request.value)
    } else if (request.id !== undefined) {
      const integration = requireIntegration(request.id, ctx.actor)
      if (request.values !== undefined) connections.submitEnvironment(integration, requirePersonKey(), request.values, request.accountId)
      else if (request.value !== undefined) await connections.submitKey(integration, requirePersonKey(), request.value, request.accountId)
    }
    return { submitted: true as const }
  })

  server.register('integrationConnectCancel', (args) => ({ cancelled: oauth.cancel(integrationConnectCancelRequestSchema.parse(args[0]).flowId) }))

  server.register('integrationDisconnect', async (args, ctx) => {
    const { id, accountId } = integrationAccountRequestSchema.parse(args[0])
    return { disconnected: await connections.disconnect(requireIntegration(id, ctx.actor), requirePersonKey(), accountId) }
  })
}
