import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TYPE,
  ACCOUNT_AUDIENCE,
  accessTokenClaimsSchema,
  DEFAULT_ORGANIZATION_POLICY,
  GUEST_GRANT_TTL_SECONDS,
  hostAudience,
  type HostOrganizationsResponse,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenAudiences,
  SOLUS_API_AUDIENCE,
  type AccessTokenClaims,
  type EnrollHostResponse,
  type HostKind,
  type HostLinkResponse,
  type UplinkLinkConfig,
} from '@solus/contracts/uplink'
import { PERSONAS, type Persona } from './personas'

const addressSchema = z.object({ port: z.number().int().positive() })

/**
 * The Lab's control plane in miniature (plan §8.1): one ES256 key, a JWKS endpoint on
 * loopback, and a mint that turns a persona into the grant the real cloud would sign.
 * The host trusts it because its link record names this issuer; nothing on the host
 * changes for the Lab.
 *
 * For a managed host it also plays the provisioner (docs/plans/managed-hosts.md §2):
 * `issueManagedLink` is what the real cloud puts in the machine's environment, the
 * same link record and tokens enrollment answers with. That record is then served
 * back at `GET /v1/hosts/:id/link` under the host token, so a rebooted host passes
 * its generation check exactly as it would against the real directory.
 *
 * For the cloud workspace (plans/010-standard-oauth.md) it mints access tokens for
 * members, gives each linked host an OAuth client, and answers the token endpoint as
 * the real provider does: a host trades a person's access token for a delegated token
 * for the organization its link names (token exchange, RFC 8693), and refreshes it.
 * Every refresh is the live check: a host detached from the organization is refused.
 */

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

interface IssuedLink {
  hostToken: string
  link: HostLinkResponse
  oauthClient: { clientId: string; clientSecret: string }
  /** A managed host's: the organization it was provisioned for. */
  organizationId?: string
}

type OrganizationMember = Extract<Persona, { kind: 'org-member' }>

/** Whom a refresh token acts for, and through which host. */
interface Delegation {
  hostId: string
  userId: string
  organizationId: string
}

interface TokenAnswer {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  issued_token_type?: string
}

/** Everything the issuer answers with. */
type IssuerReply =
  | { keys: Array<JsonWebKey & { kid: string }> }
  | HostLinkResponse
  | HostOrganizationsResponse
  | TokenAnswer
  | { error: string; message?: string; error_description?: string }

const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE), subject_token: z.string().min(1), subject_token_type: z.literal(ACCESS_TOKEN_TYPE), organization_id: z.string().min(1) }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(1) }),
])

function sendJson(response: ServerResponse, status: number, body: IssuerReply): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

export interface MintOptions {
  hostId: string
  hostKind: HostKind
  hostOwnerUserId?: string
  /** Seconds; defaults to an access token's five minutes, or a guest grant's ten. */
  ttlSeconds?: number
}

export class LabIssuer {
  readonly kid = 'lab-k1'
  private readonly privateKey: KeyObject
  private readonly jwk: JsonWebKey & { kid: string }
  private server: Server | null = null
  private port = 0
  private minted = 0
  private readonly links = new Map<string, IssuedLink>()
  /** Host id → the organization the owner shared it with. */
  private readonly hostOrganizations = new Map<string, string>()
  /** Refresh token → whom it acts for. Rotated on every refresh. */
  private readonly refreshTokens = new Map<string, Delegation>()
  private workspaceUrl: string | null = null

