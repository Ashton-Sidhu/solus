import { join } from 'path'
import { z } from 'zod'
import {
  BROWSER_RING_LIMIT,
  type BrowserConsoleEntry,
  type BrowserHostKind,
  type BrowserNavigateOp,
  type BrowserNetworkEntry,
  type BrowserSurfaceReport,
} from '@solus/contracts/browser-types'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { browserGuestStyleScript } from './guest-style'
import {
  emulationChanges,
  emulationRecord,
  setBrowserHeadlessHost,
  type AppliedEmulation,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserHeadlessOpenRequest,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from './surface-driver'

/**
 * The headless host for a Solus server that is not inside Electron.
 *
 * The desktop app already has a Chromium — its own — so a page with no pane is
 * hosted by a window it never shows. A standalone server has none, and until it
 * does, every drive verb on that host fails loudly: an agent working against a
 * remote Solus cannot look at anything. Playwright's bundled Chromium is what
 * fills that gap, and it is the only option there, because the packaged server
 * is a plain Node runtime.
 *
 * It is loaded at runtime rather than imported, and its absence is a normal
 * state: a server installed without the browser keeps behaving exactly as it did
 * before — no browser host, verbs that say so — instead of failing to boot.
 *
 * Everything below the browser is CDP, deliberately. The desktop driver is CDP
 * too, so a page hosted here and a page hosted in a pane are emulated, captured,
 * and driven by the same commands. Playwright supplies the process and the page
 * lifecycle; it does not get to be a second implementation of the product.
 */

const log = createLogger('browser', 'playwright-host.ts')

const CDP_TIMEOUT_MS = 10_000
const SCREENSHOT_TIMEOUT_MS = 5_000
const MAX_ENTRY_CHARS = 2000

/**
 * The Playwright surface this file uses, and nothing else.
 *
 * Declared here rather than imported because the package is optional: a build
 * that never installs it must still typecheck, and a narrow structural type is
 * also the honest statement of how little of Playwright is load-bearing.
 */
interface PlaywrightCdpSession {
  send(method: string, params?: CdpCommandParams): Promise<CdpCommandReply>
  on(event: string, handler: (params: CdpEventParams) => void): void
  off(event: string, handler: (params: CdpEventParams) => void): void
  detach(): Promise<void>
}

interface PlaywrightPage {
  goto(url: string): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  reload(): Promise<void>
  url(): string
  title(): Promise<string>
  close(): Promise<void>
  isClosed(): boolean
  on(event: string, handler: () => void): void
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  newCDPSession(page: PlaywrightPage): Promise<PlaywrightCdpSession>
  close(): Promise<void>
}

interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    options: { headless: boolean; viewport: null; args: string[] },
  ): Promise<PlaywrightContext>
}

type CdpCommandParams =
  | { width: number; height: number; deviceScaleFactor: number; mobile: boolean; screenWidth: number; screenHeight: number }
  | { enabled: boolean; maxTouchPoints?: number }
  | { userAgent: string }
  | { features: { name: string; value: string }[] }
  | { format: 'png'; captureBeyondViewport: boolean }
  | { format: 'jpeg'; quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number }
  | { sessionId: number }
  | { expression: string; returnByValue: boolean; awaitPromise: boolean }
  | { type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: string; key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number }
  | { text: string }
  | { source: string }

const consoleApiSchema = z.object({
  type: z.string().optional(),
  args: z.array(z.object({
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })).default([]),
})

const networkResponseSchema = z.object({
  response: z.object({ url: z.string().min(1), status: z.number().default(0) }),
})

const networkFailureSchema = z.object({ errorText: z.string().default('Request failed') })

const screenshotResultSchema = z.object({ data: z.string().min(1) })

const screencastFrameSchema = z.object({ data: z.string().min(1), sessionId: z.number() })

const evaluateResultSchema = z.object({
  result: z.object({ value: z.string().optional() }).optional(),
  exceptionDetails: z.object({ text: z.string().optional() }).optional(),
})

