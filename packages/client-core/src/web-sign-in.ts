import { z } from 'zod'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import { OAuthSession, type PendingSignIn, type StoredGrant, type TokenStore } from './oauth-session'

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
 * Token storage: the refresh token is kept in page memory. When the page goes away it
 * is written to `sessionStorage`, and the next page of the same tab takes it from
 * there and deletes it. So a reload keeps the sign-in, a closed tab ends it, and a
 * duplicated tab (which copies `sessionStorage` while the page lives) finds nothing
 * and signs in on its own, instead of sharing one refresh token, which the account
 * plane would read as a replay and end the grant (§5). A new tab signs in again
 * silently while the website's cookie session lives.
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

/** The part of `window` this module uses; tests give their own. */
export interface PageLifecycle {
  addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void
}

const storedGrantSchema = z.object({
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  identity: z.object({ sub: z.string(), email: z.string(), emailVerified: z.boolean(), name: z.string().nullable(), picture: z.string().nullable() }),
  signedInAt: z.number(),
})

/** The tab's token store: memory while the page lives, `sessionStorage` only between two pages. */
export function webTokenStore(storage: KeyValueStorage, page: PageLifecycle): TokenStore {
  let grant: StoredGrant | null = null
  let hasLoaded = false
  page.addEventListener('pagehide', () => {
    if (grant) storage.setItem(GRANT_KEY, JSON.stringify(grant))
  })
  // A page restored from the back-forward cache keeps its memory: take the copy back.
  page.addEventListener('pageshow', () => storage.removeItem(GRANT_KEY))
  return {
    load() {
      if (hasLoaded) return grant
      hasLoaded = true
      const raw = storage.getItem(GRANT_KEY)
      storage.removeItem(GRANT_KEY)
      try {
        const parsed = storedGrantSchema.safeParse(raw ? JSON.parse(raw) : null)
        grant = parsed.success ? parsed.data : null
      } catch {
        grant = null
      }
      return grant
    },
    save(next) {
      hasLoaded = true
      grant = next
    },
    clear() {
      hasLoaded = true
      grant = null
      storage.removeItem(GRANT_KEY)
    },
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

/** The page's one sign-in to the account origin it is served from. */
export function webAccountSession(origin: string): OAuthSession {
  if (!pageSession) {
    pageSession = new OAuthSession({
      cloudOrigin: origin,
      clientId: SOLUS_CLIENT_IDS.web,
      store: webTokenStore(sessionStorage, window),
      fetch: (input, init) => fetch(input, { ...init, credentials: 'omit' }),
      now: () => Date.now(),
      log: { info: () => {}, warn: (event, data) => console.warn(`[solus:account] ${event}`, data ?? {}) },
    })
  }
  return pageSession
}

/** The page's sign-in when one was made; null on any other origin. */
export function existingWebAccountSession(): OAuthSession | null {
  return pageSession
}

