import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hostForUrl } from '@solus/contracts/entrypoint'
import type {
  Integration,
  IntegrationAuthFinishedEvent,
  IntegrationConnectionChangedEvent,
  IntegrationConnectStartResult,
} from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import { callbackPage } from '../google/oauth'
import { createLogger } from '../logger'
import { currentCredentialUserId, requireActingScope, type ActingScope } from '../vault/acting-scope'
import { EncryptionUnavailableError } from '../vault/provider-credentials'
import type { IntegrationClient, IntegrationConnectionStore, IntegrationSecrets, IntegrationToken } from './connection-store'
import type { IntegrationStore } from './integration-store'
import { readServerIdentity, ServerCredentialRefusedError } from './server-identity'

/**
 * Per-person OAuth sign-in to an integration (docs/plans/mcp-integrations.md
 * §4.3), with the MCP authorization specification and nothing beyond it:
 * protected-resource metadata (RFC 9728), authorization-server metadata
 * (RFC 8414 or OpenID Connect Discovery), dynamic client registration
 * (RFC 7591), PKCE with S256, and the `resource` indicator (RFC 8707) so the
 * token's audience is the integration's server.
 *
 * A pending flow is in memory with the acting scope it started in, because the
 * browser's callback names nobody: the flow decides whose token it becomes.
 */

const log = createLogger('integrations', 'oauth.ts')

export const INTEGRATION_OAUTH_CALLBACK_PATH = '/oauth/integration/callback'
const FLOW_TTL_MS = 10 * 60_000
/** A token with less than this left is refreshed before use. */
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const EXPIRED_MESSAGE = 'This sign-in expired. Start it again.'
const CLIENT_REQUIRED_MESSAGE = 'This server needs an OAuth client. Ask the host administrator to add one.'

const resourceMetadataSchema = z.object({
  authorization_servers: z.array(z.string().min(1)).min(1),
  scopes_supported: z.array(z.string()).optional(),
})

const authorizationServerSchema = z.object({
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  response_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  registration_endpoint: z.string().min(1).optional(),
  revocation_endpoint: z.string().min(1).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
})

const registrationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  token_endpoint_auth_method: z.string().optional(),
})

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})

type AuthMethod = NonNullable<IntegrationClient['tokenEndpointAuthMethod']>

/** What discovery found for one integration, with every endpoint checked. */
interface OAuthMetadata {
  authorizationEndpoint: URL
  tokenEndpoint: URL
  registrationEndpoint?: URL
  revocationEndpoint?: URL
  authMethods?: string[]
  scopes?: string[]
}

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
  client: IntegrationClient
  /** Whose connection this becomes (§4.1 rule 1). */
  scope: ActingScope
}

/** Where a person's connection changes are delivered: that person's clients only. */
export interface IntegrationConnectionEvents {
  connectionChanged(credentialUserId: string | null, event: IntegrationConnectionChangedEvent): void
  authFinished(credentialUserId: string | null, event: IntegrationAuthFinishedEvent): void
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
  secrets: IntegrationSecrets
  events: IntegrationConnectionEvents
  fetch?: typeof fetch
  now?: () => number
}

type Finish = { ok: true } | { ok: false; status: 400 | 500; title: string; message: string }

/** A failure the person can act on; its message is shown as it is. */
class SignInError extends Error {}

/** The token endpoint refused the grant (400 or 401): the person must sign in again. */
class GrantRefusedError extends Error {}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** Credentials go to HTTPS endpoints only; plain HTTP is allowed on loopback. */
function endpoint(value: string): URL {
  if (!URL.canParse(value)) throw new SignInError('The server published a sign-in address Solus cannot read.')
  const url = new URL(value)
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) return url
  throw new SignInError('The server published a sign-in address that is not HTTPS.')
}

/** Where an issuer publishes its metadata: RFC 8414, then OpenID Connect Discovery (the probe's order). */
function issuerLocations(issuer: URL): URL[] {
  const path = issuer.pathname.replace(/\/$/, '')
  const at = (pathname: string) => new URL(pathname.replace('//', '/'), issuer.origin)
  const inserted = [at(`/.well-known/oauth-authorization-server${path}`), at(`/.well-known/openid-configuration${path}`)]
  return path === '' ? inserted : [...inserted, at(`${path}/.well-known/openid-configuration`)]
}

function callbackBase(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : null
}

function chooseAuthMethod(supported: string[] | undefined): AuthMethod {
  if (!supported || supported.includes('none')) return 'none'
  return supported.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic'
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 300)
}