/** Every reply this driver reads back, before validation. A command whose reply
 *  nobody reads still lands here and simply fails to parse, which is the same
 *  as ignoring it. */
type CdpCommandReply =
  | z.input<typeof screenshotResultSchema>
  | z.input<typeof evaluateResultSchema>
  | null

type CdpEventParams =
  | z.input<typeof consoleApiSchema>
  | z.input<typeof networkResponseSchema>
  | z.input<typeof networkFailureSchema>
  | z.input<typeof screencastFrameSchema>

/**
 * Register the host if this machine has the browser, and say so either way.
 *
 * Returns a disposer so the caller can shut the browsers down with the server:
 * a Chromium that outlives the process that launched it is the worst kind of
 * leak, because nothing left is holding its pid.
 */
export async function registerPlaywrightBrowserHost(): Promise<(() => Promise<void>) | null> {
  const chromium = await loadChromium()
  if (!chromium) {
    log.info('browser_playwright_absent', {
      reason: 'playwright-core is not installed on this host; browser pages cannot be hosted here.',
    })
    return null
  }
  const contexts = new Map<string, Promise<PlaywrightContext>>()
  setBrowserHeadlessHost({
    open: (request) => openPlaywrightGuest(chromium, contexts, request),
  })
  log.info('browser_playwright_registered', {})
  return async () => {
    setBrowserHeadlessHost(null)
    for (const pending of contexts.values()) {
      await pending.then((context) => context.close()).catch(() => {})
    }
    contexts.clear()
  }
}

/** The optional dependency, resolved at runtime. A bundler must not follow this
 *  — the package is deliberately external — so the specifier is built rather
 *  than written literally. */
async function loadChromium(): Promise<PlaywrightChromium | null> {
  const specifier = ['playwright', 'core'].join('-')
  try {
    const loaded: { chromium?: PlaywrightChromium } = await import(specifier)
    return loaded.chromium ?? null
  } catch {
    return null
  }
}

/** One persistent context per project profile, so a login obtained once is the
 *  login every page in that project gets — the same rule the desktop hosts
 *  follow with their Electron partition. */
function contextFor(
  chromium: PlaywrightChromium,
  contexts: Map<string, Promise<PlaywrightContext>>,
  partition: string,
): Promise<PlaywrightContext> {
  const existing = contexts.get(partition)
  if (existing) return existing
  const opening = chromium.launchPersistentContext(join(dataDir(), 'browser-profiles', partition), {
    headless: true,
    // Null, because the viewport is CDP's job here: emulation has to carry
    // touch, pixel ratio and user agent, which a Playwright viewport does not.
    viewport: null,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  }).catch((error) => {
    contexts.delete(partition)
    throw error
  })
  contexts.set(partition, opening)
  return opening
}

async function openPlaywrightGuest(
  chromium: PlaywrightChromium,
  contexts: Map<string, Promise<PlaywrightContext>>,
  request: BrowserHeadlessOpenRequest,
): Promise<BrowserSurfaceDriver> {
  const context = await contextFor(chromium, contexts, request.partition)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const driver = new PlaywrightBrowserDriver(page, cdp)
  await driver.enableDomains()
  // Set before the navigation below, so the first real page — and every one
  // after it — carries Solus's scrollbar rather than Chromium's default bar.
  await driver.installGuestStyle()

  try {
    // Emulation before the navigation, for the same reason the desktop headless
    // host does it: the page lays out once, at the size that was asked for, and
    // the console and network rings cover its own load rather than starting
    // mid-life.
    await driver.applyEmulation(request.emulation)
  } catch (error) {
    await driver.dispose().catch(() => {})
    throw error
  }

  const report = (): void => {
    if (page.isClosed()) return
    void driver.report().then(request.report).catch(() => {})
  }
  page.on('load', report)
  page.on('framenavigated', report)

  try {
    await page.goto(request.url)
  } catch {
    // A load that fails still commits an error page, and that failure is the
    // page's state rather than a reason to refuse the guest.
  }
  report()

  log.info('browser_playwright_opened', { url: request.url, partition: request.partition })
  return driver
}

