import { join } from 'path'
import { z } from 'zod'
import {
  ACCESS_TOKEN_TYPE,
  CLIENT_ASSERTION_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type PersonAccessTokenClaims,
  type UplinkLinkConfig,
} from '@solus/contracts/uplink'
import { tokenResourceUri, type TokenResource } from '@solus/contracts/auth/clients'
import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { FetchLike } from '../admission/access-tokens'
import type { HostCredential } from '../host/host-credential'
import { secretStore } from '../platform/secrets'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'

const log = createLogger('main', 'delegations')

/**
 * What this host holds to act for people (docs/adr/0001-standard-authentication.md
 * §2.2 rule 6, §3.4): for each person and scope — their own host (`personal`) or one
 * organization — a refresh token the account plane issued to this host's own OAuth
 * client in a token exchange (RFC 8693), and the current five-minute access tokens.
 * The host authenticates every exchange and refresh with its key (`private_key_jwt`,
 * `HostCredential`). The Solus API uses this class too, with its service credential:
 * there the subject is the API token a person's client presented, and the scope is one
 * organization (ADR 0001 §6.2).
 *
 * A delegation is made only from an access token a person's client presented here
 * (`establish`: at the ticket door, or by the desktop's own client in this process,
 * `transport/local-client.ts`), and it is bound to that client's grant. After
 * that nothing is asked per prompt: the host refreshes when it needs a token. Every
 * refresh is the account plane's live check. A refusal means the client grant ended
 * (`GRANT_REVOKED`: a sign-out), the person left the organization, or the host was
 * detached, and `onRevoked` ends their work here in that scope. Refresh tokens are
 * kept in the secret store, so a restart resumes work (an automation included)
 * without anyone reconnecting.
 */

export type DelegationScope = { organizationId: string } | 'personal'

/** A delegated token is for the Solus API or the account plane, never for a host. */
export type DelegatedResource = Exclude<TokenResource, { kind: 'host' }>

export type DelegationRefusal = 'GRANT_REVOKED' | 'ORGANIZATION_ACCESS_REFUSED' | 'ORGANIZATION_API_UNAVAILABLE' | 'ORGANIZATION_AUTHORITY_MISSING'

export class DelegationError extends Error {
  constructor(readonly code: DelegationRefusal, message: string) {
    super(message)
    this.name = 'DelegationError'
  }
}

export interface DelegationsDeps {
  /** The link, for the Solus API it names (`apiClient`); null when unlinked, and always in API mode. */
  link: () => UplinkLinkConfig | null
  /** This host's credential (or the Solus API's), with which it authenticates at the token endpoint; null when the host is not linked. */
  credential: () => Pick<HostCredential, 'clientId' | 'tokenEndpoint' | 'assertion'> | null
  /** The account plane refused a refresh: the person may no longer work here in that scope. */
  onRevoked: (userId: string, scope: DelegationScope, refusal: DelegationRefusal) => void
  fetchImpl?: FetchLike
  now?: () => number
}

/**
 * What an organization run's credential may do at the Solus API: its tasks and works,
 * its sessions, admitting one, reading Insights (the person's own turns other hosts
 * ran), and the person's agent profile and its MCP connections (plans/020 §4, §5).
 */
const DELEGATED_SCOPES = ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'sessions:admit', 'insights:read', 'profile:read', 'integrations:read', 'integrations:write'] as const

const REQUEST_TIMEOUT_MS = 15_000
/** An access token this close to its end is replaced before it is used. */
const RENEWAL_MARGIN_MS = 60_000
const SECRET_KEY = 'delegations'

const scopeSchema = z.union([z.literal('personal'), z.object({ organizationId: z.string().min(1) })])
/**
 * Version 3 keys each refresh token by person and scope, and keeps the client grant it
 * was made from, so a sign-out in this process forgets it at once. A file of another
 * version is discarded: its people connect again.
 */
const storedSchema = z.object({
  version: z.literal(3),
  delegations: z.array(z.object({ userId: z.string().min(1), scope: scopeSchema, grantId: z.string().min(1), refreshToken: z.string().min(1) })),
})
const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
})
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional(), solus_refusal: z.string().optional() })
/** The parts of a presented token the exchange is keyed by. The ticket door verified it already. */
const subjectClaimsSchema = z.object({ sub: z.string().min(1), grant_id: z.string().min(1) })

