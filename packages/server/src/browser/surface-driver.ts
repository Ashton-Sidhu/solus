import type {
  BrowserAppearance,
  BrowserConsoleEntry,
  BrowserHostKind,
  BrowserNavigateOp,
  BrowserNetworkEntry,
  BrowserSurfaceReport,
  BrowserViewport,
} from '@solus/contracts/browser-types'

/**
 * The one thing a browser host must be able to do.
 *
 * The registry speaks only these primitives; every product-level verb (click a
 * ref, type into a field, snapshot the page) is composed from them here rather
 * than reimplemented per host. That is what keeps a webview-hosted page and a
 * headless-hosted page from being two different products, and it is why raw CDP
 * never appears above this interface.
 */
export interface BrowserSurfaceDriver {
  readonly kind: Exclude<BrowserHostKind, 'none'>
  /** Real device emulation — metrics, touch, user agent, colour scheme. */
  applyEmulation(emulation: BrowserEmulation): Promise<void>
  navigate(op: BrowserNavigateOp): Promise<void>
  /** PNG data URL of the emulated viewport. */
  captureScreenshot(): Promise<string>
  /**
   * Begin streaming JPEG frames of the emulated viewport.
   *
   * This is what a client with no native surface — a phone, a browser — sees.
   * The driver streams the same guest an agent drives and a desktop user
   * watches, so the picture on the phone is the state everything else is acting
   * on. Calling it again replaces the caps and the listener rather than opening
   * a second stream, so a viewport change is a restart, not a leak.
   */
  startScreencast(options: BrowserScreencastOptions, onFrame: BrowserFrameListener): Promise<void>
  /** Stop streaming. Idempotent — a page nobody is watching should cost nothing,
   *  and the last unsubscribe is the only thing that knows that. */
  stopScreencast(): Promise<void>
  /** Evaluates in the guest and returns the JSON string it produced. */
  evaluate(expression: string): Promise<string>
  clickAt(x: number, y: number): Promise<void>
  insertText(text: string): Promise<void>
  pressKey(key: string): Promise<void>
  scrollAt(x: number, y: number, deltaY: number): Promise<void>
  /**
   * Open the browser's own DevTools on this guest, detached.
   *
   * DevTools and Solus's CDP session are exclusive — Chromium allows one
   * debugger per target — so the driver gives its session up for the duration
   * and takes it back afterwards, re-applying the emulation the guest lost with
   * it. `onClosed` is how the caller learns that happened: the user closes the
   * DevTools window, not Solus, so there is nothing to await.
   *
   * Throws on a host that has no window system to put DevTools in.
   */
  openDevTools(onClosed: () => void): Promise<void>
  /** The retroactive rings: what the page said before anyone thought to look. */
  consoleEntries(): BrowserConsoleEntry[]
  networkEntries(): BrowserNetworkEntry[]
  dispose(): Promise<void>
}

export interface BrowserEmulation {
  viewport: BrowserViewport
  appearance: BrowserAppearance
  /** Absent keeps the host browser's own agent — correct for desktop presets. */
  userAgent?: string
}

/** The caps a stream is started with. Device-pixel bounds and a JPEG quality:
 *  a browser is a moving picture on someone else's screen, not an asset. */
export interface BrowserScreencastOptions {
  maxWidth: number
  maxHeight: number
  quality: number
}

/** One JPEG frame's bytes. Raw, not a data URL: the point of the side-channel is
 *  that the bytes cross as bytes rather than base64 in a JSON envelope. */
export type BrowserFrameListener = (frame: Uint8Array) => void

/**
 * What a guest is already emulating.
 *
 * Emulation overrides persist for the life of a browser session, so the last
 * values applied *are* the guest's current state. Recording them is what lets a
 * host send only the difference — which matters because a dragged stage edge
 * asks for a new size on every pointer frame, and each command makes the guest
 * relayout. Shared rather than per-host: the headless host has the same rule.
 */
export interface AppliedEmulation {
  /** The metrics as one comparable value: nothing reads the parts back. */
  metrics: string
  hasTouch: boolean
  /** Resolved, never optional — the host's own agent is a value, not an absence. */
  userAgent: string
  appearance: BrowserAppearance
}

export function emulationRecord(emulation: BrowserEmulation, hostUserAgent: string): AppliedEmulation {
  const { viewport } = emulation
  return {
    metrics: `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}${viewport.hasTouch ? 'm' : ''}`,
    hasTouch: viewport.hasTouch,
    userAgent: emulation.userAgent ?? hostUserAgent,
    appearance: emulation.appearance,
  }
}