/**
 * The same driver as the desktop one, over a Playwright page.
 *
 * Every method below sends the identical CDP command the Electron driver sends.
 * That is the point: a page an agent drives on a standalone server and a page a
 * user watches on the desktop must not be two different products, and the only
 * way to guarantee that is for the wire traffic to be the same.
 */
class PlaywrightBrowserDriver implements BrowserSurfaceDriver {
  readonly kind: Exclude<BrowserHostKind, 'none'> = 'headless'
  private readonly console: BrowserConsoleEntry[] = []
  private readonly network: BrowserNetworkEntry[] = []
  private appliedEmulation: AppliedEmulation | null = null
  private screencastFrame: BrowserFrameListener | null = null
  private disposed = false

  constructor(
    private readonly page: PlaywrightPage,
    private readonly cdp: PlaywrightCdpSession,
  ) {}

  async enableDomains(): Promise<void> {
    this.cdp.on('Runtime.consoleAPICalled', this.onConsoleApi)
    this.cdp.on('Network.responseReceived', this.onResponse)
    this.cdp.on('Network.loadingFailed', this.onFailure)
    this.cdp.on('Page.screencastFrame', this.onScreencastFrame)
    await Promise.all(
      ['Runtime.enable', 'Network.enable', 'Page.enable'].map((method) => this.send(method)),
    )
  }

