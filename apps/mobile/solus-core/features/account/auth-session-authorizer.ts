import type { BrowserAuthorization, BrowserAuthorizer } from '@solus/client-core/oauth-session'

/**
 * The mobile browser step of the account sign-in (docs/adr/0001-standard-authentication.md
 * §2.2 rule 1, RFC 8252): the system authentication session (ASWebAuthenticationSession,
 * Android Custom Tabs) opens the authorize page and gives back the redirect to the app's
 * claimed scheme. The Expo module is passed in, so this runs under test.
 */

/** Where the account plane sends the browser back. Solus Cloud registers it for `solus-mobile`. */
export const MOBILE_REDIRECT_URI = 'solus://auth/callback'

/** What `expo-web-browser`'s `openAuthSessionAsync` answers, as this file reads it. */
export type AuthSessionResult = { type: 'success'; url: string } | { type: string }

export interface AuthSessionBrowser {
  openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult>
  dismissAuthSession(): void
}

/** The callback address of a finished session; null when the person closed it or it went elsewhere. */
export function callbackOf(result: AuthSessionResult): URL | null {
  if (result.type !== 'success' || !('url' in result)) return null
  if (!result.url.startsWith(`${MOBILE_REDIRECT_URI}?`)) return null
  try {
    return new URL(result.url)
  } catch {
    return null
  }
}

export function authSessionAuthorizer(browser: AuthSessionBrowser): BrowserAuthorizer {
  return {
    async start(): Promise<BrowserAuthorization> {
      let isCancelled = false
      return {
        redirectUri: MOBILE_REDIRECT_URI,
        async complete(authorizeUrl) {
          if (isCancelled) return null
          const result = await browser.openAuthSession(authorizeUrl.toString(), MOBILE_REDIRECT_URI)
          return isCancelled ? null : callbackOf(result)
        },
        cancel() {
          isCancelled = true
          browser.dismissAuthSession()
        },
      }
    },
  }
}