export class IntegrationOAuth {
  private readonly flows = new Map<string, PendingFlow>()
  private readonly metadataCache = new Map<string, Promise<OAuthMetadata>>()
  private readonly refreshing = new Map<string, Promise<IntegrationToken | null>>()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: IntegrationOAuthDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /** Starts the acting person's sign-in, or returns the one they already have open for this integration and callback. */
  async start(integration: Integration, options: IntegrationOAuthStartOptions): Promise<IntegrationConnectStartResult> {
    if (integration.auth.kind !== 'oauth') throw new Error('This integration does not sign in with OAuth.')
    const scope = requireActingScope('an integration sign-in')
    this.dropExpired()
    const base = callbackBase(options.callbackBaseUrl)
    const redirectUri = `${base ?? `http://${hostForUrl(options.fallbackHost)}:${options.fallbackPort}`}${INTEGRATION_OAUTH_CALLBACK_PATH}`
    for (const [state, flow] of this.flows) {
      if (flow.integrationId !== integration.id || flow.scope.credentialUserId !== scope.credentialUserId) continue
      if (flow.redirectUri === redirectUri) return waiting(flow)
      // One flow per person and integration: a start from another origin replaces it.
      this.flows.delete(state)
    }
    let metadata: OAuthMetadata
    let client: IntegrationClient
    try {
      metadata = await this.metadata(integration)
      client = await this.clientFor(integration, metadata, redirectUri)
    } catch (error) {
      log.warn('integration_oauth_start_failed', { integrationId: integration.id, error: errorText(error) })
      throw error
    }
    const verifier = base64url(randomBytes(32))
    const state = base64url(randomBytes(32))
    const url = new URL(metadata.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', client.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
    url.searchParams.set('code_challenge_method', 'S256')
    if (metadata.scopes?.length) url.searchParams.set('scope', metadata.scopes.join(' '))
    url.searchParams.set('resource', integration.url)
    const flow: PendingFlow = {
      flowId: randomUUID(),
      state,
      integrationId: integration.id,
      verifier,
      redirectUri,
      url: url.href,
      input: base ? 'callback' : 'redirect-url',
      expiresAt: this.now() + FLOW_TTL_MS,
      tokenEndpoint: metadata.tokenEndpoint,
      resource: integration.url,
      client,
      scope,
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
    this.deps.events.authFinished(flow.scope.credentialUserId, { flowId, integrationId: flow.integrationId, outcome: 'cancelled' })
    return true
  }

  /**
   * The person's token, refreshed first when it has under a minute left. Null
   * when there is none, or when a refresh failed; a refused refresh marks the
   * connection `needs-sign-in`.
   */
  refreshIfDue(integrationId: string, credentialUserId: string | null): Promise<IntegrationToken | null> {
    const token = this.deps.secrets.token(integrationId, credentialUserId)
    if (!token) return Promise.resolve(null)
    if (token.expiresAt === undefined || token.expiresAt - this.now() > REFRESH_MARGIN_MS) return Promise.resolve(token)
    if (!token.refreshToken) {
      this.record(integrationId, credentialUserId, 'needs-sign-in', 'The sign-in expired. Sign in again.')
      return Promise.resolve(null)
    }
    const key = `${integrationId}\u0000${credentialUserId ?? ''}`
    const pending = this.refreshing.get(key)
    if (pending) return pending
    const refreshed = this.refresh(integrationId, credentialUserId, token, token.refreshToken).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refreshed)
    return refreshed
  }

  /** Revokes a token at the server when its metadata names a revocation endpoint. Best effort: a failure is logged. */
  async revoke(integration: Integration, token: IntegrationToken): Promise<void> {
    try {
      const metadata = await this.metadata(integration)
      if (!metadata.revocationEndpoint) return
      const body = new URLSearchParams({ token: token.refreshToken ?? token.accessToken, token_type_hint: token.refreshToken ? 'refresh_token' : 'access_token' })
      const response = await this.post(metadata.revocationEndpoint, body, this.clientForToken(integration.id, token))
      await response.body?.cancel().catch(() => undefined)
      log.info('integration_token_revoked', { integrationId: integration.id, status: response.status })
    } catch (error) {
      log.warn('integration_token_revoke_failed', { integrationId: integration.id, error: errorText(error) })
    }
  }

  private ownFlow(flowId: string): PendingFlow | undefined {
    const credentialUserId = currentCredentialUserId()
    return [...this.flows.values()].find((flow) => flow.flowId === flowId && flow.scope.credentialUserId === credentialUserId)
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
    const user = flow.scope.credentialUserId
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
      const token = await this.exchange(flow, code)
      const identity = await readServerIdentity(integration.url, `Bearer ${token.accessToken}`, this.fetch)
      this.deps.secrets.saveToken(integrationId, user, token)
      const connection = this.deps.connections.upsert(integrationId, user, {
        status: 'connected',
        label: identity.label,
        info: identity.label ? { displayName: identity.label } : null,
        error: null,
      })
      this.deps.events.connectionChanged(user, { integrationId, connection })
      this.deps.events.authFinished(user, { flowId, integrationId, outcome: 'connected' })
      log.info('integration_oauth_connected', { integrationId, flowId, credentialUserId: user })
      return { ok: true }
    } catch (error) {
      log.warn('integration_oauth_failed', { integrationId, flowId, error: errorText(error) })
      const plain = error instanceof SignInError || error instanceof EncryptionUnavailableError || error instanceof ServerCredentialRefusedError
      return failed(500, 'Sign-in failed', plain ? error.message : 'Return to Solus and start the sign-in again.')
    }
  }

