import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import {
  ACCESS_TOKEN_TYPE,
  CLIENT_ASSERTION_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  delegationRefusalBodySchema,
  delegationScopeSchema,
  hostDelegationTokenResponseSchema,
  type DelegationScope,
  type HostDelegationTokenRequest,
  type PersonAccessTokenClaims,
  type HostRegistration,
} from '@solus/contracts/uplink'
import { tokenResourceUri, type TokenResource } from '@solus/contracts/auth/clients'
import { SolusApiClient, SolusApiHttp, WorkspaceRequestError, type SolusApiHttpOptions } from '@solus/contracts/solus-api/client'
import type { WorkspaceSessionAdmissionRequest } from '@solus/contracts/solus-api'
import type { FetchLike, TokenVerdict } from '../admission/access-tokens'
import type { HostCredential } from '../host/host-credential'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'

const log = createLogger('main', 'delegations')

/**
 * How this host acts for people (docs/adr/0001-standard-authentication.md §2.2 rule 6,
 * §3.4). A delegation is a row on the account plane: this host may act for one person
 * in one scope — their own host (`personal`) or one organization — bound to the client
 * grant it was made from. The host keeps no secret for it. It asks the account plane
 * for a token when it needs one (`POST /v1/hosts/{hostId}/delegation-token`, with its
 * own control token), for the Solus API, the account plane, or another host the person
 * reaches; each ask is the account plane's live check. Tokens are kept in memory per
 * person, scope, and resource until a minute before they end.
 *
 * A delegation is made only from an access token a person's client presented here
 * (`establish` through `delegateFromPresentedToken`: at the ticket door, with
 * `authRenew` or `accountPresent` on an open socket, or by the desktop's own client in
 * this process, `transport/local-client.ts`): the token exchange (RFC 8693), with the
 * host's key (`private_key_jwt`, `HostCredential`). The host remembers whom it acts for
 * (`delegations.json`: person, scope, and grant, no token), so a restart resumes work
 * (an automation included) without anyone reconnecting. A refusal means the client
 * grant ended (`GRANT_REVOKED`: a sign-out), the person left the organization, or the
 * host was detached, and `onRevoked` ends their work here in that scope. When the
 * account plane holds no row (`no_delegation`), the person's signed-in client in this
 * process presents again (`renew`), and the delegation is made again from it.
 */

export type { DelegationScope }

/** A delegated token is for the Solus API, the account plane, or another host the person reaches (host-reach.md §3). */
export type DelegatedResource = TokenResource

/** The account plane's refusals of a token for another host. They refuse one host, not the delegation (host-reach.md §3.1). */
const HOST_REACH_REFUSALS: ReadonlySet<string> = new Set(['host_not_reachable', 'host_not_ready', 'host_outside_organization'])

export type DelegationRefusal = 'GRANT_REVOKED' | 'ORGANIZATION_ACCESS_REFUSED' | 'ORGANIZATION_API_UNAVAILABLE' | 'ORGANIZATION_AUTHORITY_MISSING' | 'HOST_NOT_REACHABLE'

export class DelegationError extends Error {
  constructor(readonly code: DelegationRefusal, message: string) {
    super(message)
    this.name = 'DelegationError'
  }
}

export interface DelegationsDeps {
  /** The registration: the account plane and host id the token route names, and the Solus API (`apiClient`); null when unregistered, and always in API mode. */
  registration: () => HostRegistration | null
  /** This host's credential, with which it makes a delegation at the token endpoint; null when the host is not registered. */
  credential: () => Pick<HostCredential, 'clientId' | 'tokenEndpoint' | 'assertion'> | null
  /** This host's own control token, with which it asks for a person's tokens. */
  controlToken: () => Promise<string>
  /** The account plane refused a token: the person may no longer work here in that scope. */
  onRevoked: (userId: string, scope: DelegationScope, refusal: DelegationRefusal) => void
  /** A delegation was made: what waited on the person's account (their cloud credentials) can be read now. */
  onEstablished?: (userId: string, scope: DelegationScope) => void
  /**
   * The host holds no delegation for the person, or the account plane has none
   * (`no_delegation`): the person's signed-in client in this process presents its
   * token again, and resolves once it tried. Absent where no client lives in the
   * process; there a connected client presents again before its token ends.
   */
  renew?: (userId: string, scope: DelegationScope) => Promise<void>
  fetchImpl?: FetchLike
  now?: () => number
}

