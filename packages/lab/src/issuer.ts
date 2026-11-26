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
  DEFAULT_HOST_RULES,
  ORGANIZATION_TICKET_PREFIX,
  PERSONAL_TICKET_PREFIX,
  enrollHostRequestSchema,
  formatLinkCode,
  linkHostRequestSchema,
  hostAudience,
  type HostOrganizationsResponse,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenAudiences,
  SOLUS_API_AUDIENCE,
  type AccessTokenClaims,
  type PersonAccessTokenClaims,
  type EnrollHostResponse,
  type HostKind,
  type HostPublicJwk,
  type HostLinkResponse,
  type HostRegistration,
  type LinkHostResponse,
} from '@solus/contracts/uplink'
import { organizationPolicyTemplate, type PolicyDocument } from '@solus/contracts/policy'
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
 * Every machine joins in one way (plans/034-one-cloud-machine-kind.md §3), and the
 * issuer serves it as the real cloud does. `issueBootLinkCode` is what the real cloud
 * gives a machine that enrolls at boot: the link code for its environment
 * (`SOLUS_LINK_CODE`). The host makes its key and enrolls with the ticket (`POST
 * /v1/hosts/enroll`), then turns its link on (`POST /v1/hosts/:id/link`): the issuer
 * answers the machine's own address when it has one, and else a tunnel with a connector
 * token. The link is then served back at `GET /v1/hosts/:id/link` under the host's
 * control token, so a rebooted host passes its generation check exactly as it would
 * against the real directory.
 *
 * A registration that names an organization is a cloud machine's
 * (plans/034-one-cloud-machine-kind.md §2): the standing the issuer answers for it says
 * `kind: 'cloud'` and no owner. Every other host is alice's personal host, which she may
 * share with the organization (`shareHostWithOrganization`).
 *
 * For the cloud workspace (plans/010-standard-oauth.md) it mints access tokens for
 * members, gives each linked host an OAuth client with its key (`private_key_jwt`,
 * docs/adr/0001-standard-authentication.md §3.4), and answers the token endpoint as
 * the real provider does: a host gets its own control token (client credentials), and
 * trades a person's access token for a delegation for the organization its link names
 * (token exchange, RFC 8693). The issuer keeps the delegation; the host asks it for a
 * token with its control token (`POST /v1/hosts/:id/delegation-token`). Every ask is
 * the live check: a host that does not work for the organization is refused.
 */

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

interface IssuedLink {
  link: HostLinkResponse
  /** The public half of the host's key. */
  publicJwk: HostPublicJwk
  /** A cloud machine's: the one organization its registration names. */
  organizationId?: string
  /** The machine's own HTTPS address: its link is that address, with no tunnel. Absent, the host gets a tunnel. */
  address?: string
}

/** What `issueBootLinkCode` takes: the host the ticket registers, and what the control plane knows of it. */
export interface BootLinkCodeInput {
  hostId: string
  /** The ticket is an organization's: the host becomes a cloud machine of it. Absent, it is alice's personal host. */
  organizationId?: string
  /** The address the control plane has for the machine, as from its compute provider. */
  address?: string
  /** The control plane operates the machine's compute. Cloud machines only. */
  hasManagedCompute?: boolean
}

/** A ticket of a link code. It works once; `enrolled` is the answer it gave, which the same key gets again. */
interface BootTicket extends BootLinkCodeInput {
  enrolled: { publicJwk: HostPublicJwk; answer: EnrollHostResponse } | null
}

/** The connector token of a Lab tunnel. The Lab runs no tunnel: the host's connector is a shim that only waits. */
const LAB_CONNECTOR_TOKEN = 'lab-connector-token'