  private async exchange(flow: PendingFlow, code: string): Promise<IntegrationToken> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      resource: flow.resource,
    })
    return this.tokenRequest(flow.tokenEndpoint, body, flow.client, undefined)
  }

  private async refresh(integrationId: string, credentialUserId: string | null, token: IntegrationToken, refreshToken: string): Promise<IntegrationToken | null> {
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return null
    try {
      const metadata = await this.metadata(integration)
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, resource: integration.url })
      const refreshed = await this.tokenRequest(metadata.tokenEndpoint, body, this.clientForToken(integrationId, token), refreshToken)
      try {
        this.deps.secrets.saveToken(integrationId, credentialUserId, refreshed)
      } catch (error) {
        // A refresh cannot ask anyone; the token in hand still works for this call.
        log.warn('integration_token_persist_failed', { integrationId, error: errorText(error) })
      }
      log.info('integration_token_refreshed', { integrationId, credentialUserId })
      return refreshed
    } catch (error) {
      log.warn('integration_token_refresh_failed', { integrationId, credentialUserId, error: errorText(error) })
      // A refused grant needs the person; an unreachable server is tried again on the next call.
      if (error instanceof GrantRefusedError) this.record(integrationId, credentialUserId, 'needs-sign-in', 'The server ended the sign-in. Sign in again.')
      else this.record(integrationId, credentialUserId, 'error', 'Solus could not renew the sign-in. It tries again on the next call.')
      return null
    }
  }

  /** The token endpoint's answer as a stored token. `previousRefresh` is kept when a refresh answer omits a new one. */
  private async tokenRequest(target: URL, body: URLSearchParams, client: IntegrationClient, previousRefresh: string | undefined): Promise<IntegrationToken> {
    const response = await this.post(target, body, client)
    const parsed = response.ok ? tokenResponseSchema.safeParse(await response.json().catch(() => null)) : null
    if (!parsed?.success) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 400 || response.status === 401) throw new GrantRefusedError(`token endpoint refused the grant (${response.status})`)
      throw new Error(`token endpoint answered ${response.status}`)
    }
    const token: IntegrationToken = { accessToken: parsed.data.access_token, tokenType: parsed.data.token_type, clientId: client.clientId }
    const refreshToken = parsed.data.refresh_token ?? previousRefresh
    if (refreshToken) token.refreshToken = refreshToken
    if (parsed.data.expires_in !== undefined) token.expiresAt = this.now() + parsed.data.expires_in * 1000
    if (parsed.data.scope) token.scope = parsed.data.scope
    return token
  }

  /** A form POST with the client's authentication (RFC 6749 §2.3). */
  private post(target: URL, body: URLSearchParams, client: IntegrationClient): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    const method = client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_basic' : 'none')
    if (method === 'client_secret_basic' && client.clientSecret) {
      headers.set('authorization', `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`)
    } else {
      body.set('client_id', client.clientId)
      if (method === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret)
    }
    return this.fetch(target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }

  private async getJson(target: URL): Promise<{ status: number; document: unknown }> {
    const response = await this.fetch(target, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status, document: undefined }
    }
    return { status: 200, document: await response.json().catch(() => undefined) }
  }

  private metadata(integration: Integration): Promise<OAuthMetadata> {
    const discover = integration.auth.kind === 'oauth' ? integration.auth.discover : integration.auth.kind === 'none' ? integration.auth.oauth?.discover : undefined
    if (!discover) return Promise.reject(new SignInError('This integration does not sign in with OAuth.'))
    const cached = this.metadataCache.get(discover)
    if (cached) return cached
    const found = this.discover(discover)
    found.catch(() => this.metadataCache.delete(discover))
    this.metadataCache.set(discover, found)
    return found
  }

  /** The probe stored either a resource metadata document or an authorization server's own; both are read here. */
  private async discover(discover: string): Promise<OAuthMetadata> {
    const first = await this.getJson(new URL(discover))
    const resource = resourceMetadataSchema.safeParse(first.document)
    let document = first.document
    if (resource.success) {
      document = undefined
      for (const location of issuerLocations(endpoint(resource.data.authorization_servers[0]))) {
        const answer = await this.getJson(location)
        if (answer.status === 200) {
          document = answer.document
          break
        }
      }
    }
    const server = authorizationServerSchema.safeParse(document)
    if (!server.success) throw new SignInError('The server does not publish a usable sign-in.')
    const pkce = server.data.code_challenge_methods_supported
    if (!server.data.response_types_supported.includes('code') || (pkce && !pkce.includes('S256'))) {
      throw new SignInError('The server does not support a sign-in Solus can use.')
    }
    const metadata: OAuthMetadata = {
      authorizationEndpoint: endpoint(server.data.authorization_endpoint),
      tokenEndpoint: endpoint(server.data.token_endpoint),
    }
    if (server.data.registration_endpoint) metadata.registrationEndpoint = endpoint(server.data.registration_endpoint)
    if (server.data.revocation_endpoint) metadata.revocationEndpoint = endpoint(server.data.revocation_endpoint)
    if (server.data.token_endpoint_auth_methods_supported) metadata.authMethods = server.data.token_endpoint_auth_methods_supported
    if (resource.success && resource.data.scopes_supported) metadata.scopes = resource.data.scopes_supported
    return metadata
  }

  /**
   * A saved client registered for this callback, else the administrator's client
   * (with its saved secret and token-endpoint method), else a new registration,
   * else a plain refusal. The administrator registered their redirect addresses
   * at the server themselves, so their client is not checked against this one.
   */
  private async clientFor(integration: Integration, metadata: OAuthMetadata, redirectUri: string): Promise<IntegrationClient> {
    const saved = this.deps.secrets.client(integration.id)
    if (saved?.redirectUris?.includes(redirectUri)) return saved
    const adminClientId = integration.auth.kind === 'oauth' ? integration.auth.clientId : undefined
    if (adminClientId) return saved?.clientId === adminClientId ? saved : { clientId: adminClientId }
    if (metadata.registrationEndpoint) {
      return this.register(integration.id, metadata.registrationEndpoint, [...(saved?.redirectUris ?? []), redirectUri], chooseAuthMethod(metadata.authMethods))
    }
    throw new SignInError(CLIENT_REQUIRED_MESSAGE)
  }

  /** Dynamic client registration (RFC 7591). The registration belongs to the host and is kept per integration. */
  private async register(integrationId: string, target: URL, redirectUris: string[], method: AuthMethod): Promise<IntegrationClient> {
    const response = await this.fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Solus',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: method,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const parsed = response.ok ? registrationSchema.safeParse(await response.json().catch(() => null)) : null
    if (!parsed?.success) {
      await response.body?.cancel().catch(() => undefined)
      log.warn('integration_client_registration_failed', { integrationId, status: response.status })
      throw new SignInError(CLIENT_REQUIRED_MESSAGE)
    }
    const registered = parsed.data.token_endpoint_auth_method
    const client: IntegrationClient = {
      clientId: parsed.data.client_id,
      tokenEndpointAuthMethod: registered === 'client_secret_post' || registered === 'client_secret_basic' || registered === 'none' ? registered : method,
      redirectUris,
    }
    if (parsed.data.client_secret) client.clientSecret = parsed.data.client_secret
    this.deps.secrets.saveClient(integrationId, client)
    log.info('integration_client_registered', { integrationId })
    return client
  }

  /** The client that issued a token: the saved one when it is the same, else a public client by its ID. */
  private clientForToken(integrationId: string, token: IntegrationToken): IntegrationClient {
    const saved = this.deps.secrets.client(integrationId)
    if (saved && (!token.clientId || saved.clientId === token.clientId)) return saved
    if (!token.clientId) throw new Error('the token names no client')
    return { clientId: token.clientId }
  }

  private record(integrationId: string, credentialUserId: string | null, status: 'needs-sign-in' | 'error', error: string): void {
    const connection = this.deps.connections.upsert(integrationId, credentialUserId, { status, error })
    this.deps.events.connectionChanged(credentialUserId, { integrationId, connection })
  }
}

function waiting(flow: PendingFlow): IntegrationConnectStartResult {
  return { kind: 'waiting', flowId: flow.flowId, url: flow.url, input: flow.input, expiresAt: new Date(flow.expiresAt).toISOString() }
}
