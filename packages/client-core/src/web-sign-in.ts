import { z } from 'zod'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import { OAuthSession, storedGrantSchema, type CachedToken, type Discovery, type GrantSharing, type PendingSignIn, type StoredGrant, type TokenCache, type TokenStore } from './oauth-session'

/**
 * The web client's sign-in on the account origin (docs/adr/0001-standard-authentication.md
 * §2.2 rule 1). The page is a public client (`solus-web`) that signs in with the
 * authorization code and PKCE. The website's cookie session approves it with no page
 * (`prompt=none`), and the page asks for that approval with one same-origin fetch that
 * accepts JSON: the provider answers the callback address instead of redirecting to
 * it, so no page loads (docs/plans/instant-share-open.md). Only this origin can read
 * that answer. The cookie stays the website's own; the page calls `/v1` with access
 * tokens.
 *
 * Token storage: every tab of the origin shares one sign-in in `localStorage`: the
 * grant and the access tokens any tab minted (docs/plans/instant-share-open.md). A
 * new tab is signed in at once and dials with a token already minted. The refresh
 * token rotates and the account plane ends the grant when a spent one comes again
 * (§5), so a refresh runs under one Web Lock across the tabs and starts from the
 * grant as stored (`GrantSharing`). A sign-in or sign-out in one tab reaches the
 * others through the `storage` event.
 */

/** The callback the provider names in its answer; the page never loads it. */
export const WEB_CALLBACK_PATH = '/auth/callback'
const GRANT_KEY = 'solus.account.grant'

/** The part of `Storage` this module uses. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The origin's one grant, as every tab reads and writes it. */
export function webTokenStore(storage: KeyValueStorage): TokenStore {
  return {
    load() {
      try {
        const raw = storage.getItem(GRANT_KEY)
        const parsed = storedGrantSchema.safeParse(raw ? JSON.parse(raw) : null)
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
    save(grant: StoredGrant) {
      storage.setItem(GRANT_KEY, JSON.stringify(grant))
    },
    clear() {
      storage.removeItem(GRANT_KEY)
      storage.removeItem(TOKENS_KEY)
    },
  }
}

const TOKENS_KEY = 'solus.account.tokens'
const cachedTokensSchema = z.record(z.string(), z.object({ token: z.string().min(1), expiresAt: z.number() }))

/** The access tokens any tab minted, by resource. */
export function webTokenCache(storage: KeyValueStorage): TokenCache {
  const read = (): Map<string, CachedToken> => {
    try {
      const raw = storage.getItem(TOKENS_KEY)
      const parsed = cachedTokensSchema.safeParse(raw ? JSON.parse(raw) : {})
      return new Map(parsed.success ? Object.entries(parsed.data) : [])
    } catch {
      return new Map()
    }
  }
  const write = (tokens: Map<string, CachedToken>) => {
    if (tokens.size === 0) storage.removeItem(TOKENS_KEY)
    else storage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(tokens)))
  }
  return {
    get: (uri) => read().get(uri),
    set(uri, token) {
      const tokens = read()
      tokens.set(uri, token)
      write(tokens)
    },
    delete(uri) {
      const tokens = read()
      if (tokens.delete(uri)) write(tokens)
    },
    clear: () => storage.removeItem(TOKENS_KEY),
  }
}

/** The part of `navigator.locks` a refresh needs. */
export interface RefreshLocks {
  request<T>(name: string, run: () => Promise<T>): Promise<T>
}

const REFRESH_LOCK = 'solus.account.refresh'

/** One refresher at a time across the origin's tabs. A browser with no Web Locks runs it at once. */
export function webGrantSharing(storage: KeyValueStorage, locks: RefreshLocks | null): GrantSharing {
  return {
    exclusive: (refresh) => (locks ? locks.request(REFRESH_LOCK, refresh) : refresh()),
    tokens: webTokenCache(storage),
  }
}

export interface WebSignInDeps {
  session: OAuthSession
  location: { origin: string; pathname: string; search: string; hash: string }
  /** A top-level navigation away from this page. */
  navigate(url: string): void
  /**
   * When the website has no session for a silent sign-in begun at `returnTo`:
   * `sign-in` sends the person to the website's sign-in page; `stay` keeps the page
   * signed out (a share link that a guest opens).
   */
  whenSignedOut(returnTo: string): 'sign-in' | 'stay'
  /** The callback address the provider answers for this authorize request, or null when it does not answer one. */
  authorize(authorizeUrl: URL): Promise<URL | null>
}

