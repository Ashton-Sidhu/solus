import { join } from 'path'
import { z } from 'zod'
import {
  ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenEndpoint,
  type UplinkLinkConfig,
} from '@solus/contracts/uplink'
import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { FetchLike } from '../admission/access-tokens'
import { secretStore } from '../platform/secrets'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'

const log = createLogger('main', 'delegations')

/**
 * What this host holds to act for people (plans/010-standard-oauth.md): for each person
 * and organization, a refresh token the account plane issued to this host's own OAuth
 * client in a token exchange (RFC 8693), and the current five-minute access token.
 *
 * The exchange happens once, the first time a person's organization work reaches this
 * host, with the access token their client presented here. After that nothing is asked
 * per prompt: the host refreshes when the access token is about to run out and it
 * needs one. Every refresh is the account plane's live check; a refusal means the
 * person left the organization or the host was detached, and `onRevoked` ends their
 * work here. Refresh tokens are kept in the secret store, so a restart resumes work
 * (an automation included) without anyone reconnecting.
 */

export type DelegationRefusal = 'ORGANIZATION_ACCESS_REFUSED' | 'ORGANIZATION_API_UNAVAILABLE' | 'ORGANIZATION_AUTHORITY_MISSING'

export class DelegationError extends Error {
  constructor(readonly code: DelegationRefusal, message: string) {
    super(message)
    this.name = 'DelegationError'
  }
}

export interface DelegationsDeps {
  link: () => UplinkLinkConfig | null
  /** This host's OAuth client, from enrollment; null when the host is not linked. */
  client: () => { clientId: string; clientSecret: string } | null
  /** The person's current access token for this host: from their connection, or the owner's from the desktop. */
  personToken: (userId: string) => Promise<string | null> | string | null
  /** The account plane refused a refresh: the person may no longer work here in that organization. */
  onRevoked: (userId: string, organizationId: string) => void
  fetchImpl?: FetchLike
  now?: () => number
}

/** What an organization run's credential may do at the Solus API: its tasks and works, its sessions, admitting one, and reading Insights (the person's own turns other hosts ran). */
const DELEGATED_SCOPES = ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'sessions:admit', 'insights:read'] as const

const REQUEST_TIMEOUT_MS = 15_000
/** An access token this close to its end is replaced before it is used. */
const RENEWAL_MARGIN_MS = 60_000
const SECRET_KEY = 'delegations'

const storedSchema = z.object({
  version: z.literal(1),
  refreshTokens: z.record(z.string(), z.string().min(1)),
})
const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
})
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() })

interface Held {
  refreshToken: string
  accessToken: string | null
  expiresAt: number
  /** One refresh at a time: a rotated refresh token cannot be used twice. */
  renewing: Promise<string> | null
}

const keyOf = (userId: string, organizationId: string): string => `${organizationId}\u0000${userId}`

export class Delegations {
  private held: Map<string, Held> | null = null
  /** Concurrent callers share the first exchange for each person and organization. */
  private readonly establishing = new Map<string, Promise<void>>()
  /** The person and organization each Solus session's agent acts for, by session id and record id. */
  private readonly actors = new Map<string, { userId: string; organizationId: string }>()

  constructor(private readonly deps: DelegationsDeps) {}

  /** Whether this host can act for the person in the organization without them. */
  has(userId: string, organizationId: string): boolean {
    return this.load().has(keyOf(userId, organizationId))
  }