  /**
   * A fresh key and a free port by default. A proof that reboots a host against the
   * same persisted link record passes the key and port back in, because the real
   * control plane's key and origin do not change between a host's boots.
   */
  constructor(options: { privateKeyJwk?: JsonWebKey; port?: number } = {}) {
    if (options.privateKeyJwk) {
      this.privateKey = createPrivateKey({ key: options.privateKeyJwk, format: 'jwk' })
      const publicKey = createPublicKey(this.privateKey)
      this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'ES256', use: 'sig' }
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      this.privateKey = privateKey
      this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'ES256', use: 'sig' }
    }
    this.port = options.port ?? 0
  }

  /** The signing key as a JWK, for a proof that must present the same issuer after a reboot. */
  exportPrivateKeyJwk(): JsonWebKey {
    return this.privateKey.export({ format: 'jwk' })
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get jwksUrl(): string {
    return `${this.issuer}/jwks`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        sendJson(response, 500, { error: 'lab_issuer_failed', message: error instanceof Error ? error.message : String(error) })
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve))
    const address = addressSchema.safeParse(this.server.address())
    this.port = address.success ? address.data.port : 0
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * What the provisioner puts in a managed machine's environment (`SOLUS_HOST_LINK`):
   * the finished enrollment. A later generation supersedes an earlier one, as a
   * recreated machine's would. A link that names the organization the machine was
   * provisioned for is a managed host's; a runner's names none.
   */
  issueManagedLink(hostId: string, proxiedPort: number, connectionGeneration = 1, organizationId?: string): EnrollHostResponse {
    const hostToken = `sht_lab_${randomBytes(18).toString('base64url')}`
    const link: HostLinkResponse = {
      hostId,
      desired: 'linked',
      connectionGeneration,
      hostname: `h-${hostId}.lab.invalid`,
      proxiedPort,
    }
    const issued: UplinkLinkConfig = {
      hostId,
      issuer: this.issuer,
      jwksUrl: this.jwksUrl,
      directoryUrl: this.issuer,
      hostname: link.hostname,
      proxiedPort,
      connectionGeneration,
    }
    if (organizationId) issued.organizationId = organizationId
    if (this.workspaceUrl) issued.apiUrl = this.workspaceUrl
    const oauthClient = { clientId: `host_${hostId}`, clientSecret: `shc_lab_${randomBytes(18).toString('base64url')}` }
    // A new link is a new client: whatever the old one held is gone, as on the real account plane.
    for (const [token, delegation] of this.refreshTokens) if (delegation.hostId === hostId) this.refreshTokens.delete(token)
    this.links.set(hostId, { hostToken, link, oauthClient, organizationId })
    return {
      link: issued,
      // The Lab runs no tunnel; the host's connector gets a token it can never use.
      connectorToken: 'lab-connector-token',
      hostToken,
      oauthClient,
    }
  }

  /** The link record the issuer handed a managed host, or null before one was issued. */
  issuedLink(hostId: string): HostLinkResponse | null {
    return this.links.get(hostId)?.link ?? null
  }

  /** The owner shared a host with an organization (`POST /v1/hosts/:id/organization` on the real cloud). */
  attachHostToOrganization(hostId: string, organizationId: string | null): void {
    if (organizationId === null) this.hostOrganizations.delete(hostId)
    else this.hostOrganizations.set(hostId, organizationId)
  }

  /** Where the workspace service is; a link issued after this names it as the host's Solus API. */
  setWorkspaceRoute(url: string | null): void {
    this.workspaceUrl = url
  }

  /** A workspace access token for a member: `aud: urn:solus:api`, `hostKind: cloud`. */
  issueWorkspaceGrant(persona: Persona, ttlSeconds?: number): string {
    return this.mint(persona, { hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', ttlSeconds })
  }

  /**
   * What a token exchange answers: a token the host `hostId` holds to act for the
   * member in the organization. A scenario that seeds the Solus API as a host would
   * uses it directly.
   */
  issueDelegatedToken(hostId: string, persona: OrganizationMember): string {
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.minted += 1
    const clientId = `host_${hostId}`
    return this.sign({
      iss: this.issuer,
      aud: [SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE],
      sub: persona.userId,
      deviceId: hostId,
      jti: `lab-${this.minted}-${nowSeconds}`,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
      client_id: clientId,
      act: { sub: clientId, host_id: hostId },
      access: 'org-member',
      hostKind: 'cloud',
      organizationId: persona.organizationId,
      organizationRole: persona.organizationRole,
      teamIds: [...persona.teamIds],
      displayName: persona.displayName,
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer)
    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [this.jwk] })
      return
    }
    const organizationsMatch = /^\/v1\/hosts\/([^/]+)\/organizations$/.exec(url.pathname)
    if (organizationsMatch && request.method === 'GET') {
      const hostId = organizationsMatch[1]!
      const issued = this.links.get(hostId)
      if (!issued || request.headers.authorization !== `Bearer ${issued.hostToken}`) {
        sendJson(response, 401, { error: 'invalid_host_token' })
        return
      }
      const organizationId = this.hostOrganizations.get(hostId)
      sendJson(response, 200, {
        hostId, category: 'self-hosted', owner: { userId: PERSONAS.alice.userId, name: PERSONAS.alice.displayName },
        organizations: organizationId ? [{ organizationId, name: 'Lab', shared: true, policy: DEFAULT_ORGANIZATION_POLICY }] : [],
      })
      return
    }
    if (url.pathname === '/api/auth/oauth2/token' && request.method === 'POST') {
      await this.handleToken(request, response)
      return
    }
    const linkMatch = /^\/v1\/hosts\/([^/]+)\/link$/.exec(url.pathname)
    if (linkMatch) {
      const issued = this.links.get(linkMatch[1]!)
      const presented = request.headers.authorization?.replace(/^Bearer\s+/i, '')
      if (issued && presented === issued.hostToken) {
        if (request.method === 'DELETE') {
          this.links.delete(linkMatch[1]!)
          response.statusCode = 204
          response.end()
          return
        }
        sendJson(response, 200, issued.link)
        return
      }
      // A host the Lab never issued a link to (the hand-written record) gets 404:
      // "unknown", which keeps its link. A wrong token on a bootstrapped host is 401:
      // superseded, exactly what the real directory answers.
      sendJson(response, issued ? 401 : 404, { error: issued ? 'invalid_host_token' : 'host_not_found' })
      return
    }
    response.statusCode = 404
    response.end()
  }

  /** The OAuth token endpoint, for host clients only: token exchange and refresh. */
  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, error: string, description: string) => sendJson(response, status, { error, error_description: description })
    const client = this.clientOf(request.headers.authorization)
    if (!client) return refuse(401, 'invalid_client', 'Unknown host client.')
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = tokenRequestSchema.safeParse(Object.fromEntries(new URLSearchParams(body)))
    if (!parsed.success) return refuse(400, 'invalid_request', 'Not a token exchange or a refresh.')
    const form = parsed.data
    let delegation: Delegation
    if (form.grant_type === 'refresh_token') {
      const held = this.refreshTokens.get(form.refresh_token)
      if (!held || held.hostId !== client.hostId) return refuse(400, 'invalid_grant', 'Unknown refresh token.')
      this.refreshTokens.delete(form.refresh_token)
      delegation = held
    } else {
      const subject = this.verified(form.subject_token)
      if (!subject || !tokenAudiences(subject).includes(hostAudience(client.hostId))) return refuse(400, 'invalid_grant', 'The subject token is not for this host.')
      delegation = { hostId: client.hostId, userId: subject.sub, organizationId: form.organization_id }
    }
    // The live check, at the exchange and at every refresh.
    const personas: readonly Persona[] = Object.values(PERSONAS)
    const persona = personas.find((candidate): candidate is OrganizationMember => candidate.kind === 'org-member' && candidate.userId === delegation.userId)
    if (!persona || persona.organizationId !== delegation.organizationId) return refuse(400, 'invalid_grant', 'The person is not a member of the organization.')
    const hostOrganization = this.links.get(client.hostId)?.organizationId ?? this.hostOrganizations.get(client.hostId)
    if (hostOrganization !== delegation.organizationId) return refuse(400, 'invalid_grant', 'The host does not work for the organization.')
    const refreshToken = `lab_rt_${randomBytes(18).toString('base64url')}`
    this.refreshTokens.set(refreshToken, delegation)
    const answer: TokenAnswer = { access_token: this.issueDelegatedToken(client.hostId, persona), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken }
    if (form.grant_type !== 'refresh_token') answer.issued_token_type = ACCESS_TOKEN_TYPE
    sendJson(response, 200, answer)
  }

  /** The host whose OAuth client presented these Basic credentials, or null. */
  private clientOf(authorization: string | undefined): { hostId: string } | null {
    const encoded = /^Basic\s+(.+)$/i.exec(authorization ?? '')?.[1]
    if (!encoded) return null
    const [clientId = '', clientSecret = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(':').map(decodeURIComponent)
    for (const [hostId, issued] of this.links) {
      if (issued.oauthClient.clientId === clientId && issued.oauthClient.clientSecret === clientSecret) return { hostId }
    }
    return null
  }

  /** The claims of a token this issuer signed and that has not run out, or null. */
  private verified(token: string): AccessTokenClaims | null {
    const [header, body, signature] = token.split('.')
    if (!header || !body || !signature) return null
    const publicKey = createPublicKey(this.privateKey)
    if (!verify('sha256', Buffer.from(`${header}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return null
    const claims = accessTokenClaimsSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    return claims.success && claims.data.exp > Date.now() / 1000 ? claims.data : null
  }

  /**
   * One access token per dial, exactly as the account plane would issue it for this
   * persona: for one host (`hostAudience`), or for the Solus API when `hostId` is
   * `SOLUS_API_AUDIENCE`. A guest's is a guest grant.
   */
  mint(persona: Persona, options: MintOptions): string {
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.minted += 1
    const base = {
      iss: this.issuer,
      aud: options.hostId === SOLUS_API_AUDIENCE ? SOLUS_API_AUDIENCE : hostAudience(options.hostId),
      jti: `lab-${this.minted}-${nowSeconds}`,
      iat: nowSeconds,
      exp: nowSeconds + (options.ttlSeconds ?? (persona.kind === 'guest' ? GUEST_GRANT_TTL_SECONDS : ACCESS_TOKEN_TTL_SECONDS)),
      hostKind: options.hostKind,
      displayName: persona.displayName,
    }
    let claims: AccessTokenClaims
    switch (persona.kind) {
      case 'host-owner':
        claims = { ...base, sub: persona.userId, deviceId: `${persona.id}-session`, client_id: 'solus-app', access: 'owner', hostOwnerUserId: persona.userId }
        break
      case 'org-member':
        claims = {
          ...base,
          sub: persona.userId,
          deviceId: `${persona.id}-session`,
          client_id: 'solus-app',
          access: 'org-member',
          organizationId: persona.organizationId,
          organizationRole: persona.organizationRole,
          teamIds: persona.teamIds,
        }
        if (options.hostOwnerUserId) claims.hostOwnerUserId = options.hostOwnerUserId
        break
      case 'guest':
        claims = { ...base, sub: `guest:${persona.guestId}`, deviceId: persona.guestId, access: 'guest' }
        break
    }
    return this.sign(claims)
  }

  private sign(claims: AccessTokenClaims): string {
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: this.kid, typ: 'JWT' }))
    const body = base64Url(JSON.stringify(claims))
    const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' })
    return `${header}.${body}.${base64Url(signature)}`
  }
}
