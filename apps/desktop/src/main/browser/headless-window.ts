import { BrowserWindow } from 'electron'
import { createLogger } from '@solus/server/logger'
import type { BrowserLoadState, BrowserSurfaceReport } from '@solus/contracts/browser-types'
import {
  setBrowserHeadlessHost,
  type BrowserHeadlessOpenRequest,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import { ChromiumBrowserDriver } from './chromium-driver'

const log = createLogger('browser', 'headless-window.ts')

/** The guest's own size before emulation replaces it. Any value would do; this
 *  one keeps a page that is somehow read before its first emulation sane. */
const INITIAL_WIDTH = 1280
const INITIAL_HEIGHT = 800

/**
 * The desktop headless host: a window that is never shown.
 *
 * The server runs inside Electron main on desktop, and Electron is a Chromium —
 * so a page with no pane is hosted by a `BrowserWindow` that is simply never
 * shown, driven through the same CDP driver as the `<webview>` a user watches.
 * It costs no second browser, no second process tree, and no bundled runtime,
 * and it removes the possibility of a headless page and a watched page rendering
 * differently, because they are the same Chromium build.
 *
 * A window that is never shown is a background window, so Chromium would
 * ordinarily throttle its timers: `backgroundThrottling: false` is what keeps an
 * agent's waits behaving the same as the pane's. Measured at 59fps of
 * `requestAnimationFrame` and full-rate `setInterval` in a window that was never
 * shown.
 */
export function registerBrowserHeadlessHost(): void {
  setBrowserHeadlessHost({ open: openHeadlessGuest })
}

async function openHeadlessGuest(request: BrowserHeadlessOpenRequest): Promise<BrowserSurfaceDriver> {
  const window = new BrowserWindow({
    show: false,
    width: INITIAL_WIDTH,
    height: INITIAL_HEIGHT,
    webPreferences: {
      partition: request.partition,
      // Without this Chromium throttles a window nobody is looking at, and an
      // agent's `waitFor` would resolve on a different clock from the user's.
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const contents = window.webContents
  let loadState: BrowserLoadState = 'loading'
  let failure: string | undefined
  const report = (): void => {
    if (contents.isDestroyed()) return
    request.report(reportOf(contents, loadState, failure))
  }

  // `about:blank` first, then CDP, then the page the caller actually wants.
  //
  // Enabling a CDP domain on a guest whose renderer has not committed any
  // document never resolves — the command hangs rather than failing — so
  // something has to be loaded before attaching. Loading the real page first
  // would satisfy that, but it costs the two things the rings exist for: every
  // console line and request the page emits while loading happens before `Log`
  // and `Network` are enabled, and the page lays out at the window's own size
  // before emulation reaches it. A blank document commits instantly, carries no
  // console or network traffic of its own, and leaves the guest attached and
  // emulated before the real navigation starts.
  await contents.loadURL('about:blank')
  const driver = await ChromiumBrowserDriver.attach(contents, {
    kind: 'headless',
    // Nothing else owns this guest: it exists for the page and goes with it.
    releaseGuest: async () => {
      log.info('browser_headless_closed', { url: contents.getURL() })
      window.destroy()
    },
  })

  try {
    await driver.applyEmulation(request.emulation)
  } catch (error) {
    // A guest at the wrong metrics would make every screenshot a quiet lie, so
    // it is destroyed rather than handed back half-configured.
    await driver.dispose().catch(() => {})
    throw error
  }

  // Only now are the page's own navigations worth reporting: the blank commit
  // above is scaffolding, and publishing it would put `about:blank` in the
  // toolbar of a page that is about to be somewhere else.
  contents.on('did-finish-load', () => {
    loadState = 'ready'
    failure = undefined
    report()
  })
  contents.on('did-fail-load', (_event, _code, description, _url, isMainFrame) => {
    // A sub-frame that failed is noise; only the page itself is the page state.
    if (!isMainFrame) return
    loadState = 'failed'
    failure = description
    report()
  })
  contents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    loadState = 'loading'
    report()
  })
  contents.on('did-navigate-in-page', () => { report() })
  contents.on('page-title-updated', () => { report() })

  try {
    await contents.loadURL(request.url)
  } catch (error) {
    // A load that fails still commits an error page, and that failure is the
    // state the page should report — not a reason to refuse the guest.
    loadState = 'failed'
    failure = error instanceof Error ? error.message : 'The page did not load.'
  }
  report()

  log.info('browser_headless_opened', { url: request.url, partition: request.partition })
  return driver
}

function reportOf(
  contents: Electron.WebContents,
  loadState: BrowserLoadState,
  failure: string | undefined,
): BrowserSurfaceReport {
  const report: BrowserSurfaceReport = {
    url: contents.getURL(),
    title: contents.getTitle(),
    loadState,
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
  if (failure) report.failure = failure
  return report
}
