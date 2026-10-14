import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TYPE,
  ACCOUNT_AUDIENCE,
  CLIENT_ASSERTION_TYPE,
  CONTROL_AUDIENCE,
  accessTokenClaimsSchema,
  hostClientId,
  hostCredentialRequestSchema,
  DEFAULT_ORGANIZATION_POLICY,
  hostAudience,
  type HostOrganizationsResponse,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenAudiences,
  SOLUS_API_AUDIENCE,
  type AccessTokenClaims,
  type PersonAccessTokenClaims,
  type EnrollHostResponse,
  type HostCredentialResponse,
  type HostKind,
  type HostLinkEnv,
  type HostPublicJwk,
  type HostLinkResponse,
  type HostRegistration,
} from '@solus/contracts/uplink'
import { PERSONAS, type Persona } from './personas'

/** A persona that signs in: a guest holds no token, only a share link's secret. */
export type SignedInPersona = Exclude<Persona, { kind: 'guest' }>

const addressSchema = z.object({ port: z.number().int().positive() })

/**
 * The Lab's control plane in miniature (plan §8.1): one ES256 key, a JWKS endpoint on
 * loopback, and a mint that turns a persona into the grant the real cloud would sign.
 * The host trusts it because its link record names this issuer; nothing on the host
 * changes for the Lab.
 *
 * For a managed host it also plays the provisioner (docs/plans/managed-hosts.md §2):
 * `issueManagedLink` is what the real cloud puts in the machine's environment, the
 * link record and a one-time credential ticket, with which the host registers the key
 * it makes at first boot (`POST /v1/hosts/:id/credential`). That record is then served
 * back at `GET /v1/hosts/:id/link` under the host's control token, so a rebooted host
 * passes its generation check exactly as it would against the real directory.
 *
 * For the cloud workspace (plans/010-standard-oauth.md) it mints access tokens for
 * members, gives each linked host an OAuth client with its key (`private_key_jwt`,
 * docs/adr/0001-standard-authentication.md §3.4), and answers the token endpoint as
 * the real provider does: a host gets its own control token (client credentials), and
 * trades a person's access token for a delegated token for the organization its link
 * names (token exchange, RFC 8693), and refreshes it. Every refresh is the live check:
 * a host detached from the organization is refused.
 */

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

interface IssuedLink {
  link: HostLinkResponse
  /** The public half of the host's key; null until a provisioned host registers it. */
  publicJwk: HostPublicJwk | null
  /** A provisioned host's one-time ticket, until it is used. */
  credentialTicket: string | null
  /** A managed host's: the organization it was provisioned for. */
  organizationId?: string
}

/** A host's own control token: client credentials for `CONTROL_AUDIENCE`. */
interface HostControlClaims {
  iss: string
  aud: string
  sub: string
  client_id: string
  jti: string
  iat: number
  exp: number
  host_id: string
  host_generation: number
}

type OrganizationMember = Extract<Persona, { kind: 'org-member' }>

/**
 * Whom a refresh token acts for, through which host, in which scope, and from which
 * client grant (ADR 0001 §2.2 rule 6): `personal` for the host's owner, else one
 * organization.
 */
interface Delegation {
  hostId: string
  userId: string
  scope: 'personal' | { organizationId: string }
  grantId: string
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
  | HostCredentialResponse
  | { access_token: string; token_type: 'Bearer'; expires_in: number }
  | { error: string; message?: string; error_description?: string }

const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z.string().min(1),
    subject_token_type: z.literal(ACCESS_TOKEN_TYPE),
    // One scope: an organization, or the owner's own host (`delegation_scope=personal`).
    organization_id: z.string().min(1).optional(),
    delegation_scope: z.literal('personal').optional(),
  }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(1) }),
  z.object({ grant_type: z.literal('client_credentials'), resource: z.literal(CONTROL_AUDIENCE) }),
])
const clientAssertionSchema = z.object({ client_assertion_type: z.literal(CLIENT_ASSERTION_TYPE), client_assertion: z.string().min(1) })
const assertionClaimsSchema = z.object({ iss: z.string().min(1), sub: z.string().min(1), exp: z.number() })
const controlClaimsSchema = z.object({ aud: z.literal(CONTROL_AUDIENCE), host_id: z.string().min(1), host_generation: z.number(), exp: z.number() })

function sendJson(response: ServerResponse, status: number, body: IssuerReply): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

export interface MintOptions {
  hostId: string
  hostKind: HostKind
  hostOwnerUserId?: string
  /** Seconds; defaults to an access token's five minutes. */
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
  private readonly origin: string | null