  /** Style the guest's scrollbar so it matches Solus. Registered before the
   *  first navigation, so it reaches that page and every later one; best-effort,
   *  because a styled scrollbar is a nicety and not a reason to refuse a guest. */
  async installGuestStyle(): Promise<void> {
    try {
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: browserGuestStyleScript() })
    } catch {
      // The guest renders fine without it.
    }
  }

  async applyEmulation(emulation: BrowserEmulation): Promise<void> {
    const { viewport, appearance } = emulation
    // A headless Chromium has no user agent of its own worth naming, so an
    // absent one is recorded as the empty string and compared like any other.
    const next = emulationRecord(emulation, '')
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
      // turning touch off is `enabled: false` on its own.
      await this.send('Emulation.setTouchEmulationEnabled', viewport.hasTouch
        ? { enabled: true, maxTouchPoints: 5 }
        : { enabled: false })
    }
    if (changed.userAgent && next.userAgent) {
      await this.send('Emulation.setUserAgentOverride', { userAgent: next.userAgent })
    }
    if (changed.appearance) {
      await this.send('Emulation.setEmulatedMedia', {
        features: appearance === 'system' ? [] : [{ name: 'prefers-color-scheme', value: appearance }],
      })
    }
    this.appliedEmulation = next
  }

  async navigate(op: BrowserNavigateOp): Promise<void> {
    if (op.kind === 'goto') {
      await this.page.goto(op.url)
      return
    }
    if (op.kind === 'reload') {
      await this.page.reload()
      return
    }
    // Playwright resolves these to null at the ends of history rather than
    // throwing, so no capability check is needed first.
    if (op.kind === 'back') await this.page.goBack()
    else await this.page.goForward()
  }

  async captureScreenshot(): Promise<string> {
    const shot = await this.ask(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      screenshotResultSchema,
      SCREENSHOT_TIMEOUT_MS,
    )
    if (!shot) throw new Error('The browser guest returned no image.')
    return `data:image/png;base64,${shot.data}`
  }

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
    if (this.page.isClosed()) return
    await this.send('Page.stopScreencast').catch(() => {})
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
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  }

  /**
   * There is nowhere to put an inspector here.
   *
   * This host exists precisely because the standalone server has no window
   * system — its Chromium is headless. DevTools opened on this machine would
   * also be on the wrong machine: the person asking is at a client, possibly a
   * continent away. Saying so is the honest answer; the desktop host is where
   * the inspector lives.
   */
  async openDevTools(): Promise<void> {
    throw new Error(
      'DevTools need a desktop Solus app: this page is rendered by a headless browser on the server.',
    )
  }

  consoleEntries(): BrowserConsoleEntry[] {
    return this.console
  }

  networkEntries(): BrowserNetworkEntry[] {
    return this.network
  }

  /** What this guest is showing, in the shape a pane's report uses — so a page
   *  hosted here is exactly as legible as one hosted anywhere else. */
  async report(): Promise<BrowserSurfaceReport> {
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      loadState: 'ready',
      // Playwright exposes no history-depth reading, so the toolbar's arrows
      // stay available and a navigation at the end of history is a no-op rather
      // than a refused command. Streamed clients are the only ones that see
      // this, and an inert arrow is a smaller lie than a missing one.
      canGoBack: true,
      canGoForward: true,
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.screencastFrame = null
    this.cdp.off('Runtime.consoleAPICalled', this.onConsoleApi)
    this.cdp.off('Network.responseReceived', this.onResponse)
    this.cdp.off('Network.loadingFailed', this.onFailure)
    this.cdp.off('Page.screencastFrame', this.onScreencastFrame)
    await this.cdp.detach().catch(() => {})
    // The page goes with the guest; the context does not, because the profile
    // it holds is the project's and outlives any one page.
    await this.page.close().catch(() => {})
  }

  private async send(method: string, params?: CdpCommandParams, timeoutMs = CDP_TIMEOUT_MS): Promise<void> {
    await withTimeout(this.cdp.send(method, params), method, timeoutMs)
  }

  private async ask<Schema extends z.ZodType>(
    method: string,
    params: CdpCommandParams,
    schema: Schema,
    timeoutMs = CDP_TIMEOUT_MS,
  ): Promise<z.output<Schema> | null> {
    const reply = await withTimeout(this.cdp.send(method, params), method, timeoutMs)
    const parsed = schema.safeParse(reply)
    return parsed.success ? parsed.data : null
  }

  private onConsoleApi = (params: CdpEventParams): void => {
    const parsed = consoleApiSchema.safeParse(params)
    if (!parsed.success) return
    const text = parsed.data.args
      .map((arg) => (arg.value === undefined ? arg.description ?? '' : String(arg.value)))
      .join(' ')
      .slice(0, MAX_ENTRY_CHARS)
    if (!text) return
    this.push(this.console, { at: Date.now(), level: consoleLevel(parsed.data.type), text })
  }

  private onResponse = (params: CdpEventParams): void => {
    const parsed = networkResponseSchema.safeParse(params)
    if (!parsed.success) return
    this.push(this.network, {
      at: Date.now(),
      method: 'GET',
      url: parsed.data.response.url,
      status: parsed.data.response.status,
    })
  }

  private onFailure = (params: CdpEventParams): void => {
    const parsed = networkFailureSchema.safeParse(params)
    this.push(this.network, {
      at: Date.now(),
      method: 'GET',
      url: '',
      status: 0,
      failure: parsed.success ? parsed.data.errorText : 'Request failed',
    })
  }

  /** Chromium sends the next frame only once the current one is acknowledged, so
   *  a missed ack turns a stream into a single still. */
  private onScreencastFrame = (params: CdpEventParams): void => {
    const listener = this.screencastFrame
    if (!listener) return
    const parsed = screencastFrameSchema.safeParse(params)
    if (!parsed.success) return
    void this.send('Page.screencastFrameAck', { sessionId: parsed.data.sessionId }).catch(() => {})
    listener(Buffer.from(parsed.data.data, 'base64'))
  }

  private push<Entry>(ring: Entry[], entry: Entry): void {
    ring.push(entry)
    if (ring.length > BROWSER_RING_LIMIT) ring.splice(0, ring.length - BROWSER_RING_LIMIT)
  }
}

/** A CDP command that stalls must become an error someone can see, not a promise
 *  that never settles under an agent's tool call. */
async function withTimeout<T>(work: Promise<T>, method: string, timeoutMs: number): Promise<T> {
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
