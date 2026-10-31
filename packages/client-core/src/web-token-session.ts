import type { AccountState } from '@solus/contracts/account-types'
import type { AccountIdentity, TokenResource } from '@solus/contracts/auth/clients'
import { WEB_TOKENS_PATH, webTokensResponseSchema, type WebTokensRequest, type WebTokensResponse } from '@solus/contracts/uplink'
import type { ResourceRefusal } from './oauth-session'

/**
 * The web client's sign-in on the account origin (docs/plans/web-session-tokens.md;
 * docs/adr/0001-standard-authentication.md §2.2). The page runs no OAuth flow and holds
 * no refresh token: `POST /api/web/tokens` signs access tokens from the website session,
 * authenticated by the session cookie alone. The shell says who is signed in, so the
 * page is signed in from its first line and never waits for a request to know it.
 *
 * One holder per tab: the held tokens and their ends, one request in flight, and a
 * refusal reason per host. A token is renewed only when it is asked for within a minute
 * of its end; the host socket asks before its token ends. A 401 means the website
 * session ended: the tab signs out and goes to the sign-in. A sign-out or a 401 in one
 * tab signs out every tab of the origin (`SignOutChannel`).
 */

/** A token is given out until this long before its end. */
const RENEW_LEAD_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
/** The `BroadcastChannel` every tab of the origin hears a sign-out on. */
export const WEB_SIGN_OUT_CHANNEL = 'solus:web-sign-out'

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** The part of a `BroadcastChannel` the session uses: it tells the other tabs, and hears them. */
export type SignOutChannel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener'>

export interface WebTokenSessionDeps {
  /** The account origin, which serves the page. */
  origin: string
  /** Who the shell says is signed in. */
  identity: AccountIdentity
  signedInAt: number
  fetch: FetchLike
  now: () => number
  /** The website has no session any more: the page leaves for the sign-in. */
  onSignedOut(): void
  /** The other tabs of this origin; null where there is no `BroadcastChannel`. */
  channel: SignOutChannel | null
}

interface HeldToken {
  token: string
  expiresAt: number
}

/** The one request in flight: the hosts it asks for, and its end. */
interface InFlight {
  hostIds: ReadonlySet<string>
  done: Promise<void>
}

export class WebTokenSession {
  private current: AccountState
  private servers: HeldToken | null = null
  private readonly hosts = new Map<string, HeldToken>()
  private readonly refusals = new Map<string, ResourceRefusal>()
  private inFlight: InFlight | null = null
  private readonly listeners = new Set<(state: AccountState) => void>()

  constructor(private readonly deps: WebTokenSessionDeps) {
    this.current = this.signedIn(false)
    // Another tab signed out, or its website session ended: so did this one's.
    deps.channel?.addEventListener('message', () => this.endSession({ kind: 'signed-out' }))
  }

  state(): AccountState {
    return this.current
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The first request, at boot: the servers token and the shell's hosts together, sent now, before the workspace code is asked for. */
  start(hostIds: readonly string[]): void {
    void this.send(hostIds)
  }

  /**
   * A valid access token for one resource. The account plane and the Solus API share the
   * servers token. `refused` names a held token its server refused: it is not given out
   * again. Null when signed out, when the account plane refused this host, or when it
   * did not answer.
   */
  async accessToken(resource: TokenResource, options: { refused?: string } = {}): Promise<string | null> {
    const hostId = resource.kind === 'host' ? resource.hostId : null
    if (options.refused) {
      if (hostId && this.hosts.get(hostId)?.token === options.refused) this.hosts.delete(hostId)
      if (!hostId && this.servers?.token === options.refused) this.servers = null
    }
    for (;;) {
      const held = this.held(hostId)
      if (held) return held
      if (this.current.kind !== 'signed-in') return null
      const running = this.inFlight
      // A request that asks for this token gives the answer, a refusal or no answer included.
      if (!running) return this.send(hostId ? [hostId] : []).then(() => this.held(hostId))
      await running.done
      if (!hostId || running.hostIds.has(hostId)) return this.held(hostId)
    }
  }

  /** Why the last answer gave no token for this host; null when it gave one, or did not answer. */
  refusal(resource: TokenResource): ResourceRefusal | null {
    return resource.kind === 'host' ? this.refusals.get(resource.hostId) ?? null : null
  }

  /** Ends the website session, and signs out every tab of the origin. False when the website did not confirm it. */
  async signOut(): Promise<boolean> {
    let isConfirmed = false
    try {
      const response = await this.deps.fetch(`${this.deps.origin}/api/auth/sign-out`, {
        method: 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      isConfirmed = response.ok
    } catch {}
    this.clear()
    this.setState({ kind: 'signed-out' })
    this.deps.channel?.postMessage('signed-out')
    return isConfirmed
  }

  private held(hostId: string | null): string | null {
    const token = hostId ? this.hosts.get(hostId) : this.servers
    return token && token.expiresAt - RENEW_LEAD_MS > this.deps.now() ? token.token : null
  }

  /** Sends one request; the caller has checked that none is in flight. */
  private send(hostIds: readonly string[]): Promise<void> {
    const done = this.request([...new Set(hostIds)]).finally(() => {
      if (this.inFlight?.done === done) this.inFlight = null
    })
    this.inFlight = { hostIds: new Set(hostIds), done }
    return done
  }

  private async request(hostIds: string[]): Promise<void> {
    if (this.current.kind !== 'signed-in') return
    const body: WebTokensRequest = { hostIds }
    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.origin}${WEB_TOKENS_PATH}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      this.markStale(true)
      return
    }
    if (response.status === 401) {
      this.endSession({ kind: 'invalid', reason: 'revoked' })
      this.deps.channel?.postMessage('signed-out')
      return
    }
    const answer = response.ok ? webTokensResponseSchema.safeParse(await response.json().catch(() => null)) : null
    if (!answer?.success) {
      this.markStale(true)
      return
    }
    this.apply(answer.data)
  }

  private apply(answer: WebTokensResponse): void {
    if (this.current.kind !== 'signed-in') return
    this.servers = answer.serversToken
    for (const host of answer.hosts) {
      if ('refused' in host) {
        this.hosts.delete(host.hostId)
        this.refusals.set(host.hostId, { status: host.refused === 'unavailable' ? 503 : 400, code: host.refused, description: null, rule: host.refused })
      } else {
        this.hosts.set(host.hostId, { token: host.token, expiresAt: host.expiresAt })
        this.refusals.delete(host.hostId)
      }
    }
    this.markStale(false)
  }

  /** The website no longer has the session: signed out here too, and the page goes to the sign-in. */
  private endSession(state: AccountState): void {
    if (this.current.kind !== 'signed-in') return
    this.clear()
    this.setState(state)
    this.deps.onSignedOut()
  }

  private clear(): void {
    this.servers = null
    this.hosts.clear()
    this.refusals.clear()
  }

  private markStale(isStale: boolean): void {
    if (this.current.kind !== 'signed-in' || this.current.isStale === isStale) return
    this.setState(this.signedIn(isStale))
  }

  private signedIn(isStale: boolean): AccountState {
    return { kind: 'signed-in', identity: this.deps.identity, consoleUrl: this.deps.origin, signedInAt: this.deps.signedInAt, isStale }
  }

  private setState(state: AccountState): void {
    this.current = state
    for (const listener of this.listeners) listener(state)
  }
}