const REQUEST_TIMEOUT_MS = 15_000
/** An access token this close to its end is replaced before it is used. */
const RENEWAL_MARGIN_MS = 60_000
const RECORD_FILE = 'delegations.json'

/** Whom this host acts for: no token. A file of another version is discarded: its people connect again. */
const recordSchema = z.object({
  version: z.literal(4),
  delegations: z.array(z.object({ userId: z.string().min(1), scope: delegationScopeSchema, grantId: z.string().min(1) })),
})
const tokenAnswerSchema = hostDelegationTokenResponseSchema.pick({ access_token: true, expires_in: true })
/** The delegation-token route's refusal (`delegationRefusalBodySchema`), read leniently: the exchange's refusals carry other codes. */
const refusalSchema = delegationRefusalBodySchema.extend({ solus_refusal: z.string().optional() })
type Refusal = z.infer<typeof refusalSchema>
/** The parts of a presented token the exchange is keyed by. The ticket door verified it already. */
const subjectClaimsSchema = z.object({ sub: z.string().min(1), grant_id: z.string().min(1) })

interface Held {
  userId: string
  scope: DelegationScope
  /** The client grant the delegation was made from. */
  grantId: string
  /** The current access token for each resource. */
  tokens: Map<string, { token: string; expiresAt: number }>
  /** Concurrent asks for one resource share one request. */
  asking: Map<string, Promise<string>>
}

const scopeKey = (scope: DelegationScope): string => scope === 'personal' ? 'personal' : `organization:${scope.organizationId}`
const keyOf = (userId: string, scope: DelegationScope): string => `${scopeKey(scope)}\u0000${userId}`

