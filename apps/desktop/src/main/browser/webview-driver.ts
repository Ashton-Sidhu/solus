import { session as electronSession, webContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import { BROWSER_PARTITION_PREFIX } from '@solus/contracts/browser-types'
import { setBrowserWebviewHost } from '@solus/server/browser/surface-driver'
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
 * host is what teaches it how to reach a `<webview>` and how to forget a profile.
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
    clearProfile: async (partition) => {
      // Guarded because the partition name arrives from a client: clearing an
      // arbitrary Electron session would take the app's own storage with it.
      if (!partition.startsWith(BROWSER_PARTITION_PREFIX)) {
        throw new Error(`Refusing to clear a session outside the browser profiles: ${partition}`)
      }
      log.info('browser_profile_cleared', { partition })
      await electronSession.fromPartition(partition).clearStorageData()
    },
  })
}