  /**
   * A fresh key and a free port by default. A proof that reboots a host against the
   * same persisted link record passes the key and port back in, because the real
   * control plane's key and origin do not change between a host's boots. A host on
   * another machine reaches the issuer through a public `origin` that forwards to
   * this port.
   */
  constructor(options: { privateKeyJwk?: JsonWebKey; port?: number; origin?: string } = {}) {
    this.origin = options.origin ?? null
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
    return this.origin ?? `http://127.0.0.1:${this.port}`
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
   * the link record and a one-time credential ticket. A later generation supersedes an
   * earlier one, as a recreated machine's would. A link that names the organization the
   * machine was provisioned for is a managed host's; a runner's names none.
   */
  issueManagedLink(hostId: string, proxiedPort: number, generation = 1, organizationId?: string): HostLinkEnv {
    const credentialTicket = `hct_lab_${randomBytes(18).toString('base64url')}`
    const registration = this.issueRegistration(hostId, proxiedPort, generation, { publicJwk: null, credentialTicket, organizationId })
    return { registration, tunnel: { hostname: `h-${hostId}.lab.invalid`, proxiedPort }, credentialTicket }
  }

  /**
   * What registration answers a host that sent the public half of its key: the
   * registration, and its OAuth client registered with that key. A Lab runner is written
   * as if it had registered and linked, so the key is the one the Lab put in its secret store.
   */
  issueEnrolledLink(hostId: string, proxiedPort: number, publicJwk: HostPublicJwk): EnrollHostResponse {
    const registration = this.issueRegistration(hostId, proxiedPort, 1, { publicJwk, credentialTicket: null })
    return { registration, oauthClient: { clientId: hostClientId(hostId) } }
  }

  private issueRegistration(hostId: string, proxiedPort: number, generation: number, credential: Pick<IssuedLink, 'publicJwk' | 'credentialTicket' | 'organizationId'>): HostRegistration {
    const link: HostLinkResponse = {
      hostId,
      generation,
      desired: 'linked',
      tunnel: { hostname: `h-${hostId}.lab.invalid`, proxiedPort },
    }
    const issued: HostRegistration = {
      hostId,
      issuer: this.issuer,
      jwksUrl: this.jwksUrl,
      directoryUrl: this.issuer,
      generation,
    }
    if (credential.organizationId) issued.organizationId = credential.organizationId
    if (this.workspaceUrl) issued.apiUrl = this.workspaceUrl
    // A new link is a new client: whatever the old one held is gone, as on the real account plane.
    for (const [token, delegation] of this.refreshTokens) if (delegation.hostId === hostId) this.refreshTokens.delete(token)
    this.links.set(hostId, { link, ...credential })
    return issued
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

  /** The Solus API the links issued now name; a scenario that replaces it puts it back. */
  get workspaceRoute(): string | null {
    return this.workspaceUrl
  }

  /** A workspace access token for a member: `aud: urn:solus:api`, `hostKind: cloud`. */
  issueWorkspaceGrant(persona: SignedInPersona, ttlSeconds?: number): string {
    return this.mint(persona, { hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', ttlSeconds })
  }

  /**
   * What a token exchange answers: a token the host `hostId` holds to act for the
   * member in the organization. A scenario that seeds the Solus API as a host would
   * uses it directly.
   */
  issueDelegatedToken(hostId: string, persona: OrganizationMember, grantId = `${persona.id}-grant`): string {
    return this.signDelegated(hostId, persona, { organizationId: persona.organizationId }, grantId)
  }

  /** A delegated token: the acting host in `act`, the client grant it was made from, and its scope's standing. */
  private signDelegated(hostId: string, persona: SignedInPersona, scope: Delegation['scope'], grantId: string): string {
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.minted += 1
    const clientId = hostClientId(hostId)
    const base = {
      iss: this.issuer,
      aud: [SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE],
      sub: persona.userId,
      grant_id: grantId,
      jti: `lab-${this.minted}-${nowSeconds}`,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
      client_id: clientId,
      act: { sub: clientId, host_id: hostId },
      hostKind: 'cloud' as const,
      displayName: persona.displayName,
    }
    if (scope === 'personal') return this.sign({ ...base, access: 'owner' })
    if (persona.kind !== 'org-member') throw new Error(`${persona.id} is in no organization`)
    return this.sign({ ...base, access: 'org-member', organizationId: scope.organizationId, organizationRole: persona.organizationRole, teamIds: [...persona.teamIds] })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer)
    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [this.jwk] })
      return
    }
    const credentialMatch = /^\/v1\/hosts\/([^/]+)\/credential$/.exec(url.pathname)
    if (credentialMatch && request.method === 'POST') {
      await this.handleCredential(credentialMatch[1]!, request, response)
      return
    }
    const organizationsMatch = /^\/v1\/hosts\/([^/]+)\/organizations$/.exec(url.pathname)
    if (organizationsMatch && request.method === 'GET') {
      const hostId = organizationsMatch[1]!
      if (!this.controlCaller(hostId, request.headers.authorization)) {
        sendJson(response, 401, { error: 'invalid_host_credential' })
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
      if (issued && this.controlCaller(linkMatch[1]!, request.headers.authorization)) {
        if (request.method === 'DELETE') {
          // Unlink turns the tunnel off; the registration stays (ADR 0001 §2.2 rule 9).
          issued.link = { ...issued.link, desired: 'unlinked', tunnel: null }
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
      sendJson(response, issued ? 401 : 404, { error: issued ? 'invalid_host_credential' : 'host_not_found' })
      return
    }
    response.statusCode = 404
    response.end()
  }

  /** A provisioned host registers its key with its one-time ticket; the same key again is accepted. */
  private async handleCredential(hostId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = hostCredentialRequestSchema.safeParse(JSON.parse(body || 'null'))
    const issued = this.links.get(hostId)
    if (!parsed.success || !issued) return sendJson(response, 400, { error: 'invalid_request' })
    const sameKey = issued.publicJwk?.x === parsed.data.publicJwk.x && issued.publicJwk?.y === parsed.data.publicJwk.y
    if (issued.credentialTicket === parsed.data.credentialTicket) {
      issued.publicJwk = parsed.data.publicJwk
      issued.credentialTicket = null
    } else if (!sameKey) {
      return sendJson(response, 401, { error: 'invalid_ticket' })
    }
    sendJson(response, 200, { oauthClient: { clientId: hostClientId(hostId) } })
  }

  /** The OAuth token endpoint, for host clients only: client credentials, token exchange, and refresh. */
  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, error: string, description: string) => sendJson(response, status, { error, error_description: description })
    let body = ''
    for await (const chunk of request) body += chunk
    const fields = Object.fromEntries(new URLSearchParams(body))
    const client = this.clientOf(fields)
    if (!client) return refuse(401, 'invalid_client', 'Unknown host client.')
    const parsed = tokenRequestSchema.safeParse(fields)
    if (!parsed.success) return refuse(400, 'invalid_request', 'Not a token exchange, a refresh, or client credentials.')
    const form = parsed.data
    if (form.grant_type === 'client_credentials') {
      const nowSeconds = Math.floor(Date.now() / 1000)
      this.minted += 1
      const clientId = hostClientId(client.hostId)
      const control: HostControlClaims = {
        iss: this.issuer, aud: CONTROL_AUDIENCE, sub: clientId, client_id: clientId, jti: `lab-${this.minted}-${nowSeconds}`,
        iat: nowSeconds, exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS, host_id: client.hostId, host_generation: client.generation,
      }
      return sendJson(response, 200, { access_token: this.sign(control), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS })
    }
    let delegation: Delegation
    if (form.grant_type === 'refresh_token') {
      const held = this.refreshTokens.get(form.refresh_token)
      if (!held || held.hostId !== client.hostId) return refuse(400, 'invalid_grant', 'Unknown refresh token.')
      this.refreshTokens.delete(form.refresh_token)
      delegation = held
    } else {
      const subject = this.verified(form.subject_token)
      if (!subject || !tokenAudiences(subject).includes(hostAudience(client.hostId))) return refuse(400, 'invalid_grant', 'The subject token is not for this host.')
      // A person's own token only, never a delegated one; the delegation keeps its grant.
      if (subject.act || !subject.grant_id) return refuse(400, 'invalid_grant', 'The subject is not a person\'s token.')
      const scope = form.delegation_scope === 'personal' && !form.organization_id ? 'personal' as const
        : form.organization_id && !form.delegation_scope ? { organizationId: form.organization_id } : null
      if (!scope) return refuse(400, 'invalid_request', 'Name one scope: an organization or personal.')
      // `personal` is the owner's alone (hostReach on the real account plane).
      if (scope === 'personal' && subject.access !== 'owner') return refuse(400, 'invalid_grant', 'not_the_owner')
      delegation = { hostId: client.hostId, userId: subject.sub, scope, grantId: subject.grant_id }
    }
    // The live check, at the exchange and at every refresh.
    const personas: readonly Persona[] = Object.values(PERSONAS)
    const persona = personas.find((candidate): candidate is SignedInPersona => candidate.kind !== 'guest' && candidate.userId === delegation.userId)
    if (!persona) return refuse(400, 'invalid_grant', 'Unknown person.')
    const scope = delegation.scope
    if (scope !== 'personal') {
      if (persona.kind !== 'org-member' || persona.organizationId !== scope.organizationId) return refuse(400, 'invalid_grant', 'The person is not a member of the organization.')
      const hostOrganization = this.links.get(client.hostId)?.organizationId ?? this.hostOrganizations.get(client.hostId)
      if (hostOrganization !== scope.organizationId) return refuse(400, 'invalid_grant', 'The host does not work for the organization.')
    }
    const refreshToken = `lab_rt_${randomBytes(18).toString('base64url')}`
    this.refreshTokens.set(refreshToken, delegation)
    const answer: TokenAnswer = { access_token: this.signDelegated(client.hostId, persona, scope, delegation.grantId), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken }
    if (form.grant_type !== 'refresh_token') answer.issued_token_type = ACCESS_TOKEN_TYPE
    sendJson(response, 200, answer)
  }

  /** The host whose key signed this client assertion (`private_key_jwt`), or null. */
  private clientOf(fields: Record<string, string>): { hostId: string; generation: number } | null {
    const parsed = clientAssertionSchema.safeParse(fields)
    if (!parsed.success) return null
    const [header, body, signature] = parsed.data.client_assertion.split('.')
    if (!header || !body || !signature) return null
    const claims = assertionClaimsSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    if (!claims.success || claims.data.iss !== claims.data.sub || claims.data.exp <= Date.now() / 1000) return null
    for (const [hostId, issued] of this.links) {
      if (hostClientId(hostId) !== claims.data.sub || !issued.publicJwk) continue
      const key = createPublicKey({ key: { ...issued.publicJwk }, format: 'jwk' })
      const valid = verify('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
      return valid ? { hostId, generation: issued.link.generation } : null
    }
    return null
  }

  /** Whether a bearer is this host's control token for its current link. */
  private controlCaller(hostId: string, authorization: string | undefined): boolean {
    const token = authorization?.replace(/^Bearer\s+/i, '') ?? ''
    const [header, body, signature] = token.split('.')
    const issued = this.links.get(hostId)
    if (!header || !body || !signature || !issued?.publicJwk) return false
    if (!verify('sha256', Buffer.from(`${header}.${body}`), { key: createPublicKey(this.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return false
    const claims = controlClaimsSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    return claims.success && claims.data.host_id === hostId && claims.data.host_generation === issued.link.generation && claims.data.exp > Date.now() / 1000
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
   * persona's client grant: for one host (`hostAudience`), or for the Solus API when
   * `hostId` is `SOLUS_API_AUDIENCE`. A member's lists the organization it reaches.
   */
  mint(persona: SignedInPersona, options: MintOptions): string {
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.minted += 1
    const base = {
      iss: this.issuer,
      aud: options.hostId === SOLUS_API_AUDIENCE ? SOLUS_API_AUDIENCE : hostAudience(options.hostId),
      jti: `lab-${this.minted}-${nowSeconds}`,
      iat: nowSeconds,
      exp: nowSeconds + (options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS),
      hostKind: options.hostKind,
      displayName: persona.displayName,
      sub: persona.userId,
      grant_id: `${persona.id}-grant`,
      client_id: 'solus-desktop',
    }
    let claims: PersonAccessTokenClaims
    switch (persona.kind) {
      case 'host-owner':
        claims = { ...base, access: 'owner', hostOwnerUserId: persona.userId }
        break
      case 'org-member':
        claims = {
          ...base,
          access: 'org-member',
          organizations: [{ id: persona.organizationId, role: persona.organizationRole, teamIds: [...persona.teamIds] }],
        }
        if (options.hostOwnerUserId) claims.hostOwnerUserId = options.hostOwnerUserId
        break
    }
    return this.sign(claims)
  }

  private sign(claims: AccessTokenClaims | HostControlClaims): string {
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: this.kid, typ: 'JWT' }))
    const body = base64Url(JSON.stringify(claims))
    const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' })
    return `${header}.${body}.${base64Url(signature)}`
  }
}
