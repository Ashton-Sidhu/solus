import { BROWSER_BLANK_URL } from '@solus/contracts/browser-types'
import type { BrowserLoadState, BrowserSurfaceReport } from '@solus/contracts/browser-types'

/**
 * The native browser surface's wiring: what an Electron `<webview>` reports and
 * how it is handed to the host that owns the page.
 *
 * The renderer never drives the guest itself. It hands over the guest's
 * `webContents` id once, and the server — which on a desktop-local connection
 * is the same process the guest lives in — does the rest over CDP. That keeps
 * one page under one owner whether the next instruction comes from the toolbar
 * or from an agent.
 */

/** The subset of Electron's `WebviewTag` this surface uses. Declared here so
 *  the renderer bundle never imports Electron types it cannot ship to web. */
export interface BrowserGuestElement extends HTMLElement {
  src: string
  partition: string
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  canGoBack?(): boolean
  canGoForward?(): boolean
}

/** Whether this client can host a native browser surface at all. True only in
 *  the desktop editor window, where `webviewTag` is enabled. */
export function supportsNativeBrowser(): boolean {
  if (!globalThis.document) return false
  // Electron types the tag ambiently, so the compiler believes the accessor is
  // always there. At runtime it exists only where `webviewTag` was granted —
  // which is exactly the question being asked.
  return 'getWebContentsId' in document.createElement('webview')
}

/** A native guest can only be adopted by the server in this Electron process.
 * Remote hosts always send frames, even when the client is a desktop app. */
export function shouldUseNativeBrowser(
  canHostNatively: boolean,
  pageServerId: string,
  localServerId: string | null,
  targetKind: 'url' | 'device',
): boolean {
  return canHostNatively && pageServerId === localServerId && targetKind === 'url'
}

export interface BrowserGuestHandlers {
  attach(webContentsId: number): void
  detach(): void
  report(report: BrowserSurfaceReport): void
  /** The guest's render process is gone. It cannot be reloaded in place, so
   *  the owner has to decide whether to mount a new one. */
  crashed(): void
}

/**
 * Svelte action: subscribe one mounted guest to its page.
 *
 * The handover waits until the guest is attached and its first document is
 * ready. The element must never be reparented or unmounted while its page
 * lives, because either action creates a different guest process.
 */
export function browserGuest(node: BrowserGuestElement, handlers: BrowserGuestHandlers) {
  let current = handlers

  // A dev server's OAuth popup and every `target="_blank"` link call
  // `window.open`. Without this the guest's call returns null and the flow dies
  // silently; with it, the host decides where the new page goes.
  if (!node.hasAttribute('allowpopups')) node.setAttribute('allowpopups', 'true')

  const report = (loadState: BrowserLoadState, failure?: string): void => {
    const url = safe(() => node.getURL(), '')
    // The guest is mounted blank so the host can attach and emulate before the
    // real page loads. That blank commit is scaffolding, not a navigation:
    // reporting it would put `about:blank` in the toolbar and, worse, announce
    // `ready` for a page that has not started loading — which is exactly when
    // the pane would drop its loading state.
    if (url === BROWSER_BLANK_URL) return
    const payload: BrowserSurfaceReport = {
      url,
      title: safe(() => node.getTitle(), ''),
      loadState,
      canGoBack: safe(() => node.canGoBack?.() ?? false, false),
      canGoForward: safe(() => node.canGoForward?.() ?? false, false),
    }
    if (failure) payload.failure = failure
    current.report(payload)
  }

  // `did-attach` says the guest is bound to the embedder, but `getWebContentsId`
  // additionally needs `dom-ready` — and on a freshly mounted guest `did-attach`
  // fires first, so reading the id there throws ("must be attached to the DOM
  // and the dom-ready event emitted"). The throw is uncaught, the id never
  // reaches the host, and the surface silently never attaches — so the page
  // renders but cannot be emulated, driven, or annotated. Try on both events and
  // take whichever first yields the id; guard so the real page's later
  // `dom-ready` navigations do not re-attach.
  let attached = false
  const onAttach = (): void => {
    if (attached) return
    const id = safe(() => node.getWebContentsId(), null)
    if (id === null) return
    attached = true
    current.attach(id)
  }
  const onStartLoading = (): void => report('loading')
  const onStopLoading = (): void => report('ready')
  const onNavigate = (): void => report('ready')
  const onTitle = (): void => report('ready')
  const onFail = (event: Event): void => {
    // SAFETY: `did-fail-load` is Electron's own event on this element, and it
    // carries these two fields on every emission.
    const detail = event as Event & { errorDescription?: string; isMainFrame?: boolean }
    // Sub-resource failures are the page's business, not the pane's: only a
    // main-frame failure means the user is looking at nothing.
    if (detail.isMainFrame === false) return
    report('failed', detail.errorDescription || 'The dev server did not answer.')
  }

  // `crashed` is the older spelling and `render-process-gone` the current one;
  // which of them a given Electron build emits is not fixed, so both are bound
  // and the owner's handler tolerates being called twice.
  const onCrash = (): void => current.crashed()

  node.addEventListener('did-attach', onAttach)
  node.addEventListener('dom-ready', onAttach)
  node.addEventListener('crashed', onCrash)
  node.addEventListener('render-process-gone', onCrash)
  node.addEventListener('did-start-loading', onStartLoading)
  node.addEventListener('did-stop-loading', onStopLoading)
  node.addEventListener('did-navigate', onNavigate)
  node.addEventListener('did-navigate-in-page', onNavigate)
  node.addEventListener('page-title-updated', onTitle)
  node.addEventListener('did-fail-load', onFail)

  return {
    /** The pane re-creates these closures on every render; the element must
     *  not be re-created with them, so the action re-points instead. */
    update(next: BrowserGuestHandlers) {
      current = next
    },
    destroy() {
      node.removeEventListener('did-attach', onAttach)
      node.removeEventListener('dom-ready', onAttach)
      node.removeEventListener('crashed', onCrash)
      node.removeEventListener('render-process-gone', onCrash)
      node.removeEventListener('did-start-loading', onStartLoading)
      node.removeEventListener('did-stop-loading', onStopLoading)
      node.removeEventListener('did-navigate', onNavigate)
      node.removeEventListener('did-navigate-in-page', onNavigate)
      node.removeEventListener('page-title-updated', onTitle)
      node.removeEventListener('did-fail-load', onFail)
      current.detach()
    },
  }
}

/** A destroyed or not-yet-attached guest throws on every accessor; a report is
 *  best-effort by nature, so it degrades to the empty answer. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}