/** Which emulation commands a host still has to send. Nothing applied yet means
 *  all of them; a pure resize means one. */
export interface EmulationChanges {
  metrics: boolean
  touch: boolean
  userAgent: boolean
  appearance: boolean
}

export function emulationChanges(applied: AppliedEmulation | null, next: AppliedEmulation): EmulationChanges {
  return {
    metrics: applied?.metrics !== next.metrics,
    touch: applied?.hasTouch !== next.hasTouch,
    userAgent: applied?.userAgent !== next.userAgent,
    appearance: applied?.appearance !== next.appearance,
  }
}

/**
 * Desktop main registers this once it can turn a renderer's `<webview>` id into
 * a driver. The server package never imports Electron: on a headless host the
 * factory is simply absent, and pages there report `no-surface` instead of
 * pretending to drive something.
 */
export interface BrowserWebviewHost {
  attach(webContentsId: number): Promise<BrowserSurfaceDriver>
}

/**
 * Whoever owns the cookie jars on this host: Electron sessions on the desktop,
 * Playwright user-data directories on a standalone server. Separate from the
 * surface hosts because a profile is storage that outlives every page. Absent on
 * a host that holds no profiles, where both operations say so.
 */
export interface BrowserProfileHost {
  /** Forget one browser profile. Pages open on it stay open; the registry
   *  reloads them afterwards so they show the signed-out state. */
  clearProfile(partition: string): Promise<void>
  /** Put cookies into one profile's jar. Rows the browser refuses are counted
   *  rather than thrown: one malformed cookie is not a failed import. */
  importCookies(partition: string, cookies: BrowserProfileCookie[]): Promise<{ imported: number; failed: number }>
}

/**
 * One cookie on its way into a profile. Deliberately absent from
 * `@solus/contracts`, so no RPC can be declared that carries a value to a
 * renderer even by accident.
 */
export interface BrowserProfileCookie {
  name: string
  value: string
  /** As the source stored it, leading dot included when it was host-only=false. */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'no_restriction' | 'lax' | 'strict'
  /** Unix seconds. Absent is a session cookie, which is kept as one. */
  expiresAt?: number
}

/**
 * The host that renders a page nobody is looking at.
 *
 * This is what makes a browser page addressable without a client: an agent in a
 * worktree, an automation, or a phone can drive a page while no pane on any
 * machine is showing it. Registered by whichever process can supply a browser —
 * absent on a host that cannot, where drive verbs keep failing loudly rather
 * than pretending.
 */
export interface BrowserHeadlessHost {
  open(request: BrowserHeadlessOpenRequest): Promise<BrowserSurfaceDriver>
}

export interface BrowserHeadlessOpenRequest {
  url: string
  /** The project's persistent profile, so a headless page shares the login the
   *  user obtained in a pane. */
  partition: string
  /**
   * Applied before the guest navigates, not after.
   *
   * The host has to commit some document before CDP can attach at all, so it is
   * the only side that can put emulation ahead of the real navigation — which is
   * what keeps the page from laying out at the wrong size and relaying out, and
   * what lets the console and network rings cover the page's own load.
   */
  emulation: BrowserEmulation
  /** No client is watching a headless guest, so it reports its own navigation
   *  the way a pane does — same shape, same publishing path. */
  report(report: BrowserSurfaceReport): void
}

let webviewHost: BrowserWebviewHost | null = null
let headlessHost: BrowserHeadlessHost | null = null
let profileHost: BrowserProfileHost | null = null

/** Null is the way back out: a host that cannot render is a real state, and the
 *  registry answers differently for it rather than pretending. */
export function setBrowserWebviewHost(host: BrowserWebviewHost | null): void {
  webviewHost = host
}

export function browserWebviewHost(): BrowserWebviewHost | null {
  return webviewHost
}

export function setBrowserHeadlessHost(host: BrowserHeadlessHost | null): void {
  headlessHost = host
}

export function browserHeadlessHost(): BrowserHeadlessHost | null {
  return headlessHost
}

/** Registered by whichever process owns this host's cookie jars — Electron
 *  sessions on the desktop, Playwright user-data directories on a server. */
export function setBrowserProfileHost(host: BrowserProfileHost | null): void {
  profileHost = host
}

export function browserProfileHost(): BrowserProfileHost | null {
  return profileHost
}
