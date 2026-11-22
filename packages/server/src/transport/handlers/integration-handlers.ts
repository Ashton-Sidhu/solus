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
  type IntegrationUpdateRequest,
  type IntegrationAuth,
  integrationFoundAddRequestSchema,
  integrationFoundChangeRequestSchema,
  integrationDiscoverRequestSchema,
  integrationFoundListRequestSchema,
  integrationFoundTestRequestSchema,
  type IntegrationFacts,
  type IntegrationResourceLists,
} from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { integrationPromptGetRequestSchema, integrationPromptListRequestSchema } from '@solus/contracts/integrations/prompts'
import { OAuthClientRequiredError } from '@solus/contracts/integrations/oauth-protocol'
import { roleOf } from '../../admission/access'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { recordScopeOf, type Principal } from '../../admission/principal'
import type { IntegrationCatalog } from '../../integrations/catalog'
import type { IntegrationConnectionStore } from '../../integrations/connection-store'
import type { IntegrationConnections } from '../../integrations/connections'
import type { IntegrationGateway } from '../../integrations/gateway'
import type { IntegrationStore } from '../../integrations/integration-store'
import type { IntegrationOAuth } from '../../integrations/oauth'
import { chosenAuth, probeAddress, probeForWrite, type IntegrationWrites, type IntegrationWritesDeps } from '../../integrations/integration-create'
import { integrationPromptList, integrationPromptText } from '../../integrations/integration-prompts'
import { COMMAND_CHANGE_REFUSAL, mayRunCommands } from '../../integrations/command-admission'
import type { FoundServers } from '../../integrations/found-servers'
import { discoverMcpServers } from '../../integrations/discovery'
import type { ReachRequest, RemoteHost, RemoteHosts } from '../../execution/orchestration/remote-hosts'
import type { LocalMcpServers } from '../../integrations/local-servers'
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

/**
 * A server's auth after a new address, scopes, or header names; undefined when
 * none changes it. A new address is probed again. Headers are the person's
 * choice, not the probe's, so a new address keeps them and only has to be
 * reached; an `oauth` server keeps the scopes the person chose.
 */
