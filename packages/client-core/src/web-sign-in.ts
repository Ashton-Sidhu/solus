import { z } from 'zod'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import { OAuthSession, type PendingSignIn, type StoredGrant, type TokenStore } from './oauth-session'

/**
 * The web client's sign-in on the account origin (docs/adr/0001-standard-authentication.md
 * §2.2 rule 1). The page is a public client (`solus-web`) that signs in with the
 * authorization code and PKCE through a top-level redirect: the website's cookie
 * session approves it with no page (`prompt=none`), and the callback comes back to
 * `/auth/callback` on the same origin. The cookie stays the website's own; the page
 * calls `/v1` with access tokens.
 *
 * Token storage: the refresh token is kept in page memory. When the page goes away it
 * is written to `sessionStorage`, and the next page of the same tab takes it from
 * there and deletes it. So a reload keeps the sign-in, a closed tab ends it, and a
 * duplicated tab (which copies `sessionStorage` while the page lives) finds nothing
 * and signs in on its own, instead of sharing one refresh token, which the account
 * plane would read as a replay and end the grant (§5). A new tab signs in again
 * silently while the website's cookie session lives.
 */

export const WEB_CALLBACK_PATH = '/auth/callback'
const GRANT_KEY = 'solus.account.grant'
const PENDING_KEY = 'solus.account.pending'
const SILENT_ATTEMPT_KEY = 'solus.account.silent-attempt'
/** A silent sign-in is not tried again in the same tab sooner than this, so an answer that does not sign the page in cannot loop. */
export const SILENT_RETRY_AFTER_MS = 60_000

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

const pendingSchema = z.object({
  pending: z.object({ state: z.string(), nonce: z.string(), codeVerifier: z.string(), redirectUri: z.string() }),
  /** Where the page was when the sign-in began: path, query, and fragment. */
  returnTo: z.string().startsWith('/'),
})

export interface WebSignInDeps {
  session: OAuthSession
  storage: KeyValueStorage
  location: { origin: string; pathname: string; search: string; hash: string; href: string }
  /** A top-level navigation away from this page. */
  navigate(url: string): void
  /** Replaces the address without a navigation. */
  replaceAddress(path: string): void
  /**
   * When the website has no session for a silent sign-in begun at `returnTo`:
   * `sign-in` sends the person to the website's sign-in page; `stay` keeps the page
   * signed out (a share link that a guest opens).
   */
  whenSignedOut(returnTo: string): 'sign-in' | 'stay'
  now(): number
}

export type WebSignInOutcome = 'signed-in' | 'signed-out' | 'redirecting'

/**
 * Brings the page to a sign-in, when one can be had: completes a callback, keeps a
 * sign-in the tab already holds, or starts one silent sign-in per tab. The page must
 * stop its boot on `redirecting`: it is leaving.
 */
export async function resumeWebSignIn(deps: WebSignInDeps): Promise<WebSignInOutcome> {
  const { session, storage, location } = deps
  if (location.pathname === WEB_CALLBACK_PATH) {
    const saved = readPending(storage)
    storage.removeItem(PENDING_KEY)
    if (!saved) {
      deps.replaceAddress('/')
      return session.state().kind === 'signed-in' ? 'signed-in' : 'signed-out'
    }
    const callback = new URL(location.href)
    const end = await session.completeSignIn(callback, saved.pending)
    deps.replaceAddress(saved.returnTo)
    if (end === 'approved') {
      storage.removeItem(SILENT_ATTEMPT_KEY)
      return 'signed-in'
    }
    if (callback.searchParams.get('error') === 'login_required' && deps.whenSignedOut(saved.returnTo) === 'sign-in') {
      // After the website's sign-in, the page comes back and tries again at once.
      storage.removeItem(SILENT_ATTEMPT_KEY)
      deps.navigate(`${location.origin}/sign-in?next=${encodeURIComponent(saved.returnTo)}`)
      return 'redirecting'
    }
    return 'signed-out'
  }
  if (session.state().kind === 'signed-in') return 'signed-in'
  const attemptedAt = Number(storage.getItem(SILENT_ATTEMPT_KEY) ?? '0')
  if (deps.now() - attemptedAt < SILENT_RETRY_AFTER_MS) return 'signed-out'
  storage.setItem(SILENT_ATTEMPT_KEY, String(deps.now()))
  let begun: { authorizeUrl: URL; pending: PendingSignIn }
  try {
    begun = await session.beginSignIn(`${location.origin}${WEB_CALLBACK_PATH}`, { prompt: 'none' })
  } catch {
    return 'signed-out'
  }
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  storage.setItem(PENDING_KEY, JSON.stringify({ pending: begun.pending, returnTo }))
  deps.navigate(begun.authorizeUrl.toString())
  return 'redirecting'
}

function readPending(storage: KeyValueStorage): z.infer<typeof pendingSchema> | null {
  try {
    const raw = storage.getItem(PENDING_KEY)
    const parsed = pendingSchema.safeParse(raw ? JSON.parse(raw) : null)
    return parsed.success ? parsed.data : null
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