interface Held {
  userId: string
  scope: DelegationScope
  /** The client grant the delegation was made from. */
  grantId: string
  refreshToken: string
  /** The current access token for each audience. */
  tokens: Map<string, { token: string; expiresAt: number }>
  /** Refreshes run one at a time: a rotated refresh token cannot be used twice. */
  lock: Promise<void>
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
      const answer = await this.tokenRequest(userId, scope, {
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        ...(scope === 'personal' ? { delegation_scope: 'personal' } : { organization_id: scope.organizationId }),
      })
      if (!isCurrent()) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine’s authorization changed. Reconnect and send again.')
      if (!answer.refresh_token) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus answered the exchange without a refresh token.')
      // The first access token is for both delegated resources.
      const first = { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 }
      const tokens = new Map([[tokenResourceUri({ kind: 'api' }), first], [tokenResourceUri({ kind: 'account' }), first]])
      this.load().set(key, { userId, scope, grantId: subject.grant_id, refreshToken: answer.refresh_token, tokens, lock: Promise.resolve() })
      this.save()
      log.info('delegation_held', { userId, scope: scopeKey(scope), grantId: subject.grant_id })
    })().finally(() => {
      if (this.establishing.get(key) === pending) this.establishing.delete(key)
    })
    this.establishing.set(key, pending)
    return pending
  }

  /** A current access token for the person in the scope, for one resource; refreshed when needed. */
  async accessToken(userId: string, scope: DelegationScope, resource: DelegatedResource): Promise<string> {
    const key = keyOf(userId, scope)
    // A connection that just arrived may still be making the delegation: its turn waits for it.
    const establishing = this.load().has(key) ? null : this.establishing.get(key)
    if (establishing) await establishing.catch(() => undefined)
    const held = this.load().get(key)
    if (!held) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine does not act for you here yet. Connect from Solus and send again.')
    const audience = tokenResourceUri(resource)
    const current = this.current(held, audience)
    if (current) return current
    const previous = held.lock
    let release!: () => void
    held.lock = new Promise((resolve) => { release = resolve })
    try {
      await previous
      return this.current(held, audience) ?? await this.refresh(held, audience)
    } finally {
      release()
    }
  }

  /**
   * A person's turn in an organization session on this host: check their delegation is
   * still good, and for a new root, the Solus API's admission before the provider
   * starts. A continuation whose account plane cannot be reached goes on with the
   * delegation held; a refusal never does.
   */
  async actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean }): Promise<void> {
    const scope = { organizationId: input.organizationId }
    try {
      await this.accessToken(input.userId, scope, { kind: 'api' })
    } catch (error) {
      if (input.admit || !(error instanceof DelegationError) || error.code !== 'ORGANIZATION_API_UNAVAILABLE') throw error
      log.warn('delegation_kept', { sessionId: input.sessionId, organizationId: input.organizationId, error: error.message })
    }
    if (input.admit) await this.admit(input.userId, scope, input.sessionId)
    this.bindSession(input.sessionId, { userId: input.userId, organizationId: input.organizationId })
  }

  private async admit(userId: string, scope: DelegationScope, sessionId: string): Promise<void> {
    try {
      await this.apiClient(userId, scope).request('admitSession', { body: { sessionId } })
    } catch (error) {
      if (error instanceof DelegationError) throw error
      if (error instanceof WorkspaceRequestError && (error.status === 401 || error.status === 403 || error.status === 409)) {
        throw new DelegationError('ORGANIZATION_ACCESS_REFUSED', `The Solus API refused this session: ${error.message}`)
      }
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `The Solus API is not reachable: ${error instanceof Error ? error.message : String(error)}. Your message was not sent; try again.`)
    }
  }

  /** The Solus API as the person, through this host's delegation; the API is the one the link named. */
  apiClient(userId: string, scope: DelegationScope): SolusApiClient {
    const apiUrl = this.deps.link()?.apiUrl
    const options: ConstructorParameters<typeof SolusApiClient>[0] = {
      baseUrl: () => {
        if (!apiUrl) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', "This machine's link names no Solus API. Link it again to run organization work.")
        return new URL(apiUrl).origin
      },
      contextKey: () => keyOf(userId, scope),
      acquireSource: () => this.accessToken(userId, scope, { kind: 'api' }),
      scopes: [...DELEGATED_SCOPES],
    }
    if (this.deps.fetchImpl) options.fetchImpl = this.deps.fetchImpl
    return new SolusApiClient(options)
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
   * it at the next refresh (ADR 0001 §2.2 rule 5). Delegations from other grants stay.
   */
  forgetGrant(grantId: string): void {
    for (const held of [...this.load().values()].filter((entry) => entry.grantId === grantId)) {
      this.deps.onRevoked(held.userId, held.scope, 'GRANT_REVOKED')
      this.forget(held.userId, held.scope)
    }
  }

  /** The link went: every delegation was the old client's. */
  clear(): void {
    this.establishing.clear()
    this.held = new Map()
    this.actors.clear()
    secretStore().remove(SECRET_KEY, electronPath())
  }

  private current(held: Held, audience: string): string | null {
    const token = held.tokens.get(audience)
    return token && token.expiresAt - this.now() > RENEWAL_MARGIN_MS ? token.token : null
  }

  /** One refresh for one audience (RFC 8707): the rotated refresh token is saved before the access token is used. */
  private async refresh(held: Held, audience: string): Promise<string> {
    const answer = await this.tokenRequest(held.userId, held.scope, { grant_type: 'refresh_token', refresh_token: held.refreshToken, resource: audience })
    held.tokens.set(audience, { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 })
    if (answer.refresh_token && answer.refresh_token !== held.refreshToken) {
      held.refreshToken = answer.refresh_token
      if (this.load().get(keyOf(held.userId, held.scope)) === held) this.save()
    }
    return answer.access_token
  }

  /**
   * One request to the account plane's token endpoint, as this host's client. An OAuth
   * refusal (`invalid_grant`) is the live check saying no: the delegation goes and the
   * host ends the person's work in that scope; `grant_revoked` says the client grant
   * it was made from ended. A 403 means the person must connect again. Anything else is
   * the account plane being unreachable, and what is held is kept for the next try.
   */
  private async tokenRequest(userId: string, scope: DelegationScope, form: Record<string, string>): Promise<z.infer<typeof tokenAnswerSchema>> {
    const credential = this.deps.credential()
    if (!credential) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'This machine is not linked to Solus. Link it again to run organization work.')
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(credential.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          ...form,
          client_id: credential.clientId,
          client_assertion_type: CLIENT_ASSERTION_TYPE,
          client_assertion: await credential.assertion(credential.tokenEndpoint),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `Solus is not reachable: ${error instanceof Error ? error.message : String(error)}. Try again.`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const answer = tokenAnswerSchema.safeParse(body)
      if (answer.success) return answer.data
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus answered with an unreadable token.')
    }
    const refusal = oauthErrorSchema.safeParse(body)
    if (refusal.success && refusal.data.error === 'invalid_grant') {
      const code: DelegationRefusal = refusal.data.solus_refusal === 'grant_revoked' ? 'GRANT_REVOKED' : 'ORGANIZATION_ACCESS_REFUSED'
      if (form.grant_type === 'refresh_token') {
        log.info('delegation_refused', { userId, scope: scopeKey(scope), code, reason: refusal.data.error_description ?? null })
        const held = this.load().get(keyOf(userId, scope))
        // A delegation established again while this refresh ran is not this one. The work
        // ends first, while the sessions acting for the person are still known, then the delegation goes.
        if (held?.refreshToken === form.refresh_token) {
          this.deps.onRevoked(userId, scope, code)
          this.forget(userId, scope)
        }
      }
      const fallback = code === 'GRANT_REVOKED' ? 'The sign-in that let this machine act for you has ended. Sign in to Solus again.' : 'Solus refused to let this machine act for you here.'
      throw new DelegationError(code, refusal.data.error_description ?? fallback)
    }
    if (response.status === 401) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus did not recognize this machine. Link it again.')
    // A 403 is an answer, not an outage: trying again changes nothing until the person connects again.
    if (response.status === 403) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Solus did not let this machine act for you here. Reconnect and send again.')
    throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `Solus could not authorize this (${response.status}). Try again.`)
  }

  private load(): Map<string, Held> {
    if (this.held) return this.held
    const stored = secretStore().loadJson(SECRET_KEY, electronPath(), storedSchema)
    this.held = new Map((stored?.delegations ?? []).map(({ userId, scope, grantId, refreshToken }) => [keyOf(userId, scope), { userId, scope, grantId, refreshToken, tokens: new Map(), lock: Promise.resolve() }]))
    return this.held
  }

  private save(): void {
    const delegations = [...this.load().values()].map(({ userId, scope, grantId, refreshToken }) => ({ userId, scope, grantId, refreshToken }))
    secretStore().saveJson(SECRET_KEY, electronPath(), { version: 3, delegations })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function electronPath(): string {
  return join(dataDir(), 'delegations.bin')
}

/**
 * How a token a person presented makes a delegation: a host makes one for each scope
 * its door names; the Solus API never makes a personal one, because it acts for a
 * person only in one organization (ADR 0001 §6.2).
 */
export function establishWith(delegations: Pick<Delegations, 'establish'>, apiMode: boolean): (subjectToken: string, scope: DelegationScope) => Promise<void> {
  return (subjectToken, scope) => apiMode && scope === 'personal' ? Promise.resolve() : delegations.establish(subjectToken, scope)
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