/** An `https:` origin with no path, query, or credentials: what a machine address must be. */
function isMachineAddress(address: string): boolean {
  try {
    const url = new URL(address)
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk
  return body
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
 * A delegation the issuer keeps: whom it acts for, through which host, in which scope, and from which
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
  issued_token_type?: string
}

/** Everything the issuer answers with. */
type IssuerReply =
  | { keys: Array<JsonWebKey & { kid: string }> }
  | HostLinkResponse
  | HostOrganizationsResponse
  | TokenAnswer
  | EnrollHostResponse
  | LinkHostResponse
  | { access_token: string; token_type: 'Bearer'; expires_in: number }
  | { error: string; message?: string; error_description?: string; solus_refusal?: string }

const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z.string().min(1),
    subject_token_type: z.literal(ACCESS_TOKEN_TYPE),
    // One scope: an organization, or the owner's own host (`delegation_scope=personal`).
    organization_id: z.string().min(1).optional(),
    delegation_scope: z.literal('personal').optional(),
  }),
  z.object({ grant_type: z.literal('client_credentials'), resource: z.literal(CONTROL_AUDIENCE) }),
])
const delegationTokenRequestSchema = z.object({
  userId: z.string().min(1),
  scope: z.union([z.literal('personal'), z.object({ organizationId: z.string().min(1) })]),
  resource: z.string().min(1),
})
const delegationKey = (hostId: string, userId: string, scope: Delegation['scope']): string =>
  `${hostId}\u0000${userId}\u0000${scope === 'personal' ? 'personal' : scope.organizationId}`
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
  /** Personal hosts only: the account that owns the host a member reaches. */
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
  /** The tickets of the link codes the issuer gave, by ticket. */
  private readonly bootTickets = new Map<string, BootTicket>()
  /** A personal host's id → the organization its owner shared it with. */
  private readonly sharedOrganizations = new Map<string, string>()
  /** The delegations the issuer keeps, by host, person, and scope. */
  private readonly delegations = new Map<string, Delegation>()
  private organizationPolicy: PolicyDocument = organizationPolicyTemplate('Lab')
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
   * The link code the control plane gives a machine that enrolls at boot
   * (`SOLUS_LINK_CODE`, plans/034-one-cloud-machine-kind.md §3): `<ticket>@<issuer host>`.
   * The ticket says the kind by its prefix: with an organization it is `org_…`, and the
   * host becomes a cloud machine of it; with none it is `set_…`, and the host is alice's
   * personal host. `address` is the address the control plane has for the machine, as
   * from its compute provider: the machine's link is then that address, with no tunnel.
   * `hasManagedCompute` makes the registration say that the control plane operates the
   * compute.
   */
  issueBootLinkCode(input: BootLinkCodeInput): string {
    if (input.hasManagedCompute && !input.organizationId) throw new Error('Only a cloud machine has managed compute')
    const ticket = `${input.organizationId ? ORGANIZATION_TICKET_PREFIX : PERSONAL_TICKET_PREFIX}lab_${randomBytes(18).toString('base64url')}`
    this.bootTickets.set(ticket, { ...input, enrolled: null })
    return formatLinkCode(ticket, this.issuer)
  }

  /**
   * What registration answers a host that sent the public half of its key: the
   * registration, and its OAuth client registered with that key. The Lab writes such a
   * host as if it had registered and linked, so the key is the one the Lab put in its
   * secret store. With an organization, the ticket was an organization's: the
   * registration names it, so the host is a cloud machine that its operator runs (no
   * `hasManagedCompute`), reached at its own address. With none, it is alice's personal
   * host, reached through a tunnel.
   */
  issueEnrolledLink(hostId: string, proxiedPort: number, publicJwk: HostPublicJwk, organizationId?: string): EnrollHostResponse {
    const tunnel = { hostname: `h-${hostId}.lab.invalid`, proxiedPort }
    const address = organizationId ? `https://${tunnel.hostname}` : undefined
    const registration = this.issueRegistration(hostId, 1, { publicJwk, organizationId, address, link: { desired: 'linked', tunnel } }, false)
    return { registration, oauthClient: { clientId: hostClientId(hostId) } }
  }

  private issueRegistration(hostId: string, generation: number, host: Omit<IssuedLink, 'link'> & { link: Pick<HostLinkResponse, 'desired' | 'tunnel'> }, hasManagedCompute: boolean): HostRegistration {
    const issued: HostRegistration = {
      hostId,
      issuer: this.issuer,
      jwksUrl: this.jwksUrl,
      directoryUrl: this.issuer,
      generation,
    }
    if (host.organizationId) {
      issued.organizationId = host.organizationId
      if (hasManagedCompute) issued.hasManagedCompute = true
    }
    if (this.workspaceUrl) issued.apiUrl = this.workspaceUrl
    // A new registration is a new client: whatever the old one held is gone, as on the real account plane.
    for (const [key, delegation] of this.delegations) if (delegation.hostId === hostId) this.delegations.delete(key)
    this.links.set(hostId, { ...host, link: { hostId, generation, ...host.link } })
    return issued
  }

  /** The link record the issuer handed a host, or null before one was issued. */
  issuedLink(hostId: string): HostLinkResponse | null {
    return this.links.get(hostId)?.link ?? null
  }

  /**
   * alice shared her personal host with an organization (`POST /v1/hosts/:id/organizations`
   * on the real cloud), or took it back (null). The host stays personal: its members
   * reach it with member grants, and her own work stays Local unless she assigns it.
   */
  shareHostWithOrganization(hostId: string, organizationId: string | null): void {
    if (organizationId === null) this.sharedOrganizations.delete(hostId)
    else this.sharedOrganizations.set(hostId, organizationId)
  }

  /** The policy of the organization as each host reads it from now; null puts the first policy back. */
  setOrganizationPolicy(document: PolicyDocument | null): void {
    this.organizationPolicy = document ?? organizationPolicyTemplate('Lab')
  }

  /** Where the workspace service is; a link issued after this names it as the host's Solus API. */
  setWorkspaceRoute(url: string | null): void {
    this.workspaceUrl = url
  }

  /** The Solus API the links issued now name; a scenario that replaces it puts it back. */
  get workspaceRoute(): string | null {
    return this.workspaceUrl
  }

  /** A Solus API access token for a member: `aud: urn:solus:api`, `hostKind: api`. */
  issueWorkspaceGrant(persona: SignedInPersona, ttlSeconds?: number): string {
    return this.mint(persona, { hostId: SOLUS_API_AUDIENCE, hostKind: 'api', ttlSeconds })
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
      hostKind: 'api' as const,
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
    if (url.pathname === '/v1/hosts/enroll' && request.method === 'POST') {
      await this.handleEnroll(request, response)
      return
    }
    const organizationsMatch = /^\/v1\/hosts\/([^/]+)\/organizations$/.exec(url.pathname)
    if (organizationsMatch && request.method === 'GET') {
      const hostId = organizationsMatch[1]!
      if (!this.controlCaller(hostId, request.headers.authorization)) {
        sendJson(response, 401, { error: 'invalid_host_credential' })
        return
      }
      sendJson(response, 200, this.standingOf(hostId))
      return
    }
    const delegationTokenMatch = /^\/v1\/hosts\/([^/]+)\/delegation-token$/.exec(url.pathname)
    if (delegationTokenMatch && request.method === 'POST') {
      await this.handleDelegationToken(delegationTokenMatch[1]!, request, response)
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
        if (request.method === 'POST') {
          await this.handleLink(issued, request, response)
          return
        }
        if (request.method === 'DELETE') {
          // Unlink turns the link off, and a personal host's address is forgotten; the
          // registration stays (ADR 0001 §2.2 rule 9).
          issued.link = { ...issued.link, desired: 'unlinked', tunnel: null }
          if (!issued.organizationId) delete issued.address
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

  /**
   * A host's standing (`GET /v1/hosts/:id/organizations`). A registration that names an
   * organization is a cloud machine's: nobody owns it, and it works for that one
   * organization. Every other host is alice's personal host, with the organization she
   * shared it with, if any.
   */
  private standingOf(hostId: string): HostOrganizationsResponse {
    const cloudOrganizationId = this.links.get(hostId)?.organizationId
    const organizationId = cloudOrganizationId ?? this.sharedOrganizations.get(hostId)
    return {
      hostId,
      kind: cloudOrganizationId ? 'cloud' : 'personal',
      owner: cloudOrganizationId ? null : { userId: PERSONAS.alice.userId, name: PERSONAS.alice.displayName },
      organizations: organizationId
        ? [{ organizationId, name: 'Lab', shared: true, hostRules: DEFAULT_HOST_RULES, policy: this.organizationPolicy, hostPolicy: null }]
        : [],
      hostOwnerOrganizationId: null,
    }
  }

  /**
   * `POST /v1/hosts/enroll`: a host registers the key it made with the ticket of its
   * link code. The ticket works once. The key that used it gets the same answer again,
   * so a host whose answer was lost can ask again. The registration says what the
   * ticket was issued for; the host is not linked yet.
   */
  private async handleEnroll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = enrollHostRequestSchema.safeParse(JSON.parse((await readBody(request)) || 'null'))
    if (!parsed.success) return sendJson(response, 400, { error: 'invalid_request' })
    const { publicJwk } = parsed.data
    const ticket = this.bootTickets.get(parsed.data.ticket)
    if (!ticket) return sendJson(response, 401, { error: 'invalid_ticket' })
    if (ticket.enrolled) {
      const isSameKey = ticket.enrolled.publicJwk.x === publicJwk.x && ticket.enrolled.publicJwk.y === publicJwk.y
      return isSameKey ? sendJson(response, 200, ticket.enrolled.answer) : sendJson(response, 401, { error: 'invalid_ticket' })
    }
    // The address the machine's operator gave, else the one the control plane has.
    const address = parsed.data.address ?? ticket.address
    if (address !== undefined && !isMachineAddress(address)) return sendJson(response, 400, { error: 'machine_address_invalid' })
    // Registering a host id again advances its generation: the earlier registration is superseded.
    const generation = (this.links.get(ticket.hostId)?.link.generation ?? 0) + 1
    const registration = this.issueRegistration(ticket.hostId, generation, { publicJwk, organizationId: ticket.organizationId, address, link: { desired: 'unlinked', tunnel: null } }, ticket.hasManagedCompute === true)
    const answer: EnrollHostResponse = { registration, oauthClient: { clientId: hostClientId(ticket.hostId) } }
    ticket.enrolled = { publicJwk, answer }
    sendJson(response, 200, answer)
  }

  /**
   * `POST /v1/hosts/:id/link` with the host's control token: turn the link on. A host
   * with an address is reached there, so the answer has no connector token. Any other
   * host gets a tunnel and its connector token. A personal host sets or changes its
   * address with the call.
   */
  private async handleLink(issued: IssuedLink, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = linkHostRequestSchema.safeParse(JSON.parse((await readBody(request)) || 'null'))
    if (!parsed.success) return sendJson(response, 400, { error: 'invalid_request' })
    if (parsed.data.address && !issued.organizationId) {
      if (!isMachineAddress(parsed.data.address)) return sendJson(response, 400, { error: 'machine_address_invalid' })
      issued.address = parsed.data.address
    }
    const { hostId } = issued.link
    const tunnel = { hostname: issued.address ? new URL(issued.address).host : `h-${hostId}.lab.invalid`, proxiedPort: parsed.data.proxiedPort }
    issued.link = { ...issued.link, desired: 'linked', tunnel }
    sendJson(response, 200, issued.address ? { tunnel } : { tunnel, connectorToken: LAB_CONNECTOR_TOKEN })
  }

  /** The OAuth token endpoint, for host clients only: client credentials and token exchange. */
  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, error: string, description: string) => sendJson(response, status, { error, error_description: description })
    let body = ''
    for await (const chunk of request) body += chunk
    const fields = Object.fromEntries(new URLSearchParams(body))
    const client = this.clientOf(fields)
    if (!client) return refuse(401, 'invalid_client', 'Unknown host client.')
    const parsed = tokenRequestSchema.safeParse(fields)
    if (!parsed.success) return refuse(400, 'invalid_request', 'Not a token exchange or client credentials.')
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
    const subject = this.verified(form.subject_token)
    if (!subject || !tokenAudiences(subject).includes(hostAudience(client.hostId))) return refuse(400, 'invalid_grant', 'The subject token is not for this host.')
    // A person's own token only, never a delegated one; the delegation keeps its grant.
    if (subject.act || !subject.grant_id) return refuse(400, 'invalid_grant', 'The subject is not a person\'s token.')
    const scope = form.delegation_scope === 'personal' && !form.organization_id ? 'personal' as const
      : form.organization_id && !form.delegation_scope ? { organizationId: form.organization_id } : null
    if (!scope) return refuse(400, 'invalid_request', 'Name one scope: an organization or personal.')
    // `personal` is the owner's alone (hostReach on the real account plane); a cloud machine has no owner.
    if (scope === 'personal' && subject.access !== 'owner') return refuse(400, 'invalid_grant', 'not_the_owner')
    const delegation: Delegation = { hostId: client.hostId, userId: subject.sub, scope, grantId: subject.grant_id }
    const checked = this.liveCheck(delegation)
    if ('error' in checked) return sendJson(response, 400, checked)
    this.delegations.set(delegationKey(delegation.hostId, delegation.userId, scope), delegation)
    sendJson(response, 200, { access_token: this.signDelegated(client.hostId, checked.persona, scope, delegation.grantId), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, issued_token_type: ACCESS_TOKEN_TYPE })
  }

  /** A token for a delegation the issuer keeps, asked with the host's control token; the live check runs on every ask. */
  private async handleDelegationToken(hostId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.controlCaller(hostId, request.headers.authorization)) return sendJson(response, 401, { error: 'invalid_host_credential' })
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = delegationTokenRequestSchema.safeParse(JSON.parse(body || 'null'))
    if (!parsed.success) return sendJson(response, 400, { error: 'invalid_request' })
    const { userId, scope, resource } = parsed.data
    const delegation = this.delegations.get(delegationKey(hostId, userId, scope))
    if (!delegation) return sendJson(response, 403, { error: 'no_delegation', solus_refusal: 'no_delegation' })
    // The Lab mints no token for another host.
    if (resource !== SOLUS_API_AUDIENCE && resource !== ACCOUNT_AUDIENCE) return sendJson(response, 403, { error: 'host_not_reachable', solus_refusal: 'host_not_reachable' })
    const checked = this.liveCheck(delegation)
    if ('error' in checked) {
      this.delegations.delete(delegationKey(hostId, userId, scope))
      return sendJson(response, 403, checked)
    }
    sendJson(response, 200, { access_token: this.signDelegated(hostId, checked.persona, scope, delegation.grantId), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS })
  }

  /** The live check, at the exchange and at every token: the person, and in an organization their membership and the host's. */
  private liveCheck(delegation: Delegation): { persona: SignedInPersona } | { error: string; error_description: string; solus_refusal: string } {
    const personas: readonly Persona[] = Object.values(PERSONAS)
    const persona = personas.find((candidate): candidate is SignedInPersona => candidate.kind !== 'guest' && candidate.userId === delegation.userId)
    if (!persona) return { error: 'invalid_grant', error_description: 'Unknown person.', solus_refusal: 'not_a_member' }
    const scope = delegation.scope
    if (scope !== 'personal') {
      if (persona.kind !== 'org-member' || persona.organizationId !== scope.organizationId) return { error: 'invalid_grant', error_description: 'The person is not a member of the organization.', solus_refusal: 'not_a_member' }
      const hostOrganization = this.links.get(delegation.hostId)?.organizationId ?? this.sharedOrganizations.get(delegation.hostId)
      if (hostOrganization !== scope.organizationId) return { error: 'invalid_grant', error_description: 'The host does not work for the organization.', solus_refusal: 'host_not_in_organization' }
    }
    return { persona }
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
      if (hostClientId(hostId) !== claims.data.sub) continue
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
    if (!header || !body || !signature || !issued) return false
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