export type WebSignInOutcome = 'signed-in' | 'signed-out' | 'redirecting'

/**
 * Brings the page to a sign-in, when one can be had: keeps a sign-in the tab already
 * holds, or makes one silently. The page must stop its boot on `redirecting`: it is
 * leaving for the website's sign-in, which brings it back to this address.
 */
export async function resumeWebSignIn(deps: WebSignInDeps): Promise<WebSignInOutcome> {
  const { session, location } = deps
  if (session.state().kind === 'signed-in') return 'signed-in'
  let begun: { authorizeUrl: URL; pending: PendingSignIn }
  try {
    begun = await session.beginSignIn(`${location.origin}${WEB_CALLBACK_PATH}`, { prompt: 'none' })
  } catch {
    return 'signed-out'
  }
  const callback = await deps.authorize(begun.authorizeUrl)
  if (!callback) return 'signed-out'
  if (await session.completeSignIn(callback, begun.pending) === 'approved') return 'signed-in'
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  if (callback.searchParams.get('error') === 'login_required' && deps.whenSignedOut(returnTo) === 'sign-in') {
    deps.navigate(`${location.origin}/sign-in?next=${encodeURIComponent(returnTo)}`)
    return 'redirecting'
  }
  return 'signed-out'
}

/**
 * Keeps a long-open page signed in. The grant can end while the page is open (its
 * refresh token expired, or was revoked or replayed), and the page then has no token
 * for any host. The page asks the website again, as at boot: its cookie session
 * approves a new sign-in silently, or, with none, the page leaves for the website's
 * sign-in and comes back to this address. `onSignedInAgain` runs after a silent
 * sign-in, so hosts refused meanwhile dial again at once. A sign-out is not an
 * ended grant: it stays signed out.
 */
export function keepWebSignIn(deps: WebSignInDeps, onSignedInAgain: () => void): () => void {
  let isSignedIn = deps.session.state().kind === 'signed-in'
  let isResuming = false
  return deps.session.onChange((state) => {
    const hasGrantEnded = isSignedIn && state.kind === 'invalid'
    isSignedIn = state.kind === 'signed-in'
    if (!hasGrantEnded || isResuming) return
    isResuming = true
    void resumeWebSignIn(deps)
      .then((outcome) => { if (outcome === 'signed-in') onSignedInAgain() })
      .finally(() => { isResuming = false })
  })
}

const authorizeAnswerSchema = z.object({ redirect: z.literal(true), url: z.string().url() })

/**
 * The provider's answer to an authorize request a page sends with `fetch`: the
 * callback address, with a code or an error, on the page's own origin. Null for any
 * other answer, so a page never follows an address it did not ask for.
 */
export async function fetchAuthorize(authorizeUrl: URL, fetchImpl: typeof fetch = fetch): Promise<URL | null> {
  try {
    const response = await fetchImpl(authorizeUrl, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const answer = authorizeAnswerSchema.safeParse(await response.json().catch(() => null))
    if (!answer.success) return null
    const callback = new URL(answer.data.url)
    return callback.origin === authorizeUrl.origin && callback.pathname === WEB_CALLBACK_PATH ? callback : null
  } catch {
    return null
  }
}

let pageSession: OAuthSession | null = null

/**
 * The page's one sign-in to the account origin it is served from. `knownDiscovery` is
 * the provider's metadata the shell carries; it is read from the issuer without it.
 */
export function webAccountSession(origin: string, knownDiscovery?: Discovery): OAuthSession {
  if (!pageSession) {
    const session = new OAuthSession({
      cloudOrigin: origin,
      clientId: SOLUS_CLIENT_IDS.web,
      knownDiscovery,
      store: webTokenStore(localStorage),
      sharing: webGrantSharing(localStorage, globalThis.navigator?.locks ?? null),
      fetch: (input, init) => fetch(input, { ...init, credentials: 'omit' }),
      now: () => Date.now(),
      log: { info: () => {}, warn: (event, data) => console.warn(`[solus:account] ${event}`, data ?? {}) },
    })
    // Another tab signed in, signed out, or rotated the grant.
    window.addEventListener('storage', (event) => {
      if (event.key === GRANT_KEY || event.key === null) session.syncWithStore()
    })
    pageSession = session
  }
  return pageSession
}

/** The page's sign-in when one was made; null on any other origin. */
export function existingWebAccountSession(): OAuthSession | null {
  return pageSession
}