async function serverAuthAfter(existing: Integration, request: Pick<IntegrationUpdateRequest, 'url' | 'scopes' | 'headerNames'>, oauth: IntegrationWritesDeps['oauth']): Promise<IntegrationAuth | undefined> {
  const { url, scopes, headerNames } = request
  let auth: IntegrationAuth | undefined
  if (url !== undefined && url !== existing.url) {
    auth = existing.auth.kind === 'headers' ? await chosenAuth(url, existing.auth, oauth) : (await probeForWrite(url)).auth
    if (auth.kind === 'oauth' && existing.auth.kind === 'oauth' && existing.auth.scopes) auth.scopes = existing.auth.scopes
  }
  if (scopes !== undefined) {
    const current = auth ?? existing.auth
    if (current.kind !== 'oauth') throw new Error(`${existing.name} does not sign in with OAuth, so it takes no scopes.`)
    const { scopes: _previous, ...rest } = current
    auth = scopes ? { ...rest, scopes } : rest
  }
  if (headerNames !== undefined) {
    if ((auth ?? existing.auth).kind !== 'headers') throw new Error(`${existing.name} does not take headers.`)
    auth = { kind: 'headers', names: headerNames }
  }
  return auth
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
  /** Per-person sign-in, and the owner's OAuth client with its secret. */
  oauth: IntegrationOAuth
  getServerInfo(): { host: string; port: number }
  /** The one writer of integration records; Found writes through the same one. */
  writes: IntegrationWrites
  /** The MCP servers in this host's config files (docs/plans/mcp-first-class.md §8). */
  found: FoundServers
  /** The other hosts this host reaches for a caller, for the found servers of each (§8.9). Absent: this host only. */
  remote?: { hosts: Pick<RemoteHosts, 'list' | 'connect' | 'connectTo'>; reachOf(principal: Principal): ReachRequest | null }
  /** This host's name, for its group of discovered servers. */
  hostLabel?(): string
  /** Whether a server on this host's loopback runs (§9.3). Absent where the host does not follow its running servers. */
  local?: Pick<LocalMcpServers, 'reachable'>
  /**
   * The caller's agent profile (plans/020-agent-profile.md): signed in, the
   * caller's own servers are part of it, so a removal here leaves their account
   * and every host follows. `writes` tells it of a save. Absent where no profile applies.
   */
  profile?: { removing(principal: Principal, integration: Integration): Promise<void> }
}): void {
  const { store, catalog, gateway, events, connectionStore, connections, oauth, writes } = deps
  /** The caller's connection to another of their hosts, reached as `start_sessions` reaches it. */
  const remoteHostFor = async (principal: Principal, hostId: string): Promise<RemoteHost> => {
    const reach = deps.remote?.reachOf(principal)
    if (!deps.remote || !reach) throw new Error('This host reaches no other host for you.')
    const remote = await deps.remote.hosts.connectTo(reach, hostId)
    if ('error' in remote) throw new Error(remote.error)
    return remote
  }
  const requireIntegration = (id: string, actor: Actor) => {
    const integration = store.get(id, recordScopeOf(actor.principal))
    if (!integration || forReader(actor, integration).role !== 'owner') throw new Error('That integration is no longer on this host.')
    return integration
  }

  server.register('integrationCatalogList', (args) => catalog.list(integrationCatalogListRequestSchema.parse(args[0] ?? {})))

  server.register('integrationProbe', (args) => probeAddress(integrationProbeRequestSchema.parse(args[0]).url))

  server.register('integrationList', (_args, ctx) => {
    const integrations = store.list(recordScopeOf(ctx.principal), ownerKeyOf(ctx.actor))
    void clearClientDocumentMarks(integrations)
    return integrations.map((integration) => forReader(ctx.actor, integration))
  })

  server.register('integrationGet', (args, ctx) => {
    const integration = store.getOwned(integrationIdRequestSchema.parse(args[0]).id, recordScopeOf(ctx.principal), ownerKeyOf(ctx.actor))
    return integration && forReader(ctx.actor, integration)
  })

  server.register('integrationCreate', async (args, ctx) => {
    const request = integrationCreateRequestSchema.parse(args[0])
    // A server is its creator's own, on every host (D3); the host's own work adds none.
    const owner = ownerKeyOf(ctx.actor)
    if (owner === null) throw new Error('An integration belongs to a person, and this connection acts for none.')
    if ('url' in request) return forReader(ctx.actor, await writes.addServer(ctx.principal, owner, request))
    requireHostAdmin(ctx.principal)
    return forReader(ctx.actor, writes.addCommand(ctx.principal, owner, request))
  })

  server.register('integrationUpdate', async (args, ctx) => {
    const request = integrationUpdateRequestSchema.parse(args[0])
    const { id, name, url, oauthClient, disabledTools } = request
    const existing = requireIntegration(id, ctx.actor)
    const commandChanged = request.launch !== undefined || request.envNames !== undefined
    const serverChanged = url !== undefined || oauthClient !== undefined || request.scopes !== undefined || request.headerNames !== undefined
    if (existing.kind === 'stdio' ? serverChanged : commandChanged) throw new Error(`${existing.name} cannot take that change: a command has a launch and names, a server an address.`)
    if (commandChanged) return forReader(ctx.actor, writes.changeCommand(existing, request, ctx.principal))
    let auth = await serverAuthAfter(existing, request, oauth)
    if (oauthClient !== undefined) auth = await oauth.withOwnerClient({ ...existing, auth: auth ?? existing.auth }, oauthClient)
    return forReader(ctx.actor, writes.changeServer(existing, { name, url, auth, disabledTools }, ctx.principal))
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
    const integration = requireIntegration(id, ctx.actor)
    const reachable = deps.local?.reachable(integration)
    let facts: IntegrationFacts
    try {
      facts = await gateway.facts(id)
    } catch (error) {
      // Nothing listens on its port: the row says Not running, not the refused connection (§9.3).
      if (reachable !== 'not-running') throw error
      facts = { era: null, instructions: null, capabilities: { prompts: false, resources: false, resourceSubscribe: false, tasks: false } }
    }
    const cliSkips = cliSkipLog.for(id, currentPersonKey())
    if (cliSkips.length) facts = { ...facts, cliSkips }
    return reachable ? { ...facts, reachable } : facts
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

  // This host and each other host it reaches for the caller; each list comes as an event to this client (§8.9).
  server.register('integrationDiscover', (args, ctx) => {
    const request = integrationDiscoverRequestSchema.parse(args[0])
    if (request.projectPath) assertPathInScope('integrationDiscover', ctx.principal, request.projectPath)
    return discoverMcpServers({
      discoveryId: request.discoveryId,
      selfLabel: deps.hostLabel?.() ?? 'This host',
      refresh: request.refresh === true,
      local: () => deps.found.list(ctx.principal, ownerKeyOf(ctx.actor), { projectPath: request.projectPath, refresh: request.refresh }),
      hosts: deps.remote?.hosts ?? { list: async () => [], connect: () => ({ error: 'This host reaches no other host.' }) },
      reach: deps.remote?.reachOf(ctx.principal) ?? null,
      publish: (event) => void events.publish(ctx.clientId, 'integration.discovered', event),
    })
  })

  // An action on another host goes there through this one, as the caller; a project is a path here, so it does not go (§8.9).
  server.register('integrationFoundAdd', async (args, ctx) => {
    const request = integrationFoundAddRequestSchema.parse(args[0])
    if (request.hostId) {
      const remote = await remoteHostFor(ctx.principal, request.hostId)
      return remote.call('the add', () => remote.api.integrationFoundAdd({ foundId: request.foundId, fingerprint: request.fingerprint, useFileValues: request.useFileValues }))
    }
    if (request.projectPath) assertPathInScope('integrationFoundAdd', ctx.principal, request.projectPath)
    const owner = ownerKeyOf(ctx.actor)
    if (owner === null) throw new Error('An integration belongs to a person, and this connection acts for none.')
    const result = await deps.found.add(ctx.principal, owner, request)
    return result.kind === 'saved' ? { ...result, integration: forReader(ctx.actor, result.integration) } : result
  })

  // A test and a change of a found server (mcp-first-class.md §8.8): `host.admin` at the door.
  server.register('integrationFoundTest', async (args, ctx) => {
    const request = integrationFoundTestRequestSchema.parse(args[0])
    if (request.hostId) {
      const remote = await remoteHostFor(ctx.principal, request.hostId)
      return remote.call('the test', () => remote.api.integrationFoundTest({ foundId: request.foundId, fingerprint: request.fingerprint }))
    }
    if (request.projectPath) assertPathInScope('integrationFoundTest', ctx.principal, request.projectPath)
    return deps.found.test(ctx.principal, request)
  })

  server.register('integrationFoundChange', async (args, ctx) => {
    const request = integrationFoundChangeRequestSchema.parse(args[0])
    if (request.hostId) {
      const remote = await remoteHostFor(ctx.principal, request.hostId)
      return remote.call('the change', () => remote.api.integrationFoundChange({ foundId: request.foundId, fingerprint: request.fingerprint, place: request.place, change: request.change }))
    }
    if (request.projectPath) assertPathInScope('integrationFoundChange', ctx.principal, request.projectPath)
    return deps.found.change(ctx.principal, request)
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
  async function needsOwnerClient(integration: Integration): Promise<void> {
    if (integration.auth.kind !== 'oauth' || integration.auth.registration === 'client-required') return
    // A server that reads Client ID Metadata Documents refused because Solus's is not confirmed yet: the mark is taken back with it.
    const awaitsClientDocument = integration.auth.registration === 'metadata-document' && !(await oauth.clientDocumentConfirmed())
    const auth: IntegrationAuth = { ...integration.auth, registration: 'client-required' }
    if (awaitsClientDocument) auth.awaitsClientDocument = true
    store.update(integration.id, { auth }, integration.organizationId)
    log.info('integration_registration_refused', { integrationId: integration.id, awaitsClientDocument })
    void events.broadcast('integration.changed', { integrationId: integration.id, change: 'updated' })
  }

  /**
   * The marks made while Solus's Client ID Metadata Document was not confirmed
   * go once the host confirms it: the record reads `metadata-document` again,
   * and every client shows Connect in place of the client form. Read when a
   * person lists their servers, so a deploy of the document reaches the record
   * with no step of theirs; the document's own cache limits the reads.
   */
  async function clearClientDocumentMarks(integrations: Integration[]): Promise<void> {
    const marked = integrations.filter((integration) => integration.auth.kind === 'oauth' && integration.auth.awaitsClientDocument)
    if (marked.length === 0 || !(await oauth.clientDocumentConfirmed())) return
    for (const integration of marked) {
      if (integration.auth.kind !== 'oauth') continue
      const { awaitsClientDocument: _cleared, ...auth } = integration.auth
      store.update(integration.id, { auth: { ...auth, registration: 'metadata-document' } }, integration.organizationId)
      log.info('integration_client_document_confirmed', { integrationId: integration.id })
      void events.broadcast('integration.changed', { integrationId: integration.id, change: 'updated' })
    }
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
      // A server's headers are given as a command's values are: the card asks for one value for each name.
      case 'env':
      case 'headers':
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
          if (error instanceof OAuthClientRequiredError) await needsOwnerClient(integration)
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
      if (request.values !== undefined && integration.auth.kind === 'headers') await connections.submitHeaders(integration, requirePersonKey(), request.values, request.accountId)
      else if (request.values !== undefined) connections.submitEnvironment(integration, requirePersonKey(), request.values, request.accountId)
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
