import { z } from 'zod'

/**
 * The MCP authorization protocol, and nothing beyond it
 * (docs/plans/mcp-integrations.md §4.3, plans/020-agent-profile.md §5.3):
 * protected-resource metadata (RFC 9728), authorization-server metadata
 * (RFC 8414 or OpenID Connect Discovery), dynamic client registration
 * (RFC 7591), PKCE with S256, the `resource` indicator (RFC 8707), the
 * authorization-code and refresh-token grants, and revocation. One class over
 * `fetch` and Web Crypto, with no Node import, so a host and Solus Cloud run
 * one implementation. It keeps discovered metadata and nothing else: the
 * caller holds the pending flow, the client, and the token.
 */

const REQUEST_TIMEOUT_MS = 15_000
/** A token with less than this left is refreshed before use. */
export const OAUTH_REFRESH_MARGIN_MS = 60_000
export const OAUTH_CLIENT_REQUIRED_MESSAGE = 'This server does not let Solus register itself. Create an OAuth client at the service, then enter its client ID.'

export type OAuthAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

/** An OAuth client at one server: registered dynamically, or entered by an administrator. */
export const oauthClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
  /** The redirect addresses a dynamic registration named. */
  redirectUris: z.array(z.string()).optional(),
})
export type OAuthClient = z.infer<typeof oauthClientSchema>

/**
 * A token as the token endpoint answered it. `expiresAt` is epoch milliseconds.
 * `clientId` names the client that received it, for its refresh. A pasted key is
 * a token of type `api-key` with no refresh.
 */
export const oauthTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  tokenType: z.string().min(1),
  scope: z.string().optional(),
  clientId: z.string().min(1).optional(),
})
export type OAuthToken = z.infer<typeof oauthTokenSchema>

/** What discovery found for one server, with every endpoint checked. */
export interface OAuthMetadata {
  authorizationEndpoint: URL
  tokenEndpoint: URL
  registrationEndpoint?: URL
  revocationEndpoint?: URL
  authMethods?: string[]
  scopes?: string[]
}

/** A failure the person can act on; its message is shown as it is. */
export class OAuthSignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthSignInError'
  }
}

/**
 * The server will not register Solus (no registration endpoint, or it refused
 * the registration), so only a client the person creates there can sign in.
 * Not raised for a limit or an outage, which a retry answers.
 */
export class OAuthClientRequiredError extends OAuthSignInError {}

/** The token endpoint refused the grant (400 or 401): the person must sign in again. */
export class OAuthGrantRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthGrantRefusedError'
  }
}

/** A sign-in as it is started: open `url`; the callback carries `state`, and `verifier` proves the code exchange. */
export interface OAuthAuthorization {
  url: string
  state: string
  verifier: string
}

export interface OAuthCodeExchange {
  tokenEndpoint: URL
  client: OAuthClient
  code: string
  redirectUri: string
  verifier: string
  /** The server URL: the token's audience (RFC 8707). Absent for a Solus server whose vendor takes no `resource` (§13.6). */
  resource?: string
}

export interface OAuthRefresh {
  tokenEndpoint: URL
  client: OAuthClient
  refreshToken: string
  resource?: string
}

/**
 * What a Solus MCP server's code fixes for its vendor's sign-in (§13.6): the
 * scopes to ask for, and parameters such as Google's offline access. A remote
 * MCP server gets none: its metadata decides.
 */
export interface OAuthSignInOptions {
  scopes?: readonly string[]
  params?: Readonly<Record<string, string>>
}

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

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** Credentials go to HTTPS endpoints only; plain HTTP is allowed on loopback. */
function endpoint(value: string): URL {
  if (!URL.canParse(value)) throw new OAuthSignInError('The server published a sign-in address Solus cannot read.')
  const url = new URL(value)
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) return url
  throw new OAuthSignInError('The server published a sign-in address that is not HTTPS.')
}

/** Where an issuer publishes its metadata: RFC 8414, then OpenID Connect Discovery (the probe's order). */
function issuerLocations(issuer: URL): URL[] {
  const path = issuer.pathname.replace(/\/$/, '')
  const at = (pathname: string) => new URL(pathname.replace('//', '/'), issuer.origin)
  const inserted = [at(`/.well-known/oauth-authorization-server${path}`), at(`/.well-known/openid-configuration${path}`)]
  return path === '' ? inserted : [...inserted, at(`${path}/.well-known/openid-configuration`)]
}

function chooseAuthMethod(supported: string[] | undefined): OAuthAuthMethod {
  if (!supported || supported.includes('none')) return 'none'
  return supported.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic'
}

export interface McpOAuthOptions {
  fetch?: typeof fetch
  now?: () => number
}

export class McpOAuth {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly metadata = new Map<string, Promise<OAuthMetadata>>()

  constructor(options: McpOAuthOptions = {}) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  /** The metadata `address` names: a resource metadata document or an authorization server's own. Kept once read; a failure is asked again. */
  discover(address: string): Promise<OAuthMetadata> {
    const cached = this.metadata.get(address)
    if (cached) return cached
    const found = this.read(address)
    found.catch(() => this.metadata.delete(address))
    this.metadata.set(address, found)
    return found
  }