  /**
   * Holds a delegation for the person in the organization: the token exchange, with
   * the access token their client presented here, the first time; nothing after that.
   */
  async ensure(userId: string, organizationId: string): Promise<void> {
    if (this.has(userId, organizationId)) return
    const key = keyOf(userId, organizationId)
    const existing = this.establishing.get(key)
    if (existing) return existing
    const assertCurrent = (): void => {
      if (this.establishing.get(key) !== pending) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine’s authorization changed. Reconnect and send again.')
    }
    const pending: Promise<void> = (async () => {
      const subjectToken = await this.deps.personToken(userId)
      assertCurrent()
      if (!subjectToken) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Your sign-in for this machine expired. Reconnect and send again.')
      const answer = await this.tokenRequest(organizationId, userId, {
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        organization_id: organizationId,
      })
      assertCurrent()
      if (!answer.refresh_token) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus answered the exchange without a refresh token.')
      this.store(userId, organizationId, { refreshToken: answer.refresh_token, accessToken: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000, renewing: null })
      log.info('delegation_held', { userId, organizationId })
    })().finally(() => {
      if (this.establishing.get(key) === pending) this.establishing.delete(key)
    })
    this.establishing.set(key, pending)
    return pending
  }

  /** A current access token for the person in the organization, refreshed when needed. */
  async accessToken(userId: string, organizationId: string): Promise<string> {
    const held = this.load().get(keyOf(userId, organizationId))
    if (!held) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'This machine does not act for this person in this organization. Send from Solus again.')
    if (held.accessToken && held.expiresAt - this.now() > RENEWAL_MARGIN_MS) return held.accessToken
    held.renewing ??= this.refresh(userId, organizationId, held).finally(() => { held.renewing = null })
    return held.renewing
  }

  /**
   * A person's turn in an organization session on this host: hold their delegation,
   * check it is still good, and for a new root, the Solus API's admission before the
   * provider starts. A continuation whose account plane cannot be reached goes on
   * with the delegation held; a refusal never does.
   */
  async actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean }): Promise<void> {
    await this.ensure(input.userId, input.organizationId)
    try {
      await this.accessToken(input.userId, input.organizationId)
    } catch (error) {
      if (input.admit || !(error instanceof DelegationError) || error.code !== 'ORGANIZATION_API_UNAVAILABLE') throw error
      log.warn('delegation_kept', { sessionId: input.sessionId, organizationId: input.organizationId, error: error.message })
    }
    if (input.admit) await this.admit(input.userId, input.organizationId, input.sessionId)
    this.bindSession(input.sessionId, { userId: input.userId, organizationId: input.organizationId })
  }

  private async admit(userId: string, organizationId: string, sessionId: string): Promise<void> {
    try {
      await this.apiClient(userId, organizationId).request('admitSession', { body: { sessionId } })
    } catch (error) {
      if (error instanceof DelegationError) throw error
      if (error instanceof WorkspaceRequestError && (error.status === 401 || error.status === 403 || error.status === 409)) {
        throw new DelegationError('ORGANIZATION_ACCESS_REFUSED', `The Solus API refused this session: ${error.message}`)
      }
      throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `The Solus API is not reachable: ${error instanceof Error ? error.message : String(error)}. Your message was not sent; try again.`)
    }
  }

  /** The Solus API as the person, through this host's delegation; the API is the one the link named. */
  apiClient(userId: string, organizationId: string): SolusApiClient {
    const apiUrl = this.deps.link()?.apiUrl
    const options: ConstructorParameters<typeof SolusApiClient>[0] = {
      baseUrl: () => {
        if (!apiUrl) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', "This machine's link names no Solus API. Link it again to run organization work.")
        return new URL(apiUrl).origin
      },
      contextKey: () => keyOf(userId, organizationId),
      acquireSource: () => this.accessToken(userId, organizationId),
      scopes: [...DELEGATED_SCOPES],
    }
    if (this.deps.fetchImpl) options.fetchImpl = this.deps.fetchImpl
    return new SolusApiClient(options)
  }

  /** Who a session's agent acts for: set when a person's turn is admitted, by session id and, once known, record id. */
  bindSession(sessionId: string, actor: { userId: string; organizationId: string }): void {
    this.actors.set(sessionId, actor)
  }

  bindRecord(sessionId: string, recordId: string): void {
    const actor = this.actors.get(sessionId)
    if (actor) this.actors.set(recordId, actor)
  }

  actorOf(sessionOrRecordId: string): { userId: string; organizationId: string } | null {
    return this.actors.get(sessionOrRecordId) ?? null
  }

  /** The sessions (and records) whose agent acts for the person in the organization. */
  sessionsActingFor(userId: string, organizationId: string): string[] {
    return [...this.actors].filter(([, actor]) => actor.userId === userId && actor.organizationId === organizationId).map(([id]) => id)
  }

  /** Every person and organization this host acts for. */
  holders(): Array<{ userId: string; organizationId: string }> {
    return [...this.load().keys()].map((key) => {
      const [organizationId = '', userId = ''] = key.split('\u0000')
      return { userId, organizationId }
    })
  }

  /** The person no longer works here in that organization. */
  forget(userId: string, organizationId: string): void {
    this.establishing.delete(keyOf(userId, organizationId))
    const held = this.load()
    if (!held.delete(keyOf(userId, organizationId))) return
    for (const [id, actor] of this.actors) if (actor.userId === userId && actor.organizationId === organizationId) this.actors.delete(id)
    this.save()
  }

  /** The link went: every delegation was the old client's. */
  clear(): void {
    this.establishing.clear()
    this.held = new Map()
    this.actors.clear()
    secretStore().remove(SECRET_KEY, electronPath())
  }

  private async refresh(userId: string, organizationId: string, held: Held): Promise<string> {
    const answer = await this.tokenRequest(organizationId, userId, { grant_type: 'refresh_token', refresh_token: held.refreshToken })
    held.accessToken = answer.access_token
    held.expiresAt = this.now() + answer.expires_in * 1000
    if (answer.refresh_token && answer.refresh_token !== held.refreshToken) {
      held.refreshToken = answer.refresh_token
      this.save()
    }
    return answer.access_token
  }

  /**
   * One request to the account plane's token endpoint, as this host's client. An OAuth
   * refusal (`invalid_grant`) is the live check saying no: the delegation goes and the
   * host ends the person's work. A 403 means the person must connect again. Anything
   * else is the account plane being unreachable, and what is held is kept for the next try.
   */
  private async tokenRequest(organizationId: string, userId: string, form: Record<string, string>): Promise<z.infer<typeof tokenAnswerSchema>> {
    const link = this.deps.link()
    const client = this.deps.client()
    if (!link || !client) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'This machine is not linked to Solus. Link it again to run organization work.')
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(tokenEndpoint(link.directoryUrl), {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form),
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
      if (form.grant_type === 'refresh_token') {
        log.info('delegation_refused', { userId, organizationId, reason: refusal.data.error_description ?? null })
        this.forget(userId, organizationId)
        this.deps.onRevoked(userId, organizationId)
      }
      throw new DelegationError('ORGANIZATION_ACCESS_REFUSED', refusal.data.error_description ?? 'Solus refused to let this machine act for you in this organization.')
    }
    if (response.status === 401) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus did not recognize this machine. Link it again.')
    // A 403 is an answer, not an outage: trying again changes nothing until the person connects again.
    if (response.status === 403) throw new DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Solus did not let this machine act for you in this organization. Reconnect and send again.')
    throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', `Solus could not authorize this (${response.status}). Try again.`)
  }

  private store(userId: string, organizationId: string, held: Held): void {
    this.load().set(keyOf(userId, organizationId), held)
    this.save()
  }

  private load(): Map<string, Held> {
    if (this.held) return this.held
    const stored = secretStore().loadJson(SECRET_KEY, electronPath(), storedSchema)
    this.held = new Map(Object.entries(stored?.refreshTokens ?? {}).map(([key, refreshToken]) => [key, { refreshToken, accessToken: null, expiresAt: 0, renewing: null }]))
    return this.held
  }

  private save(): void {
    const refreshTokens = Object.fromEntries([...this.load()].map(([key, held]) => [key, held.refreshToken]))
    secretStore().saveJson(SECRET_KEY, electronPath(), { version: 1, refreshTokens })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function electronPath(): string {
  return join(dataDir(), 'delegations.bin')
}