/** The person and client grant a presented access token names, or null for a token that names neither. */
function subjectOf(token: string): z.infer<typeof subjectClaimsSchema> | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const parsed = subjectClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class Delegations {
  private held: Map<string, Held> | null = null
  /** Concurrent callers share the first exchange for each person and scope. */
  private readonly establishing = new Map<string, Promise<void>>()
  /** The person and organization each Solus session's agent acts for, by session id and record id. */
  private readonly actors = new Map<string, { userId: string; organizationId: string }>()

  constructor(private readonly deps: DelegationsDeps) {}

  /** Whether this host can act for the person in the scope without them. */
  has(userId: string, scope: DelegationScope): boolean {
    return this.load().has(keyOf(userId, scope))
  }

  /**
   * Holds a delegation for the person in the scope: the token exchange, with an access
   * token their client presented for this host. A delegation already held stays bound
   * to the grant that made it: nothing is exchanged again.
   */
  async establish(subjectToken: string, scope: DelegationScope): Promise<void> {
    const subject = subjectOf(subjectToken)
    if (!subject) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This sign-in cannot let this machine act for you. Sign in to Solus again.')
    const userId = subject.sub
    if (this.has(userId, scope)) return
    const key = keyOf(userId, scope)
    const existing = this.establishing.get(key)
    if (existing) return existing
    const isCurrent = (): boolean => this.establishing.get(key) === pending
    const pending: Promise<void> = (async () => {
      const answer = await this.exchange(userId, scope, subjectToken)
      if (!isCurrent()) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine’s authorization changed. Reconnect and send again.')
      // The exchanged token is for both our servers: no request for either while it is good.
      const first = { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 }
      const tokens = new Map([[tokenResourceUri({ kind: 'api' }), first], [tokenResourceUri({ kind: 'account' }), first]])
      this.load().set(key, { userId, scope, grantId: subject.grant_id, tokens, asking: new Map() })
      this.save()
      log.info('delegation_held', { userId, scope: scopeKey(scope), grantId: subject.grant_id })
      this.deps.onEstablished?.(userId, scope)
    })().finally(() => {
      if (this.establishing.get(key) === pending) this.establishing.delete(key)
    })
    this.establishing.set(key, pending)
    return pending
  }

  /**
   * A current access token for the person in the scope, for one resource. A delegation
   * that is not held, here or on the account plane, is made again from the person's
   * sign-in (`renew`) before the call fails: while they are signed in, the host acts
   * for them. An outage keeps the delegation and fails the call.
   */
  async accessToken(userId: string, scope: DelegationScope, resource: DelegatedResource): Promise<string> {
    try {
      return await this.heldToken(userId, scope, resource)
    } catch (error) {
      if (!this.deps.renew || !(error instanceof DelegationError) || error.code !== 'ORGANIZATION_AUTHORITY_MISSING' || this.has(userId, scope)) throw error
      log.info('delegation_renewing', { userId, scope: scopeKey(scope) })
      await this.deps.renew(userId, scope)
      return this.heldToken(userId, scope, resource)
    }
  }

  private async heldToken(userId: string, scope: DelegationScope, resource: DelegatedResource): Promise<string> {
    const key = keyOf(userId, scope)
    // A connection that just arrived may still be making the delegation: its turn waits for it.
    const establishing = this.load().has(key) ? null : this.establishing.get(key)
    if (establishing) await establishing.catch(() => undefined)
    const held = this.load().get(key)
    if (!held) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine does not act for you here yet. Connect from Solus and send again.')
    const audience = tokenResourceUri(resource)
    const current = held.tokens.get(audience)
    if (current && current.expiresAt - this.now() > RENEWAL_MARGIN_MS) return current.token
    const asking = held.asking.get(audience)
    if (asking) return asking
    const pending = this.delegationToken(held, audience).finally(() => {
      if (held.asking.get(audience) === pending) held.asking.delete(audience)
    })
    held.asking.set(audience, pending)
    return pending
  }

  /**
   * A person's turn in an organization session on this host: check their delegation is
   * still good, and for a new root, the Solus API's admission before the provider
   * starts. A continuation whose account plane cannot be reached goes on with the
   * delegation held; a refusal never does.
   */
  async actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean; record?: WorkspaceSessionAdmissionRequest['record'] }): Promise<void> {
    const scope = { organizationId: input.organizationId }
    try {
      await this.accessToken(input.userId, scope, { kind: 'api' })
    } catch (error) {
      if (input.admit || !(error instanceof DelegationError) || error.code !== 'ORGANIZATION_API_UNAVAILABLE') throw error
      log.warn('delegation_kept', { sessionId: input.sessionId, organizationId: input.organizationId, error: error.message })
    }
    if (input.admit) await this.admit(input.userId, scope, input.sessionId, input.record)
    this.bindSession(input.sessionId, { userId: input.userId, organizationId: input.organizationId })
  }

  private async admit(userId: string, scope: DelegationScope, sessionId: string, record: WorkspaceSessionAdmissionRequest['record']): Promise<void> {
    try {
      await this.apiClient(userId, scope).request('admitSession', { body: { sessionId, record } })
    } catch (error) {
      if (error instanceof DelegationError) throw error
      if (error instanceof WorkspaceRequestError && (error.status === 401 || error.status === 403 || error.status === 409)) {
        throw new DelegationError('ORGANIZATION_ACCESS_REFUSED', `The Solus API refused this session: ${error.message}`)
      }
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `The Solus API is not reachable: ${error instanceof Error ? error.message : String(error)}. Your message was not sent; try again.`)
    }
  }

  /** The Solus API as the person, through this host's delegation; the API is the one the registration named. */
  apiClient(userId: string, scope: DelegationScope): SolusApiClient {
    const apiUrl = this.deps.registration()?.apiUrl
    const options: SolusApiHttpOptions = {
      baseUrl: () => {
        if (!apiUrl) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', "This machine's registration names no Solus API. Sign in to Solus on this machine again to run organization work.")
        return new URL(apiUrl).origin
      },
      contextKey: () => keyOf(userId, scope),
      acquireSource: () => this.accessToken(userId, scope, { kind: 'api' }),
    }
    if (this.deps.fetchImpl) options.fetchImpl = this.deps.fetchImpl
    return new SolusApiClient(new SolusApiHttp(options))
  }

  /** Who a session's agent acts for: set when a person's turn is admitted. */
  bindSession(sessionId: string, actor: { userId: string; organizationId: string }): void {
    this.actors.set(sessionId, actor)
  }

  actorOf(sessionId: string): { userId: string; organizationId: string } | null {
    return this.actors.get(sessionId) ?? null
  }

  /** The sessions whose agent acts for the person in the scope. A personal delegation carries no session: its owner's own work runs on no delegation. */
  sessionsActingFor(userId: string, scope: DelegationScope): string[] {
    if (scope === 'personal') return []
    return [...this.actors].filter(([, actor]) => actor.userId === userId && actor.organizationId === scope.organizationId).map(([id]) => id)
  }

  /** Every person and scope this host acts for. */
  holders(): Array<{ userId: string; scope: DelegationScope }> {
    return [...this.load().values()].map((held) => ({ userId: held.userId, scope: held.scope }))
  }

  /** The person no longer works here in that scope. */
  forget(userId: string, scope: DelegationScope): void {
    this.establishing.delete(keyOf(userId, scope))
    const held = this.load()
    if (!held.delete(keyOf(userId, scope))) return
    for (const id of this.sessionsActingFor(userId, scope)) this.actors.delete(id)
    this.save()
  }

  /**
   * A client grant ended in this process (a sign-out of the desktop that hosts it):
   * every delegation made from it ends now, as the account plane's refusal would end
   * it at its next token (ADR 0001 §2.2 rule 5). Delegations from other grants stay.
   */
  forgetGrant(grantId: string): void {
    for (const held of [...this.load().values()].filter((entry) => entry.grantId === grantId)) {
      this.deps.onRevoked(held.userId, held.scope, 'GRANT_REVOKED')
      this.forget(held.userId, held.scope)
    }
  }

  /** The registration went or changed: every delegation was the old client's. */
  clear(): void {
    this.establishing.clear()
    this.held = new Map()
    this.actors.clear()
    rmSync(recordPath(), { force: true })
  }

  /** The token exchange that makes a delegation, as this host's client; the account plane keeps the delegation. */
  private async exchange(userId: string, scope: DelegationScope, subjectToken: string): Promise<z.infer<typeof tokenAnswerSchema>> {
    const credential = this.deps.credential()
    if (!credential) throw notRegistered()
    const response = await this.send(userId, scope, async () => (this.deps.fetchImpl ?? fetch)(credential.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        ...(scope === 'personal' ? { delegation_scope: 'personal' } : { organization_id: scope.organizationId }),
        client_id: credential.clientId,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await credential.assertion(credential.tokenEndpoint),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }))
    if ('refusal' in response) {
      log.info('delegation_exchange_refused', { userId, scope: scopeKey(scope), status: response.status, error: response.refusal.error, refusal: response.refusal.solus_refusal ?? null })
      throw new DelegationError(refusalCode(response.refusal, response.status), response.refusal.error_description ?? 'Solus refused to let this machine act for you here.')
    }
    return response.answer
  }

  /** One token for a held delegation and one resource, from the account plane's delegation-token route. */
  private async delegationToken(held: Held, audience: string): Promise<string> {
    const registration = this.deps.registration()
    if (!registration) throw notRegistered()
    const body: HostDelegationTokenRequest = { userId: held.userId, scope: held.scope, resource: audience }
    const response = await this.send(held.userId, held.scope, async () => {
      let control: string
      try {
        control = await this.deps.controlToken()
      } catch (error) {
        throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `This machine could not prove itself to Solus: ${error instanceof Error ? error.message : String(error)}`)
      }
      return (this.deps.fetchImpl ?? fetch)(`${registration.directoryUrl}/v1/hosts/${encodeURIComponent(registration.hostId)}/delegation-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    })
    if ('answer' in response) {
      // A delegation forgotten or made again while this ran keeps no token of this one.
      if (this.load().get(keyOf(held.userId, held.scope)) === held) held.tokens.set(audience, { token: response.answer.access_token, expiresAt: this.now() + response.answer.expires_in * 1000 })
      return response.answer.access_token
    }
    throw this.refused(held, audience, response.refusal, response.status)
  }

  /**
   * Sends one request to the account plane and reads its answer: a token, or a refusal.
   * Only no answer, a 5xx, a 408, or a 429 is the account plane being unreachable, and
   * what is held is kept for the next try. A 401 refuses this host, not the person.
   */
  private async send(userId: string, scope: DelegationScope, request: () => Promise<Response>): Promise<{ answer: z.infer<typeof tokenAnswerSchema> } | { refusal: Refusal; status: number }> {
    let response: Response
    try {
      response = await request()
    } catch (error) {
      if (error instanceof DelegationError) throw error
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `Solus is not reachable: ${error instanceof Error ? error.message : String(error)}. Try again.`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const answer = tokenAnswerSchema.safeParse(body)
      if (answer.success) return { answer: answer.data }
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus answered with an unreadable token.')
    }
    const parsed = refusalSchema.safeParse(body)
    const refusal = parsed.success ? parsed.data : { error: `http_${response.status}` }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      log.warn('delegation_account_plane_unavailable', { userId, scope: scopeKey(scope), status: response.status, error: refusal.error })
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `Solus could not authorize this (${response.status}). Try again.`)
    }
    if (response.status === 401 || refusal.solus_refusal === 'host_not_registered') {
      log.warn('delegation_host_unrecognized', { userId, scope: scopeKey(scope), status: response.status, error: refusal.error })
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus did not recognize this machine. Link it again.')
    }
    return { refusal, status: response.status }
  }

  /**
   * The account plane answered no to a token. A refusal of another host names that
   * host, and the delegation stays (host-reach.md §3.1). `no_delegation` means it holds
   * no row: the record goes, and the person's sign-in makes it again (`renew`). Any
   * other refusal ends the delegation and the person's work in that scope.
   */
  private refused(held: Held, audience: string, refusal: Refusal, status: number): DelegationError {
    const { userId, scope } = held
    const reason = refusal.solus_refusal ?? null
    if (HOST_REACH_REFUSALS.has(reason ?? '')) {
      log.info('host_reach_refused', { userId, scope: scopeKey(scope), audience, refusal: reason })
      return new DelegationError('HOST_NOT_REACHABLE', refusal.error_description ?? 'You cannot reach that host from here.')
    }
    // A delegation made again while this ran is not this one.
    const isCurrent = this.load().get(keyOf(userId, scope)) === held
    if (reason === 'no_delegation') {
      log.info('delegation_missing', { userId, scope: scopeKey(scope) })
      if (isCurrent) this.forget(userId, scope)
      return new DelegationError('ORGANIZATION_AUTHORITY_MISSING', refusal.error_description ?? 'Solus does not let this machine act for you here yet. Reconnect and send again.')
    }
    const code = refusalCode(refusal, status)
    log.info('delegation_refused', { userId, scope: scopeKey(scope), status, error: refusal.error, refusal: reason, code })
    // The work ends first, while the sessions acting for the person are still known, then the delegation goes.
    if (isCurrent) {
      this.deps.onRevoked(userId, scope, code)
      this.forget(userId, scope)
    }
    const fallback = code === 'GRANT_REVOKED'
      ? 'The sign-in that let this machine act for you has ended. Sign in to Solus again.'
      : code === 'ORGANIZATION_AUTHORITY_MISSING' ? 'Solus did not let this machine act for you here. Reconnect and send again.' : 'Solus refused to let this machine act for you here.'
    return new DelegationError(code, refusal.error_description ?? fallback)
  }

  private load(): Map<string, Held> {
    if (this.held) return this.held
    let stored: z.infer<typeof recordSchema> | null = null
    try {
      if (existsSync(recordPath())) {
        const parsed = recordSchema.safeParse(JSON.parse(readFileSync(recordPath(), 'utf8')))
        stored = parsed.success ? parsed.data : null
      }
    } catch (error) {
      log.warn('delegation_record_unreadable', { error: error instanceof Error ? error.message : String(error) })
    }
    this.held = new Map((stored?.delegations ?? []).map(({ userId, scope, grantId }) => [keyOf(userId, scope), { userId, scope, grantId, tokens: new Map(), asking: new Map() }]))
    return this.held
  }

  /** Whom this host acts for, and nothing secret. */
  private save(): void {
    const delegations = [...this.load().values()].map(({ userId, scope, grantId }) => ({ userId, scope, grantId }))
    const path = recordPath()
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: 4, delegations }))
    renameSync(`${path}.tmp`, path)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function recordPath(): string {
  return join(dataDir(), RECORD_FILE)
}

function notRegistered(): DelegationError {
  return new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'This machine is not registered to a Solus account. Sign in to Solus on this machine to run organization work.')
}

/**
 * What a refusal means: the client grant ended, or the person may not work here in
 * that scope. A 403 that names no reason is an answer, not an outage: trying again
 * changes nothing until the person connects again.
 */
function refusalCode(refusal: Refusal, status: number): DelegationRefusal {
  if (refusal.solus_refusal === 'grant_revoked') return 'GRANT_REVOKED'
  return status === 403 && !refusal.solus_refusal ? 'ORGANIZATION_AUTHORITY_MISSING' : 'ORGANIZATION_ACCESS_REFUSED'
}

/**
 * The delegations a person's admitted connection makes (ADR 0001 §2.2 rule 6, §3.4):
 * the owner's is `personal`; a connection that works in an organization makes that
 * organization's too. The ticket door admitted a member only in an organization their
 * token lists, and the account plane checks the owner's membership at the exchange.
 */
export function delegationScopesFor(claims: PersonAccessTokenClaims, organizationId: string | undefined): DelegationScope[] {
  const scopes: DelegationScope[] = claims.access === 'owner' ? ['personal'] : []
  if (organizationId && (claims.access === 'owner' || claims.organizations?.some((entry) => entry.id === organizationId))) scopes.push({ organizationId })
  return scopes
}

/**
 * A person's client presented an access token here (ADR 0001 §2.2 rule 6, §6 item 5):
 * at the ticket door, with `authRenew`, with `accountPresent` on any admitted socket, or
 * from the desktop's own client in this process. This makes each delegation the token
 * names that this host does not hold yet. A held one stays as it is (`establish`).
 * Only a person's own token for this host makes one: the verifier checked the audience,
 * and a delegated token (`act`) never makes one. The answer is true when the token was
 * accepted and every delegation it names is held now. The token is never logged.
 */
export async function delegateFromPresentedToken(
  verdict: TokenVerdict,
  token: string,
  organizationIds: ReadonlyArray<string | undefined>,
  establish: (subjectToken: string, scope: DelegationScope) => Promise<void>,
): Promise<boolean> {
  const claims = verdict.ok ? verdict.claims : null
  if (!claims || claims.act) return false
  const scopes = new Map<string, DelegationScope>()
  for (const organizationId of organizationIds) {
    for (const scope of delegationScopesFor(claims, organizationId)) scopes.set(scopeKey(scope), scope)
  }
  if (scopes.size === 0) return false
  const outcomes = await Promise.all([...scopes.values()].map((scope) => establish(token, scope).then(() => true, (error: unknown) => {
    log.info('delegation_not_established', { userId: claims.sub, scope: scopeKey(scope), error: error instanceof Error ? error.message : String(error) })
    return false
  })))
  return outcomes.every(Boolean)
}
