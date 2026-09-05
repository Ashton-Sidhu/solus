import { session as electronSession, webContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import { BROWSER_PARTITION_PREFIX } from '@solus/contracts/browser-types'
import {
  setBrowserProfileHost,
  setBrowserWebviewHost,
  type BrowserProfileCookie,
} from '@solus/server/browser/surface-driver'
import { ChromiumBrowserDriver, withTimeout } from './chromium-driver'

const log = createLogger('browser', 'webview-driver.ts')

/** Handing a guest back is cleanup, so it waits briefly and moves on. */
const RELEASE_TIMEOUT_MS = 2_000

/**
 * The desktop webview host.
 *
 * The renderer mounts an Electron `<webview>` and hands its `webContents` id to
 * the server. Because the server runs inside Electron main on a desktop-local
 * connection, that id is all the "bridge" needs to be: main reaches the guest
 * directly. No broker.
 *
 * Called once at boot: the server package never imports Electron, so the desktop
 * host is what teaches it how to reach a `<webview>` and how to hold a profile.
 */
export function registerBrowserWebviewHost(): void {
  setBrowserWebviewHost({
    attach: async (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      if (!contents || contents.isDestroyed()) {
        throw new Error(`No live browser surface for webContents ${webContentsId}`)
      }
      log.info('browser_surface_attached', { webContentsId })
      return ChromiumBrowserDriver.attach(contents, {
        kind: 'webview',
        // The renderer owns this guest and may show another page in it, so it is
        // handed back without the emulation: leaving the overrides would strand
        // the next page at a phone viewport.
        releaseGuest: async () => {
          // Timed like every other command: a guest that has stopped answering
          // must not hold a pane closure open.
          await withTimeout(
            contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'),
            'Emulation.clearDeviceMetricsOverride',
            RELEASE_TIMEOUT_MS,
          )
        },
      })
    },
  })

  setBrowserProfileHost({
    clearProfile: async (partition) => {
      log.info('browser_profile_cleared', { partition })
      await electronSession.fromPartition(requireBrowserPartition(partition)).clearStorageData()
    },
    importCookies: async (partition, cookies) => {
      const jar = electronSession.fromPartition(requireBrowserPartition(partition)).cookies
      let imported = 0
      let failed = 0
      for (const cookie of cookies) {
        try {
          await jar.set(electronCookie(cookie))
          imported += 1
        } catch {
          // Counted, never logged: the reason would carry the cookie's domain.
          failed += 1
        }
      }
      return { imported, failed }
    },
  })
}

/**
 * A partition name arrives from a client, so it is checked before it becomes an
 * Electron session. `fromPartition('')` is the app's own default session, and
 * clearing that would take Solus's storage with it.
 */
function requireBrowserPartition(partition: string): string {
  if (!partition.startsWith(BROWSER_PARTITION_PREFIX)) {
    throw new Error(`Refusing to touch a session outside the browser profiles: ${partition}`)
  }
  return partition
}

/**
 * One cookie in Chromium's terms.
 *
 * `url` is required and is what Chromium checks the rest against: a secure
 * cookie set through an `http://` url is rejected outright, so the scheme is
 * derived from the cookie rather than guessed. `SameSite=None` is likewise only
 * legal on a secure cookie — Firefox stores the pair, Chromium refuses it — so
 * the weaker default is used rather than losing the cookie entirely.
 */
function electronCookie(cookie: BrowserProfileCookie): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, '')
  const details: Electron.CookiesSetDetails = {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === 'no_restriction' && !cookie.secure ? 'lax' : cookie.sameSite,
  }
  // A domain cookie keeps its leading dot; a host-only cookie must not name a
  // domain at all, or Chromium widens it to every subdomain.
  if (cookie.domain.startsWith('.')) details.domain = cookie.domain
  if (cookie.expiresAt !== undefined) details.expirationDate = cookie.expiresAt
  return details
}
