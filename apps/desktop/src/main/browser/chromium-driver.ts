import type { Debugger, WebContents } from 'electron'
import { z } from 'zod'
import {
  BROWSER_RING_LIMIT,
  type BrowserConsoleEntry,
  type BrowserHostKind,
  type BrowserNetworkEntry,
  type BrowserNavigateOp,
} from '@solus/contracts/browser-types'
import {
  emulationChanges,
  emulationRecord,
  type AppliedEmulation,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import { browserGuestStyleScript } from '@solus/server/browser/guest-style'

/** Console and log text is rung-buffered and shipped to clients and agents, so
 *  one runaway message cannot become the whole payload. */
const MAX_ENTRY_CHARS = 2000

/**
 * No CDP command may hang its caller.
 *
 * `Debugger.sendCommand` returns a promise that a wedged guest simply never
 * settles, and an agent's tool call has no timeout of its own — so a stalled
 * command leaves the agent waiting forever with no error to react to and no line
 * in the log. That is not a hypothetical: it is what a hung `browser_snapshot`
 * turned out to be.
 */
const CDP_TIMEOUT_MS = 10_000

/** Screenshots have somewhere to fall back to, so they wait a fraction as long
 *  before taking it. */
const SCREENSHOT_TIMEOUT_MS = 3_000

/** The CDP domains this driver needs enabled. Enabled on attach, and again
 *  whenever a session is taken back — DevTools closing drops them all. */
const DOMAINS = ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']

/**
 * Every CDP command payload this driver sends.
 *
 * Narrow by construction: the transport is a pipe for these shapes and nothing
 * else, so a typo in a parameter name is a compile error rather than a command
 * the guest quietly ignores.
 */
type CdpCommandParams =
  | { width: number; height: number; deviceScaleFactor: number; mobile: boolean; screenWidth: number; screenHeight: number }
  | { enabled: boolean; maxTouchPoints?: number }
  | { userAgent: string }
  | { features: { name: string; value: string }[] }
  | { format: 'png'; captureBeyondViewport: boolean; fromSurface?: boolean; optimizeForSpeed?: boolean }
  | { format: 'png'; everyNthFrame: number }
  | { format: 'jpeg'; quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number }
  | { sessionId: number }
  | { expression: string; returnByValue: boolean; awaitPromise: boolean }
  | { type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: string; key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number }
  | { text: string }
  | { source: string }

/**
 * CDP payloads are I/O, not domain values: the protocol version, the guest, and
 * Electron's own bundling all decide their shape. Everything read out of the
 * wire is parsed here, so the driver below deals only in checked values.
 */
const consoleApiSchema = z.object({
  type: z.string().optional(),
  args: z.array(z.object({
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })).default([]),
})

const logEntrySchema = z.object({
  entry: z.object({
    level: z.string().optional(),
    text: z.string().default(''),
    url: z.string().optional(),
  }),
})

const networkResponseSchema = z.object({
  response: z.object({ url: z.string().min(1), status: z.number().default(0) }),
})

const networkFailureSchema = z.object({ errorText: z.string().default('Request failed') })

const screenshotResultSchema = z.object({ data: z.string().min(1) })

const screencastFrameSchema = z.object({
  data: z.string().min(1),
  sessionId: z.number(),
})

const evaluateResultSchema = z.object({
  result: z.object({ value: z.string().optional() }).optional(),
  exceptionDetails: z.object({ text: z.string().optional() }).optional(),
})

/** The union of every CDP event body this driver reads, before validation. */
type CdpEventParams =
  | z.input<typeof consoleApiSchema>
  | z.input<typeof logEntrySchema>
  | z.input<typeof networkResponseSchema>
  | z.input<typeof networkFailureSchema>
  | z.input<typeof screencastFrameSchema>

/**
 * Who owns the Chromium guest a page is being driven through, and therefore what
 * happens to it when the page lets go.
 *
 * The two desktop hosts differ in exactly this and nothing else: a `<webview>`
 * belongs to the renderer and must be handed back clean, while a headless window
 * exists only for the page and dies with it.
 */
export interface GuestOwnership {
  kind: Exclude<BrowserHostKind, 'none'>
  /** Runs while the debugger is still attached, so it can still send commands. */
  releaseGuest(): Promise<void>
}

/**
 * The Chromium browser driver.
 *
 * Both desktop hosts land here: the renderer's `<webview>` and the headless
 * window main opens for a page with no pane. That is deliberate — a page the
 * user is watching and a page an agent is driving unattended must behave
 * identically, and the only way to guarantee that is for them to be the same
 * code. Raw CDP never appears above this file; the registry calls typed methods.
 *
 * This is what buys real device emulation rather than a resized box: metrics,
 * touch, user agent, and colour scheme are all set on the guest, so
 * `pointer: coarse`, touch events, device pixel ratio, and `prefers-color-scheme`
 * genuinely fire.
 */
export class ChromiumBrowserDriver implements BrowserSurfaceDriver {
  readonly kind: Exclude<BrowserHostKind, 'none'>
  private readonly console: BrowserConsoleEntry[] = []
  private readonly network: BrowserNetworkEntry[] = []
  private disposed = false
  /** What this guest is already emulating, so a resize sends one command
   *  instead of four. Null until the first emulation lands. */
  private appliedEmulation: AppliedEmulation | null = null
  /** The live continuous screencast, if one client (or more) is watching. The
   *  handler is bound once here so start and stop add and remove the same
   *  reference; a leaked one would keep decoding frames for a page nobody sees. */
  private screencastFrame: BrowserFrameListener | null = null
  /** True while Chromium's DevTools hold the session this driver needs. Every
   *  command refuses rather than waiting on a debugger that is not ours. */
  private devToolsOpen = false

  /** Say why, rather than letting the raw debugger throw "Debugger is not
   *  attached" at a user who has an inspector open in front of them. */
  private refuseWhileInspected(method: string): void {
    if (!this.devToolsOpen) return
    throw new Error(
      `DevTools are open on this browser page, so Solus cannot ${method.split('.')[0].toLowerCase()} it. `
      + 'Close the DevTools window to drive the page from Solus again.',
    )
  }

  private constructor(
    private readonly contents: WebContents,
    private readonly cdp: Debugger,
    private readonly ownership: GuestOwnership,
  ) {
    this.kind = ownership.kind
  }

  /**
   * Attach to a guest that has already loaded something.
   *
   * The "already loaded" part is load-bearing: enabling a CDP domain on a
   * `WebContents` whose renderer has not yet committed a document never
   * resolves — the command hangs rather than failing — so a caller that creates
   * its own guest must navigate before it attaches.
   */
  static async attach(contents: WebContents, ownership: GuestOwnership): Promise<BrowserSurfaceDriver> {
    if (contents.isDestroyed()) throw new Error('No live browser surface to attach to.')
    const cdp = contents.debugger
    if (!cdp.isAttached()) cdp.attach('1.3')
    contents.setWindowOpenHandler(({ url }) => {
      // A sign-in popup or a `target="_blank"` link would otherwise become a
      // bare Electron window: outside the pane, outside the page's emulation,
      // and outside every agent verb, which address browser pages rather than
      // windows. The same guest follows the link instead, and the toolbar's
      // Back returns — one page, one surface, one owner. A link that turns out
      // to be a download aborts the navigation and keeps the current page,
      // which is why the rejection is ignored rather than reported.
      contents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const driver = new ChromiumBrowserDriver(contents, cdp, ownership)
    cdp.on('message', driver.onProtocolMessage)
    // Log and Network give the retroactive rings a snapshot reads: what the page
    // said before anyone thought to look at it.
    await driver.enableDomains()
    await driver.installGuestStyle()
    return driver
  }

  /**
   * Style the guest's own scrollbar so it matches Solus.
   *
   * A plain stylesheet, installed on every document the guest commits next and
   * run once on the one already loaded — attach happens after the first page has
   * committed, and `addScriptToEvaluateOnNewDocument` only reaches future
   * documents. Best-effort throughout: a page that will not take the style is
   * still a page to look at, never a reason to fail the attach.
   */
  private async installGuestStyle(): Promise<void> {
    const source = browserGuestStyleScript()
    try {
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
      await this.evaluate(source)
    } catch {
      // Styling the guest's scrollbar is a nicety; it does not gate the surface.
    }
  }

  /**
   * Hand the CDP session to Chromium's own DevTools, and take it back after.
   *
   * The exclusivity is Chromium's, not Solus's: one debugger per target, so the
   * session has to be detached *before* DevTools opens or the window comes up
   * with nothing behind it. On the way back the guest has lost every emulation
   * override with the session, so the applied record is cleared — the caller
   * re-applies from the page's own state, which is the only copy that survived.
   */
  async openDevTools(onClosed: () => void): Promise<void> {
    if (this.contents.isDestroyed()) throw new Error('This browser page has no live guest.')
    if (this.contents.isDevToolsOpened()) {
      this.contents.devToolsWebContents?.focus()
      return
    }
    // Streaming and DevTools want the same session; the stream is the one that
    // can be resumed silently afterwards.
    await this.stopScreencast().catch(() => {})
    this.devToolsOpen = true
    if (this.cdp.isAttached()) this.cdp.detach()
    this.contents.once('devtools-closed', () => {
      this.devToolsOpen = false
      this.appliedEmulation = null
      if (this.disposed || this.contents.isDestroyed()) return
      try {
        if (!this.cdp.isAttached()) this.cdp.attach('1.3')
      } catch {
        // A guest that went away while DevTools was up needs no session back.
        return
      }
      // The domains went away with the session, and the rings they feed are the
      // point of holding one. Re-enable before the caller re-applies emulation,
      // so nothing is sent through a session that is attached but deaf.
      void this.enableDomains()
        .then(onClosed)
        .catch(() => {
          // A guest that cannot take the session back is one the user will
          // reload; the page keeps saying DevTools are closed either way.
          onClosed()
        })
    })
    this.contents.openDevTools({ mode: 'detach' })
  }

  private async enableDomains(): Promise<void> {
    await Promise.all(
      DOMAINS.map((method) => withTimeout(this.cdp.sendCommand(method), method, CDP_TIMEOUT_MS)),
    )
  }

  /** A command whose reply nobody reads, with the one guarantee the raw debugger
   *  does not give: it settles. */
  private async send(method: string, params?: CdpCommandParams, timeoutMs = CDP_TIMEOUT_MS): Promise<void> {
    this.refuseWhileInspected(method)
    await withTimeout(this.cdp.sendCommand(method, params), method, timeoutMs)
  }

  /** A command whose reply is read, parsed at the wire rather than above it —
   *  the protocol version, the guest, and Electron all get a say in its shape.
   *  Null means the guest answered with something this driver cannot use. */
  private async ask<Schema extends z.ZodType>(
    method: string,
    params: CdpCommandParams,
    schema: Schema,
    timeoutMs = CDP_TIMEOUT_MS,
  ): Promise<z.output<Schema> | null> {
    this.refuseWhileInspected(method)
    const reply = await withTimeout(this.cdp.sendCommand(method, params), method, timeoutMs)
    const parsed = schema.safeParse(reply)
    return parsed.success ? parsed.data : null
  }

  /**
   * Emulate the page, sending only what actually changed.
   *
   * A dragged stage edge asks for a new size on every pointer frame, and each of
   * these commands makes the guest relayout. Re-asserting an unchanged user
   * agent, touch mode, and colour scheme sixty times a second is three quarters
   * of the work of a resize spent confirming things nobody moved — which is what
   * the drag felt like. CDP overrides persist for the life of the session, so
   * the last applied values are the guest's current state; a fresh driver starts
   * with an empty record and therefore sends everything.
   */
  async applyEmulation(emulation: BrowserEmulation): Promise<void> {
    const { viewport, appearance } = emulation
    // The host's own agent is what "no user agent" means, so it is resolved
    // before the comparison rather than after it.
    const next = emulationRecord(emulation, this.contents.getUserAgent())
    const changed = emulationChanges(this.appliedEmulation, next)

    if (changed.metrics) {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.hasTouch,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      })
    }

    if (changed.touch) {
      // `maxTouchPoints` is validated against 1..16 before `enabled` is read, so
      // sending 0 to turn touch off is rejected outright ("Touch points must be
      // between 1 and 16") and the whole emulation call fails. Turning it off is
      // the `enabled: false` alone; the count only means something when it is on.
      await this.send('Emulation.setTouchEmulationEnabled', viewport.hasTouch
        ? { enabled: true, maxTouchPoints: 5 }
        : { enabled: false })
    }

    if (changed.userAgent) {
      await this.send('Emulation.setUserAgentOverride', { userAgent: next.userAgent })
    }

    if (changed.appearance) {
      await this.send('Emulation.setEmulatedMedia', {
        features: appearance === 'system'
          ? []
          : [{ name: 'prefers-color-scheme', value: appearance }],
      })
    }

    // Recorded only once every command has resolved: a rejected command leaves
    // the guest in the previous state, and remembering the new one would skip
    // the retry that would have fixed it.
    this.appliedEmulation = next
  }

  async navigate(op: BrowserNavigateOp): Promise<void> {
    if (op.kind === 'goto') {
      await this.contents.loadURL(op.url)
      return
    }
    if (op.kind === 'reload') {
      this.contents.reload()
      return
    }
    // `navigationHistory` is the supported form; the old goBack/goForward pair
    // is deprecated and gone in current Electron.
    const history = this.contents.navigationHistory
    if (op.kind === 'back' && history.canGoBack()) history.goBack()
    if (op.kind === 'forward' && history.canGoForward()) history.goForward()
  }

  /**
   * The emulated viewport as a PNG.
   *
   * `Page.captureScreenshot` is the primary. A headless guest captures its
   * emulated surface, including the device pixel ratio. A visible `<webview>`
   * captures its current view instead: asking Chromium for that guest's surface
   * can temporarily replace the composited page with the device-sized surface,
   * which makes the page shrink and expand in front of the user. The view keeps
   * the visible geometry stable. `capturePage` is answered by the same guest and
   * remains the last bounded fallback.
   *
   * A capture is a bounded reason to wake a guest only after the passive CDP
   * read fails. Disabling background throttling on one webview makes Electron
   * draw the whole BrowserWindow. Doing that before every capture made a quick
   * annotation comment look like both the page and conversation refreshed.
   * A visible page that just painted a mark already has a frame, so read it
   * first and leave the window alone. Parked pages still get the bounded wake-up
   * and fallbacks below.
   */
  async captureScreenshot(): Promise<string> {
    try {
      const shot = await this.ask(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: false,
          // A native webview shares its visible compositor surface with the app.
          // Capture the view so Chromium never swaps in a differently sized
          // device surface while the user is looking at it. Headless guests have
          // no visible view to disturb and keep the exact emulated-DPR surface.
          fromSurface: this.kind !== 'webview',
          // The visible webview and the Solus renderer share one Chromium
          // compositor. Prefer the fast PNG encoder so taking evidence does not
          // hold a frame while Chromium optimizes the image size.
          optimizeForSpeed: true,
        },
        screenshotResultSchema,
        SCREENSHOT_TIMEOUT_MS,
      )
      if (shot) return `data:image/png;base64,${shot.data}`
    } catch {
      // A parked webview can have no compositor frame to read. Only that slow
      // path is allowed to wake the BrowserWindow and ask for a fresh one.
    }

    const wasBackgroundThrottled = this.contents.getBackgroundThrottling()
    if (wasBackgroundThrottled) this.contents.setBackgroundThrottling(false)

    try {
      if (wasBackgroundThrottled) {
        // Wait for the wake-up to produce a frame before asking either capture
        // path for it. The timeout is shorter than the verb deadline, so a dead
        // guest still fails instead of holding the agent turn open.
        await this.ask(
          'Runtime.evaluate',
          {
            expression: 'new Promise(resolve => requestAnimationFrame(() => resolve("painted")))',
            returnByValue: true,
            awaitPromise: true,
          },
          evaluateResultSchema,
          SCREENSHOT_TIMEOUT_MS,
        )
      }

      try {
        return await this.captureScreencastFrame()
      } catch {
        // A guest that cannot start a screencast still gets Electron's capture.
      }
      // Timed as well. `capturePage` is Electron's own call rather than a CDP
      // command, but it is answered by the same guest — so it can stall for the
      // same reasons, and an untimed fallback would only move the hang.
      const image = await withTimeout(this.contents.capturePage(), 'capturePage', SCREENSHOT_TIMEOUT_MS)
      if (image.isEmpty()) throw new Error('The browser surface returned no image.')
      return image.toDataURL()
    } finally {
      if (wasBackgroundThrottled && !this.contents.isDestroyed()) {
        this.contents.setBackgroundThrottling(true)
      }
    }
  }

  /**
   * Ask Chromium to produce one fresh frame instead of reading the last frame.
   *
   * The live failure was specific to a `<webview>`: Runtime evaluation answered,
   * but both screenshot readers waited forever for a compositor swap. Starting a
   * screencast creates a frame subscription and therefore supplies the missing
   * demand. The listener is installed before the command so the first frame
   * cannot race past it, and every exit removes the subscription again.
   */
  private async captureScreencastFrame(): Promise<string> {
    let onFrame: ((_event: Electron.Event, method: string, params: CdpEventParams) => void) | undefined
    const frame = new Promise<z.output<typeof screencastFrameSchema>>((resolve) => {
      onFrame = (_event: Electron.Event, method: string, params: CdpEventParams): void => {
        if (method !== 'Page.screencastFrame') return
        const parsed = screencastFrameSchema.safeParse(params)
        if (!parsed.success) return
        resolve(parsed.data)
      }
      this.cdp.on('message', onFrame)
    })

    try {
      await this.send(
        'Page.startScreencast',
        { format: 'png', everyNthFrame: 1 },
        SCREENSHOT_TIMEOUT_MS,
      )
      const shot = await withTimeout(frame, 'Page.screencastFrame', SCREENSHOT_TIMEOUT_MS)
      await this.send(
        'Page.screencastFrameAck',
        { sessionId: shot.sessionId },
        SCREENSHOT_TIMEOUT_MS,
      )
      return `data:image/png;base64,${shot.data}`
    } finally {
      if (onFrame) this.cdp.off('message', onFrame)
      await this.send('Page.stopScreencast', undefined, SCREENSHOT_TIMEOUT_MS).catch(() => {})
    }
  }

  /**
   * Stream JPEG frames continuously until stopped.
   *
   * The frames arrive as `Page.screencastFrame` events on the shared protocol
   * message handler, so the only state this keeps is the listener to forward
   * them to. Calling it again while streaming replaces caps and listener — a
   * viewport change restarts the stream at the new size rather than opening a
   * second one.
   */
  async startScreencast(options: BrowserScreencastOptions, onFrame: BrowserFrameListener): Promise<void> {
    this.screencastFrame = onFrame
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: options.quality,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      everyNthFrame: 1,
    })
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastFrame) return
    this.screencastFrame = null
    if (this.contents.isDestroyed()) return
    await this.send('Page.stopScreencast').catch(() => {})
  }

  /** Forward one streamed frame and acknowledge it. The ack is not optional:
   *  Chromium sends the next frame only once the current one is acknowledged, so
   *  a missed ack turns a stream into a single still. */
  private forwardScreencastFrame(params: CdpEventParams): void {
    const listener = this.screencastFrame
    if (!listener) return
    const parsed = screencastFrameSchema.safeParse(params)
    if (!parsed.success) return
    void this.send('Page.screencastFrameAck', { sessionId: parsed.data.sessionId }).catch(() => {})
    listener(Buffer.from(parsed.data.data, 'base64'))
  }

  async evaluate(expression: string): Promise<string> {
    const outcome = await this.ask(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      evaluateResultSchema,
    )
    if (!outcome) return 'null'
    if (outcome.exceptionDetails) {
      throw new Error(outcome.exceptionDetails.text ?? 'The browser page threw while evaluating.')
    }
    // Every expression this driver is handed returns a JSON string by
    // construction; anything else is a page that redefined a global.
    return outcome.result?.value ?? 'null'
  }

  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      })
    }
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  async pressKey(key: string): Promise<void> {
    const descriptor = KEY_DESCRIPTORS.get(key) ?? { key, code: key, keyCode: 0 }
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.keyCode,
        nativeVirtualKeyCode: descriptor.keyCode,
      })
    }
  }

  async scrollAt(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
    })
  }

  consoleEntries(): BrowserConsoleEntry[] {
    return this.console
  }

  networkEntries(): BrowserNetworkEntry[] {
    return this.network
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // A watched page can be disposed mid-stream (its pane closed, its guest
    // migrated). Drop the listener before the debugger detaches so no frame is
    // forwarded to a page that is going away.
    this.screencastFrame = null
    this.cdp.off('message', this.onProtocolMessage)
    if (this.contents.isDestroyed()) return
    try {
      await this.ownership.releaseGuest()
      this.appliedEmulation = null
    } catch {
      // A guest that went away mid-teardown needs no cleanup.
    }
    if (!this.contents.isDestroyed() && this.cdp.isAttached()) this.cdp.detach()
  }

  /** Bound so `off` can remove it — a leaked listener per attach would keep
   *  every closed page's ring alive for the life of the app. */
  private onProtocolMessage = (_event: Electron.Event, method: string, params: CdpEventParams): void => {
    if (method === 'Runtime.consoleAPICalled') this.recordConsoleApi(params)
    else if (method === 'Log.entryAdded') this.recordLogEntry(params)
    else if (method === 'Network.responseReceived') this.recordResponse(params)
    else if (method === 'Network.loadingFailed') this.recordFailure(params)
    else if (method === 'Page.screencastFrame') this.forwardScreencastFrame(params)
  }

  private recordConsoleApi(params: CdpEventParams): void {
    const parsed = consoleApiSchema.safeParse(params)
    if (!parsed.success) return
    const text = parsed.data.args
      .map((arg) => (arg.value === undefined ? arg.description ?? '' : String(arg.value)))
      .join(' ')
      .slice(0, MAX_ENTRY_CHARS)
    if (!text) return
    this.pushConsole({ at: Date.now(), level: consoleLevel(parsed.data.type), text })
  }

  private recordLogEntry(params: CdpEventParams): void {
    const parsed = logEntrySchema.safeParse(params)
    if (!parsed.success || !parsed.data.entry.text) return
    const { entry } = parsed.data
    const record: BrowserConsoleEntry = {
      at: Date.now(),
      level: consoleLevel(entry.level),
      text: entry.text.slice(0, MAX_ENTRY_CHARS),
    }
    if (entry.url) record.source = entry.url
    this.pushConsole(record)
  }

  private recordResponse(params: CdpEventParams): void {
    const parsed = networkResponseSchema.safeParse(params)
    if (!parsed.success) return
    this.pushNetwork({
      at: Date.now(),
      method: 'GET',
      url: parsed.data.response.url,
      status: parsed.data.response.status,
    })
  }

  private recordFailure(params: CdpEventParams): void {
    const parsed = networkFailureSchema.safeParse(params)
    this.pushNetwork({
      at: Date.now(),
      method: 'GET',
      url: '',
      status: 0,
      failure: parsed.success ? parsed.data.errorText : 'Request failed',
    })
  }

  private pushConsole(entry: BrowserConsoleEntry): void {
    this.console.push(entry)
    if (this.console.length > BROWSER_RING_LIMIT) this.console.splice(0, this.console.length - BROWSER_RING_LIMIT)
  }

  private pushNetwork(entry: BrowserNetworkEntry): void {
    this.network.push(entry)
    if (this.network.length > BROWSER_RING_LIMIT) this.network.splice(0, this.network.length - BROWSER_RING_LIMIT)
  }
}

/**
 * Reject rather than wait forever.
 *
 * `Debugger.sendCommand` has no timeout of its own, and a guest that stops
 * answering leaves the promise pending for the life of the process. Every CDP
 * call in this file goes through here so a stall becomes an error someone can
 * see, report, and retry.
 */
export async function withTimeout<T>(work: Promise<T>, method: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The browser guest did not answer ${method} within ${timeoutMs}ms.`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function consoleLevel(raw: string | undefined): BrowserConsoleEntry['level'] {
  switch (raw) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
    case 'warn':
      return 'warn'
    case 'debug':
    case 'verbose':
      return 'debug'
    case 'info':
      return 'info'
    default:
      return 'log'
  }
}

/** The keys a QA pass actually presses. Anything else is sent verbatim, which
 *  works for single printable characters. */
const KEY_DESCRIPTORS = new Map([
  ['Enter', { key: 'Enter', code: 'Enter', keyCode: 13 }],
  ['Tab', { key: 'Tab', code: 'Tab', keyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', keyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', keyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', keyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }],
])