  /** Dynamic client registration (RFC 7591) for these redirect addresses. `OAuthSignInError` when the server offers or accepts none. */
  async register(metadata: OAuthMetadata, redirectUris: string[]): Promise<OAuthClient> {
    if (!metadata.registrationEndpoint) throw new OAuthClientRequiredError(OAUTH_CLIENT_REQUIRED_MESSAGE)
    const method = chooseAuthMethod(metadata.authMethods)
    const response = await this.fetch(metadata.registrationEndpoint, {
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
    const document: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(document)
      const code = failure.success ? failure.data.error : undefined
      let reason: string
      if (response.status === 429) reason = 'The service limited registration requests. Try again later.'
      else if (response.status >= 500) reason = 'The service could not complete registration. Try again later.'
      else if (code === 'invalid_redirect_uri') reason = 'The service refused this callback URL. Create an OAuth app with this redirect URL, or ask the service to allow it.'
      else if (code === 'invalid_client_metadata') reason = 'The service refused the registration details. Check its allowed redirect URLs, or use your own OAuth app.'
      else if (response.status === 401 || response.status === 403) reason = 'The service does not allow automatic registration. Create an OAuth app in its developer settings.'
      else reason = `The service refused automatic registration (HTTP ${response.status}). Use your own OAuth app.`
      throw response.status === 429 || response.status >= 500 ? new OAuthSignInError(reason) : new OAuthClientRequiredError(reason)
    }
    const parsed = registrationSchema.safeParse(document)
    if (!parsed.success) throw new OAuthSignInError('The service returned an invalid OAuth client registration response.')
    const registered = parsed.data.token_endpoint_auth_method
    const client: OAuthClient = {
      clientId: parsed.data.client_id,
      tokenEndpointAuthMethod: registered === 'client_secret_post' || registered === 'client_secret_basic' || registered === 'none' ? registered : method,
      redirectUris,
    }
    if (parsed.data.client_secret) client.clientSecret = parsed.data.client_secret
    return client
  }

  /** A fresh sign-in: PKCE, a state, and the authorization URL with the `resource` the token is for. */
  async authorization(request: { metadata: OAuthMetadata; client: OAuthClient; redirectUri: string; resource?: string; options?: OAuthSignInOptions }): Promise<OAuthAuthorization> {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const url = new URL(request.metadata.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', request.client.clientId)
    url.searchParams.set('redirect_uri', request.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    const scopes = request.options?.scopes ?? request.metadata.scopes
    if (scopes?.length) url.searchParams.set('scope', scopes.join(' '))
    if (request.resource) url.searchParams.set('resource', request.resource)
    // The protocol's own parameters are set above and cannot be replaced.
    for (const [name, value] of Object.entries(request.options?.params ?? {})) {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value)
    }
    return { url: url.href, state, verifier }
  }

  exchange(exchange: OAuthCodeExchange): Promise<OAuthToken> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.verifier,
    })
    if (exchange.resource) body.set('resource', exchange.resource)
    return this.token(exchange.tokenEndpoint, body, exchange.client, undefined)
  }

  /** `OAuthGrantRefusedError` when the server ended the sign-in; any other error is the server being unreachable or broken. */
  refresh(refresh: OAuthRefresh): Promise<OAuthToken> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh.refreshToken })
    if (refresh.resource) body.set('resource', refresh.resource)
    return this.token(refresh.tokenEndpoint, body, refresh.client, refresh.refreshToken)
  }

  /** Revocation (RFC 7009) when the metadata names an endpoint: the status, or null when there is none to call. */
  async revoke(metadata: OAuthMetadata, client: OAuthClient, token: OAuthToken): Promise<number | null> {
    if (!metadata.revocationEndpoint) return null
    const body = new URLSearchParams({ token: token.refreshToken ?? token.accessToken, token_type_hint: token.refreshToken ? 'refresh_token' : 'access_token' })
    const response = await this.post(metadata.revocationEndpoint, body, client)
    await response.body?.cancel().catch(() => undefined)
    return response.status
  }

  isRefreshDue(token: OAuthToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - this.now() <= OAUTH_REFRESH_MARGIN_MS
  }

  private async read(address: string): Promise<OAuthMetadata> {
    const first = await this.getJson(new URL(address))
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
    if (!server.success) throw new OAuthSignInError('The server does not publish a usable sign-in.')
    const pkce = server.data.code_challenge_methods_supported
    if (!server.data.response_types_supported.includes('code') || (pkce && !pkce.includes('S256'))) {
      throw new OAuthSignInError('The server does not support a sign-in Solus can use.')
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

  private async getJson(target: URL): Promise<{ status: number; document: unknown }> {
    const response = await this.fetch(target, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status, document: undefined }
    }
    return { status: 200, document: await response.json().catch(() => undefined) }
  }

  /** A form POST with the client's authentication (RFC 6749 §2.3). */
  private post(target: URL, body: URLSearchParams, client: OAuthClient): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    const method = client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_basic' : 'none')
    if (method === 'client_secret_basic' && client.clientSecret) {
      headers.set('authorization', `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`)
    } else {
      body.set('client_id', client.clientId)
      if (method === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret)
    }
    return this.fetch(target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }

  /** The token endpoint's answer as a token. `previousRefresh` is kept when a refresh answer omits a new one. */
  private async token(target: URL, body: URLSearchParams, client: OAuthClient, previousRefresh: string | undefined): Promise<OAuthToken> {
    const response = await this.post(target, body, client)
    const parsed = response.ok ? tokenResponseSchema.safeParse(await response.json().catch(() => null)) : null
    if (!parsed?.success) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 400 || response.status === 401) throw new OAuthGrantRefusedError(`token endpoint refused the grant (${response.status})`)
      throw new Error(`token endpoint answered ${response.status}`)
    }
    const token: OAuthToken = { accessToken: parsed.data.access_token, tokenType: parsed.data.token_type, clientId: client.clientId }
    const refreshToken = parsed.data.refresh_token ?? previousRefresh
    if (refreshToken) token.refreshToken = refreshToken
    if (parsed.data.expires_in !== undefined) token.expiresAt = this.now() + parsed.data.expires_in * 1000
    if (parsed.data.scope) token.scope = parsed.data.scope
    return token
  }
}
