import { randomUUID } from 'node:crypto'
import { hostForUrl } from '@solus/contracts/entrypoint'
import type {
  Integration,
  IntegrationAuthFinishedEvent,
  IntegrationConnectionChangedEvent,
  IntegrationConnectStartResult,
} from '@solus/contracts/integration-types'
import { McpOAuth, OAuthGrantRefusedError, OAuthSignInError, OAUTH_CLIENT_REQUIRED_MESSAGE, type OAuthClient, type OAuthMetadata, type OAuthToken } from '@solus/contracts/integrations/oauth-protocol'
import { ANY_ORGANIZATION } from '../admission/principal'
import { callbackPage } from '../google/oauth'
import { createLogger } from '../logger'
import { currentPersonKey, requirePersonKey } from '../vault/acting-scope'
import { EncryptionUnavailableError, mcpCredentialRef, type Vault } from '../vault/vault'
import type { IntegrationClients, IntegrationConnectionStore } from './connection-store'
import type { IntegrationStore } from './integration-store'
import { readServerIdentity, ServerCredentialRefusedError } from './server-identity'

/**
 * Per-person OAuth sign-in to an integration (docs/plans/mcp-integrations.md
 * §4.3) on this host. The protocol itself — discovery, registration, PKCE,
 * the grants, revocation — is `@solus/contracts/integrations/oauth-protocol`,
 * shared with Solus Cloud. This class holds what is the host's: the pending
 * flows with the person each started for (the browser's callback names
 * nobody, so the flow decides whose token it becomes), the host's registered
 * client per integration. Each person's token is the vault's.
 */

const log = createLogger('integrations', 'oauth.ts')

export const INTEGRATION_OAUTH_CALLBACK_PATH = '/oauth/integration/callback'
const FLOW_TTL_MS = 10 * 60_000
const EXPIRED_MESSAGE = 'This sign-in expired. Start it again.'

interface PendingFlow {
  flowId: string
  state: string
  integrationId: string
  verifier: string
  redirectUri: string
  url: string
  input: 'callback' | 'redirect-url'
  expiresAt: number
  tokenEndpoint: URL
  resource: string
  client: OAuthClient
  /** Whose connection this becomes (§4.1 rule 1). */
  personKey: string
}

/** Where a person's connection changes are delivered: that person's clients only. */
export interface IntegrationConnectionEvents {
  connectionChanged(personKey: string, event: IntegrationConnectionChangedEvent): void
  authFinished(personKey: string, event: IntegrationAuthFinishedEvent): void
}

export interface IntegrationOAuthStartOptions {
  /** The origin the client reached the host on; absent when the client's browser cannot reach the host. */
  callbackBaseUrl?: string
  fallbackHost: string
  fallbackPort: number
}

export interface IntegrationOAuthCallbackResult {
  status: 200 | 400 | 500
  html: string
}

export interface IntegrationOAuthDeps {
  connections: IntegrationConnectionStore
  integrations: Pick<IntegrationStore, 'get'>
  /** Where a sign-in's token is saved: the person's, on this host. */
  vault: Pick<Vault, 'save'>
  clients: IntegrationClients
  events: IntegrationConnectionEvents
  fetch?: typeof fetch
  now?: () => number
}

type Finish = { ok: true } | { ok: false; status: 400 | 500; title: string; message: string }

function callbackBase(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : null
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 300)
}

/** The metadata address an integration's record names, when it signs in with OAuth. */
export function discoverAddressOf(integration: Integration): string | undefined {
  return integration.auth.kind === 'oauth' ? integration.auth.discover : integration.auth.kind === 'none' ? integration.auth.oauth?.discover : undefined
}

