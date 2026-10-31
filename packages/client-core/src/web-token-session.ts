import type { AccountState } from '@solus/contracts/account-types'
import type { AccountIdentity, TokenResource } from '@solus/contracts/auth/clients'
import type { AccountSettingsResponse } from '@solus/contracts/settings'
import { WEB_TOKENS_PATH, webTokensResponseSchema, type AccountResponse, type DirectoryResponse, type WebTokensRequest, type WebTokensResponse } from '@solus/contracts/uplink'
import type { ResourceRefusal } from './oauth-session'

/**
 * The web client's sign-in on the account origin (docs/plans/fast-secure-startup.md,
 * decision 1; docs/adr/0001-standard-authentication.md §2.2). The page runs no OAuth flow
 * and holds no refresh token: the account origin holds the grant for the website
 * session, and `POST /api/web/tokens` gives the page access tokens, authenticated by the
 * session cookie alone. The shell says who is signed in, so the page is signed in from
 * its first line and never waits for a request to know it.
 *
 * One request carries every host the page asks for at once, beside the token for our
 * servers. Tokens are renewed shortly before they end. Each tab asks for its own: one
 * request is cheap, and the account origin keeps the servers token for the session, so
 * a tab costs no refresh.
 */

/** A token is given out until this long before its end. */
const RENEW_LEAD_MS = 60_000
/** A late first reader reads current data instead of the sign-in's. */
const STARTUP_MAX_AGE_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

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
  /** Runs `renew` after `delayMs` and gives its cancel. Defaults to `setTimeout`. */
  schedule?: (renew: () => void, delayMs: number) => () => void
}

interface HeldToken {
  token: string
  expiresAt: number
}

/** One request: the hosts it carries, and its end. */
interface Batch {
  hostIds: Set<string>
  done: Promise<void>
  end: () => void
}

type Startup = NonNullable<WebTokensResponse['startup']>

export class WebTokenSession {
  private current: AccountState
  private servers: HeldToken | null = null
  private readonly hosts = new Map<string, HeldToken>()
  private readonly refusals = new Map<string, ResourceRefusal>()
  private running: Batch | null = null
  private next: Batch | null = null
  private startupAccount: AccountResponse | null = null
  private startupSettings: Startup['settings'] | undefined
  private startupDirectory: DirectoryResponse | null = null
  private startupExpiresAt = 0
  private cancelRenewal: (() => void) | null = null
  private readonly listeners = new Set<(state: AccountState) => void>()

  constructor(private readonly deps: WebTokenSessionDeps) {
    this.current = this.signedIn(false)
  }

  state(): AccountState {
    return this.current
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The first request, at boot: the servers token and the shell's hosts together. */
  start(hostIds: readonly string[]): void {
    void this.join(hostIds)
    // Now, not in a later turn: it goes before the workspace code is asked for.
    this.launch()
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
    const held = this.held(hostId)
    if (held) return held
    if (this.current.kind !== 'signed-in') return null
    await this.join(hostId ? [hostId] : [])
    return this.held(hostId)
  }

  /** Why the last answer gave no token for this host; null when it gave one, or did not answer. */
  refusal(resource: TokenResource): ResourceRefusal | null {
    return resource.kind === 'host' ? this.refusals.get(resource.hostId) ?? null : null
  }

  /** Ends the website session; the account origin then revokes the grant. False when the website did not confirm it. */
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
    return isConfirmed
  }

  /** One reader takes each part of the sign-in's data; it is there only in the first answer of a website session. */
  takeStartupAccount(): AccountResponse | null {
    const account = this.isStartupFresh() ? this.startupAccount : null
    this.startupAccount = null
    return account
  }

  takeStartupDirectory(): DirectoryResponse | null {
    const directory = this.isStartupFresh() ? this.startupDirectory : null
    this.startupDirectory = null
    return directory
  }

  async takeStartupSettings(): Promise<AccountSettingsResponse | null> {
    // A settings read at boot may come before the first answer, which carries them.
    await (this.running ?? this.next)?.done
    const raw = this.startupSettings
    this.startupSettings = undefined
    if (raw === undefined || !this.isStartupFresh()) return null
    const { accountSettingsResponseSchema } = await import('@solus/contracts/settings')
    return accountSettingsResponseSchema.parse(raw)
  }

  private isStartupFresh(): boolean {
    return this.current.kind === 'signed-in' && this.deps.now() < this.startupExpiresAt
  }

  private held(hostId: string | null): string | null {
    const token = hostId ? this.hosts.get(hostId) : this.servers
    return token && token.expiresAt - RENEW_LEAD_MS > this.deps.now() ? token.token : null
  }

  /** Waits for a request that carries these hosts: the running one when it does, else the next, which starts as soon as it may. */
  private join(hostIds: readonly string[]): Promise<void> {
    const running = this.running
    if (running && hostIds.every((hostId) => running.hostIds.has(hostId))) return running.done
    let next = this.next
    if (!next) {
      let end = () => {}
      const done = new Promise<void>((resolve) => { end = resolve })
      next = { hostIds: new Set(), done, end }
      this.next = next
      // Asks in the same turn are sent together.
      if (!running) queueMicrotask(() => this.launch())
    }
    for (const hostId of hostIds) next.hostIds.add(hostId)
    return next.done
  }

  private launch(): void {
    const batch = this.next
    if (!batch || this.running) return
    this.next = null
    this.running = batch
    void this.request([...batch.hostIds]).finally(() => {
      this.running = null
      batch.end()
      this.launch()
    })
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
      this.endSession()
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
    const now = this.deps.now()
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
    // Data for another person than the shell names is never applied.
    if (answer.startup && answer.startup.account.userId === this.deps.identity.sub) {
      this.startupAccount = answer.startup.account
      this.startupSettings = answer.startup.settings
      this.startupDirectory = answer.startup.directory ?? null
      this.startupExpiresAt = now + STARTUP_MAX_AGE_MS
    }
    this.markStale(false)
    this.scheduleRenewal(now)
  }

  /** Renews every held token shortly before the first of them ends, so no dial waits for one. */
  private scheduleRenewal(now: number): void {
    this.cancelRenewal?.()
    const ends = [this.servers, ...this.hosts.values()].flatMap((token) => (token ? [token.expiresAt] : []))
    if (ends.length === 0) return
    const delay = Math.max(0, Math.min(...ends) - RENEW_LEAD_MS - now)
    const schedule = this.deps.schedule ?? ((renew, delayMs) => {
      const timer = setTimeout(renew, delayMs)
      return () => clearTimeout(timer)
    })
    this.cancelRenewal = schedule(() => {
      this.cancelRenewal = null
      void this.join([...this.hosts.keys()])
    }, delay)
  }

  /** The website no longer has the session: signed out here too, and the page goes to the sign-in. */
  private endSession(): void {
    this.clear()
    this.setState({ kind: 'invalid', reason: 'revoked' })
    this.deps.onSignedOut()
  }

  private clear(): void {
    this.cancelRenewal?.()
    this.cancelRenewal = null
    this.servers = null
    this.hosts.clear()
    this.refusals.clear()
    this.startupAccount = null
    this.startupSettings = undefined
    this.startupDirectory = null
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