export class IntegrationOAuth {
  private readonly flows = new Map<string, PendingFlow>()
  private readonly refreshing = new Map<string, Promise<OAuthToken | null>>()
  private readonly protocol: McpOAuth
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: IntegrationOAuthDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.protocol = new McpOAuth({ fetch: this.fetch, now: this.now })
  }

  /** Starts the acting person's sign-in, or returns the one they already have open for this integration and callback. */
  async start(integration: Integration, options: IntegrationOAuthStartOptions): Promise<IntegrationConnectStartResult> {
    if (integration.auth.kind !== 'oauth') throw new Error('This integration does not sign in with OAuth.')
    const personKey = requirePersonKey()
    this.dropExpired()
    const base = callbackBase(options.callbackBaseUrl)
    const redirectUri = `${base ?? `http://${hostForUrl(options.fallbackHost)}:${options.fallbackPort}`}${INTEGRATION_OAUTH_CALLBACK_PATH}`
    for (const [state, flow] of this.flows) {
      if (flow.integrationId !== integration.id || flow.personKey !== personKey) continue
      if (flow.redirectUri === redirectUri) return waiting(flow)
      // One flow per person and integration: a start from another origin replaces it.
      this.flows.delete(state)
    }
    let metadata: OAuthMetadata
    let client: OAuthClient
    try {
      metadata = await this.metadata(integration)
      client = await this.clientFor(integration, metadata, redirectUri)
    } catch (error) {
      log.warn('integration_oauth_start_failed', { integrationId: integration.id, error: errorText(error) })
      throw error
    }
    const { url, state, verifier } = await this.protocol.authorization({ metadata, client, redirectUri, resource: integration.url })
    const flow: PendingFlow = {
      flowId: randomUUID(),
      state,
      integrationId: integration.id,
      verifier,
      redirectUri,
      url,
      input: base ? 'callback' : 'redirect-url',
      expiresAt: this.now() + FLOW_TTL_MS,
      tokenEndpoint: metadata.tokenEndpoint,
      resource: integration.url,
      client,
      personKey,
    }
    this.flows.set(state, flow)
    log.info('integration_oauth_started', { integrationId: integration.id, flowId: flow.flowId, input: flow.input })
    return waiting(flow)
  }

  /** The browser's callback on `/oauth/integration/callback`. It carries no principal: the flow named by `state` decides whose token it is. */
  async complete(params: URLSearchParams): Promise<IntegrationOAuthCallbackResult> {
    const state = params.get('state')
    const flow = state ? this.flows.get(state) : undefined
    if (!flow) return callbackPage(400, 'Sign-in expired', 'Return to Solus and start the sign-in again.')
    const result = await this.finish(flow, params)
    return result.ok ? callbackPage(200, "You're connected", 'Return to Solus to continue.') : callbackPage(result.status, result.title, result.message)
  }

  /** The address the browser ended on, pasted by the person who started the flow. Finishes the same as a callback; throws a plain message. */
  async submitRedirect(flowId: string, pasted: string): Promise<void> {
    const flow = this.ownFlow(flowId)
    if (!flow) throw new Error(EXPIRED_MESSAGE)
    if (!URL.canParse(pasted)) throw new Error('Paste the whole address the browser ended on.')
    const params = new URL(pasted).searchParams
    if (params.get('state') !== flow.state) throw new Error('That address belongs to another sign-in. Paste the address this sign-in ended on.')
    const result = await this.finish(flow, params)
    if (!result.ok) throw new Error(result.message)
  }

  cancel(flowId: string): boolean {
    const flow = this.ownFlow(flowId)
    if (!flow) return false
    this.flows.delete(flow.state)
    this.deps.events.authFinished(flow.personKey, { flowId, integrationId: flow.integrationId, outcome: 'cancelled' })
    return true
  }

  /**
   * The person's token from the vault, refreshed first when it has under a
   * minute left. Null when a refresh failed; a refused refresh marks the
   * connection `needs-sign-in`.
   */
  refreshIfDue(integrationId: string, personKey: string, token: OAuthToken): Promise<OAuthToken | null> {
    if (!this.protocol.isRefreshDue(token)) return Promise.resolve(token)
    if (!token.refreshToken) {
      this.record(integrationId, personKey, 'needs-sign-in', 'The sign-in expired. Sign in again.')
      return Promise.resolve(null)
    }
    const key = `${integrationId}\u0000${personKey}`
    const pending = this.refreshing.get(key)
    if (pending) return pending
    const refreshed = this.refresh(integrationId, personKey, token, token.refreshToken).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refreshed)
    return refreshed
  }

  /** Revokes a token at the server when its metadata names a revocation endpoint. Best effort: a failure is logged. */
  async revoke(integration: Integration, token: OAuthToken): Promise<void> {
    try {
      const status = await this.protocol.revoke(await this.metadata(integration), this.clientForToken(integration.id, token), token)
      if (status !== null) log.info('integration_token_revoked', { integrationId: integration.id, status })
    } catch (error) {
      log.warn('integration_token_revoke_failed', { integrationId: integration.id, error: errorText(error) })
    }
  }

  /** The token endpoint of an integration, discovered when needed. */
  async tokenEndpointOf(integration: Integration): Promise<URL> {
    return (await this.metadata(integration)).tokenEndpoint
  }

  /** The client that issued a token: the saved one when it is the same, else a public client by its ID. */
  clientForToken(integrationId: string, token: OAuthToken): OAuthClient {
    const saved = this.deps.clients.client(integrationId)
    if (saved && (!token.clientId || saved.clientId === token.clientId)) return saved
    if (!token.clientId) throw new Error('the token names no client')
    return { clientId: token.clientId }
  }

  private ownFlow(flowId: string): PendingFlow | undefined {
    const personKey = currentPersonKey()
    return [...this.flows.values()].find((flow) => flow.flowId === flowId && flow.personKey === personKey)
  }

  private dropExpired(): void {
    const now = this.now()
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt < now) this.flows.delete(state)
    }
  }

  private async finish(flow: PendingFlow, params: URLSearchParams): Promise<Finish> {
    this.flows.delete(flow.state)
    const { flowId, integrationId } = flow
    const user = flow.personKey
    const failed = (status: 400 | 500, title: string, message: string): Finish => {
      this.deps.events.authFinished(user, { flowId, integrationId, outcome: 'failed', message })
      return { ok: false, status, title, message }
    }
    if (this.now() > flow.expiresAt) return failed(400, 'Sign-in expired', EXPIRED_MESSAGE)
    if (params.get('error')) {
      const message = 'The sign-in was cancelled.'
      this.deps.events.authFinished(user, { flowId, integrationId, outcome: 'cancelled', message })
      return { ok: false, status: 400, title: 'Sign-in cancelled', message }
    }
    const code = params.get('code')
    if (!code) return failed(400, 'Sign-in failed', 'The server did not return a code. Start the sign-in again.')
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return failed(400, 'Sign-in failed', 'That integration is no longer on this host.')
    try {
      const token = await this.protocol.exchange({ tokenEndpoint: flow.tokenEndpoint, client: flow.client, code, redirectUri: flow.redirectUri, verifier: flow.verifier, resource: flow.resource })
      const identity = await readServerIdentity(integration.url, `Bearer ${token.accessToken}`, this.fetch)
      this.deps.vault.save(user, mcpCredentialRef(integration), token)
      const connection = this.deps.connections.upsert(integrationId, user, {
        status: 'connected',
        label: identity.label,
        info: identity.label ? { displayName: identity.label } : null,
        error: null,
      })
      this.deps.events.connectionChanged(user, { integrationId, connection })
      this.deps.events.authFinished(user, { flowId, integrationId, outcome: 'connected' })
      log.info('integration_oauth_connected', { integrationId, flowId, personKey: user })
      return { ok: true }
    } catch (error) {
      log.warn('integration_oauth_failed', { integrationId, flowId, error: errorText(error) })
      const plain = error instanceof OAuthSignInError || error instanceof EncryptionUnavailableError || error instanceof ServerCredentialRefusedError
      return failed(500, 'Sign-in failed', plain ? error.message : 'Return to Solus and start the sign-in again.')
    }
  }

  private async refresh(integrationId: string, personKey: string, token: OAuthToken, refreshToken: string): Promise<OAuthToken | null> {
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return null
    try {
      const metadata = await this.metadata(integration)
      const refreshed = await this.protocol.refresh({ tokenEndpoint: metadata.tokenEndpoint, client: this.clientForToken(integrationId, token), refreshToken, resource: integration.url })
      try {
        this.deps.vault.save(personKey, mcpCredentialRef(integration), refreshed)
      } catch (error) {
        // A refresh cannot ask anyone; the token in hand still works for this call.
        log.warn('integration_token_persist_failed', { integrationId, error: errorText(error) })
      }
      log.info('integration_token_refreshed', { integrationId, personKey })
      return refreshed
    } catch (error) {
      log.warn('integration_token_refresh_failed', { integrationId, personKey, error: errorText(error) })
      // A refused grant needs the person; an unreachable server is tried again on the next call.
      if (error instanceof OAuthGrantRefusedError) this.record(integrationId, personKey, 'needs-sign-in', 'The server ended the sign-in. Sign in again.')
      else this.record(integrationId, personKey, 'error', 'Solus could not renew the sign-in. It tries again on the next call.')
      return null
    }
  }

  private metadata(integration: Integration): Promise<OAuthMetadata> {
    const discover = discoverAddressOf(integration)
    if (!discover) return Promise.reject(new OAuthSignInError('This integration does not sign in with OAuth.'))
    return this.protocol.discover(discover)
  }

  /**
   * A saved client registered for this callback, else the owner's client (with
   * its saved secret and token-endpoint method), else a new registration, else a
   * plain refusal. The owner registered their redirect addresses at the server
   * themselves, so their client is not checked against this one.
   */
  private async clientFor(integration: Integration, metadata: OAuthMetadata, redirectUri: string): Promise<OAuthClient> {
    const saved = this.deps.clients.client(integration.id)
    if (saved?.redirectUris?.includes(redirectUri)) return saved
    const adminClientId = integration.auth.kind === 'oauth' ? integration.auth.clientId : undefined
    if (adminClientId) return saved?.clientId === adminClientId ? saved : { clientId: adminClientId }
    if (!metadata.registrationEndpoint) throw new OAuthSignInError(OAUTH_CLIENT_REQUIRED_MESSAGE)
    try {
      const client = await this.protocol.register(metadata, [...(saved?.redirectUris ?? []), redirectUri])
      this.deps.clients.saveClient(integration.id, client)
      log.info('integration_client_registered', { integrationId: integration.id })
      return client
    } catch (error) {
      log.warn('integration_client_registration_failed', { integrationId: integration.id, error: errorText(error) })
      throw error
    }
  }

  private record(integrationId: string, personKey: string, status: 'needs-sign-in' | 'error', error: string): void {
    const connection = this.deps.connections.upsert(integrationId, personKey, { status, error })
    this.deps.events.connectionChanged(personKey, { integrationId, connection })
  }
}

function waiting(flow: PendingFlow): IntegrationConnectStartResult {
  return { kind: 'waiting', flowId: flow.flowId, url: flow.url, input: flow.input, expiresAt: new Date(flow.expiresAt).toISOString() }
}
