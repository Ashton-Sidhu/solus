import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { initBrowserRegistry, type BrowserEventSink } from '@solus/server/browser/browser-registry'
import { BrowserFrameChannel } from '@solus/server/browser/browser-frame-channel'
import {
  setBrowserHeadlessHost,
  setBrowserWebviewHost,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserHeadlessOpenRequest,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import {
  browserPartition,
  type BrowserConsoleEntry,
  type BrowserNavigateOp,
  type BrowserNetworkEntry,
  type BrowserPage,
} from '@solus/contracts/browser-types'

/**
 * The headless host is what makes a browser page addressable with nobody
 * watching it: an agent in a worktree, an automation, or a phone drives a page
 * that no desktop pane is showing. These tests encode the rules that keep that
 * from becoming a second, divergent product — one page has one host at a time,
 * a headless page emulates what the user chose, and it uses the login the user
 * already has.
 */

class FakeDriver implements BrowserSurfaceDriver {
  emulations: BrowserEmulation[] = []
  navigations: BrowserNavigateOp[] = []
  clicks: { x: number; y: number }[] = []
  disposed = false
  /** Set to make emulation fail, which is the one refusal the registry makes. */
  refuseEmulation = false

  constructor(readonly kind: 'webview' | 'headless') {}

  async applyEmulation(emulation: BrowserEmulation): Promise<void> {
    if (this.refuseEmulation) throw new Error('This guest cannot be emulated.')
    this.emulations.push(emulation)
  }

  async navigate(op: BrowserNavigateOp): Promise<void> {
    this.navigations.push(op)
  }

  async captureScreenshot(): Promise<string> {
    return 'data:image/png;base64,AAAA'
  }

  async evaluate(expression: string): Promise<string> {
    // The only expression these tests care about is the one that locates an
    // element, so a click has somewhere to land.
    return expression.includes('getBoundingClientRect') ? '{"x":10,"y":20}' : 'null'
  }

  async clickAt(x: number, y: number): Promise<void> {
    this.clicks.push({ x, y })
  }

  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}

  screencasts: BrowserScreencastOptions[] = []
  screencastStops = 0
  private frameListener: BrowserFrameListener | null = null

  async startScreencast(options: BrowserScreencastOptions, onFrame: BrowserFrameListener): Promise<void> {
    this.screencasts.push(options)
    this.frameListener = onFrame
  }

  async stopScreencast(): Promise<void> {
    this.screencastStops += 1
    this.frameListener = null
  }

  /** Push a frame the way the real driver's screencast handler would. */
  emitFrame(bytes: Uint8Array): void {
    this.frameListener?.(bytes)
  }

  consoleEntries(): BrowserConsoleEntry[] {
    return []
  }

  networkEntries(): BrowserNetworkEntry[] {
    return []
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function harness(options: { headless?: boolean } = {}) {
  const published: BrowserPage[] = []
  const sink: BrowserEventSink = {
    pageChanged: (page) => published.push(structuredClone(page)),
    pageClosed: () => {},
    surfaceRequested: () => {},
  }
  const webviewDriver = new FakeDriver('webview')
  setBrowserWebviewHost({
    attach: async () => webviewDriver,
    clearProfile: async () => {},
  })

  const headlessOpens: BrowserHeadlessOpenRequest[] = []
  const headlessDrivers: FakeDriver[] = []
  /** While set, an open waits on it — the way a test stages a deliberate race. */
  let pending: Promise<void> | null = null
  let letOpenFinish = (): void => {}

  if (options.headless === false) {
    setBrowserHeadlessHost(null)
  } else {
    setBrowserHeadlessHost({
      open: async (request) => {
        headlessOpens.push(request)
        if (pending) await pending
        const driver = new FakeDriver('headless')
        // The real host emulates before it navigates, and throws rather than
        // returning a guest it could not prepare.
        await driver.applyEmulation(request.emulation)
        headlessDrivers.push(driver)
        return driver
      },
    })
  }

  return {
    registry: initBrowserRegistry(sink, new BrowserFrameChannel()),
    webviewDriver,
    published,
    headlessOpens,
    headlessDrivers,
    holdOpen(): void {
      pending = new Promise<void>((resolve) => { letOpenFinish = resolve })
    },
    releaseOpen(): void {
      pending = null
      letOpenFinish()
    },
  }
}

afterEach(() => {
  // Both hosts are process singletons; a test that left one registered would
  // silently change what the next file's registry can do.
  setBrowserHeadlessHost(null)
  setBrowserWebviewHost(null)
})

const TARGET = { kind: 'url', url: 'http://localhost:5173/', projectRoot: '/Users/dev/app' } as const

describe('the headless browser host', () => {
  test('an unhosted page is not a problem where something can render it', () => {
    // WHY: "waiting for a browser pane" told the user to open a pane. With a
    // headless host the page is merely waiting for someone to need it, and
    // saying otherwise would send them after a fix that is not required.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    expect(page.hostKind).toBe('none')
    expect(page.problem).toBeUndefined()
  })

  test('a drive op on a page with no pane opens a headless guest and drives it', async () => {
    // WHY: this is the whole point of the host. An agent in a worktree, or a
    // user on a phone, must be able to click through a page with no desktop
    // client attached anywhere.
    const { registry, headlessDrivers } = harness()
    const page = registry.open({ target: TARGET })

    const result = await registry.interact(page.browserPageId, { kind: 'click', ref: '#submit' })

    expect(result.ok).toBe(true)
    expect(headlessDrivers[0]?.clicks).toEqual([{ x: 10, y: 20 }])
    expect(registry.get(page.browserPageId)?.hostKind).toBe('headless')
  })

  test('a headless page emulates the viewport the user chose', async () => {
    // WHY: an agent checking a phone breakpoint must get the phone. A headless
    // guest that opened at its window's own metrics would report a passing
    // layout the user can never see.
    const { registry, headlessOpens } = harness()
    const page = registry.open({ target: TARGET, presetId: 'iphone-15' })

    await registry.snapshot(page.browserPageId, { screenshot: false })

    expect(headlessOpens[0]?.emulation.viewport.width).toBe(393)
    expect(headlessOpens[0]?.emulation.userAgent).toContain('iPhone')
  })

  test('a headless page opens in the project profile, not a fresh one', async () => {
    // WHY: profiles carry the login. A headless guest with its own profile would
    // land on a sign-in wall for every page the user can already see.
    const { registry, headlessOpens } = harness()
    const page = registry.open({ target: TARGET })

    await registry.snapshot(page.browserPageId, { screenshot: false })

    expect(headlessOpens[0]?.partition).toBe(browserPartition('/Users/dev/app'))
    expect(headlessOpens[0]?.url).toBe('http://localhost:5173/')
  })

  test('two drive ops arriving together share one guest', async () => {
    // WHY: opening is slow enough to overlap. Two guests for one page would each
    // be driven half the time, and the agent's clicks would land in a browser
    // its snapshot never sees.
    const { registry, headlessDrivers, headlessOpens, holdOpen, releaseOpen } = harness()
    holdOpen()
    const page = registry.open({ target: TARGET })

    const both = Promise.all([
      registry.interact(page.browserPageId, { kind: 'click', ref: '#a' }),
      registry.interact(page.browserPageId, { kind: 'click', ref: '#b' }),
    ])
    await Promise.resolve()
    releaseOpen()
    await both

    expect(headlessOpens).toHaveLength(1)
    expect(headlessDrivers).toHaveLength(1)
    expect(headlessDrivers[0]?.clicks).toHaveLength(2)
  })

  test('a native handover waits until a headless command has finished', async () => {
    // WHY: a snapshot can be waiting for a slow headless open when a pane
    // appears. The handover must not dispose that guest halfway through the
    // snapshot or leave the late headless guest as the page owner.
    const { registry, headlessDrivers, holdOpen, releaseOpen } = harness()
    holdOpen()
    const page = registry.open({ target: TARGET })

    const snapshot = registry.snapshot(page.browserPageId, { screenshot: false })
    await Promise.resolve()
    const attach = registry.attachSurface(page.browserPageId, 42)
    releaseOpen()
    await Promise.all([snapshot, attach])

    expect(headlessDrivers).toHaveLength(1)
    expect(headlessDrivers[0]?.disposed).toBe(true)
    expect(registry.get(page.browserPageId)?.hostKind).toBe('webview')
  })

  test('closing during a headless open disposes the guest that finishes opening', async () => {
    // WHY: close cannot cancel the host promise. It must wait for it and dispose
    // its result, or an invisible renderer survives after the page is gone.
    const { registry, headlessDrivers, holdOpen, releaseOpen } = harness()
    holdOpen()
    const page = registry.open({ target: TARGET })

    const drive = registry.interact(page.browserPageId, { kind: 'click', ref: '#a' })
    await Promise.resolve()
    const close = registry.close(page.browserPageId)
    releaseOpen()
    await Promise.allSettled([drive, close])

    expect(headlessDrivers).toHaveLength(1)
    expect(headlessDrivers[0]?.disposed).toBe(true)
    expect(registry.get(page.browserPageId)).toBeNull()
  })

  test('hiding while the first stream opens never starts a screencast', async () => {
    // WHY: unsubscribe can happen before the driver exists. The slow open must
    // recheck demand before it starts producing frames into the void.
    const { registry, headlessDrivers, holdOpen, releaseOpen } = harness()
    holdOpen()
    const page = registry.open({ target: TARGET })

    const subscribe = registry.subscribeFrames(page.browserPageId, 'phone')
    await Promise.resolve()
    const unsubscribe = registry.unsubscribeFrames(page.browserPageId, 'phone')
    releaseOpen()
    await Promise.all([subscribe, unsubscribe])

    expect(headlessDrivers[0]?.screencasts).toHaveLength(0)
  })

  test('opening a pane on a headless page takes the guest away from the host', async () => {
    // WHY: one page, one host. Two live guests would drift, and the agent would
    // verify a page the user is not looking at — the exact failure the whole
    // design exists to prevent.
    const { registry, headlessDrivers } = harness()
    const page = registry.open({ target: TARGET })
    await registry.snapshot(page.browserPageId, { screenshot: false })

    await registry.attachSurface(page.browserPageId, 42)

    expect(headlessDrivers[0]?.disposed).toBe(true)
    expect(registry.get(page.browserPageId)?.hostKind).toBe('webview')
  })

  test('closing the pane leaves the page drivable, on a new headless guest', async () => {
    // WHY: the user walking away must not end the agent's ability to check the
    // page. Migration reloads at the same URL — in-page state does not cross —
    // so the page is re-hosted when something needs it, not held open forever.
    const { registry, headlessDrivers, webviewDriver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 42)

    await registry.detachSurface(page.browserPageId)
    expect(webviewDriver.disposed).toBe(true)
    expect(registry.get(page.browserPageId)?.problem).toBeUndefined()

    await registry.interact(page.browserPageId, { kind: 'click', ref: '#after' })
    expect(registry.get(page.browserPageId)?.hostKind).toBe('headless')
    expect(headlessDrivers[0]?.clicks).toHaveLength(1)
  })

  test('a crashed guest still says so instead of quietly re-hosting', async () => {
    // WHY: a crash is the user's to see. Re-hosting it silently would hide a
    // reproducible failure behind a page that looks fine.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 42)

    await registry.detachSurface(page.browserPageId, 'crashed')

    expect(registry.get(page.browserPageId)?.problem?.kind).toBe('surface-crashed')
  })

  test('a headless guest that cannot be emulated is refused, not kept', async () => {
    // WHY: a guest at its window's own metrics while the page claims to be a
    // phone is worse than no guest — every screenshot would be a quiet lie.
    const { registry } = harness()
    setBrowserHeadlessHost({
      open: async (request) => {
        const driver = new FakeDriver('headless')
        driver.refuseEmulation = true
        await driver.applyEmulation(request.emulation)
        return driver
      },
    })
    const page = registry.open({ target: TARGET, presetId: 'iphone-15' })

    await expect(registry.snapshot(page.browserPageId)).rejects.toThrow('cannot be emulated')
    expect(registry.get(page.browserPageId)?.hostKind).toBe('none')
    expect(registry.get(page.browserPageId)?.problem?.kind).toBe('load-failed')
  })

  test('without a headless host a drive op still fails loudly', async () => {
    // WHY: a host that cannot render must say so. Silence reads to an agent as
    // "the click worked", and the verification loop depends on that being loud.
    const { registry } = harness({ headless: false })
    const page = registry.open({ target: TARGET })

    expect(page.problem?.kind).toBe('no-surface')
    await expect(registry.interact(page.browserPageId, { kind: 'click', ref: '#x' }))
      .rejects.toThrow('cannot render one')
  })
})

/**
 * The ordering inside the host is the whole reason the rings mean anything, and
 * it is invisible from the registry — so it is asserted against the host's own
 * source. Attaching CDP lazily on the first automation action means that the
 * snapshot's console and network entries silently begin after the page has
 * already loaded. This host used that shape until a spike showed that
 * committing `about:blank` first gives CDP a document to attach to without the
 * deadlock that attaching to a brand-new window causes.
 */
describe('the headless guest attach ordering', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../apps/desktop/src/main/browser/headless-window.ts'),
    'utf8',
  )

  test('commits a blank document, attaches, and only then loads the page', () => {
    const blank = source.indexOf("loadURL('about:blank')")
    const attach = source.indexOf('ChromiumBrowserDriver.attach')
    const emulate = source.indexOf('applyEmulation')
    const load = source.indexOf('loadURL(request.url)')

    expect(blank).toBeGreaterThan(-1)
    expect(attach).toBeGreaterThan(blank)
    expect(emulate).toBeGreaterThan(attach)
    // The page's own load is last, so the rings cover it and the guest never
    // lays out at a size it is not supposed to be.
    expect(load).toBeGreaterThan(emulate)
  })
})

/**
 * An agent opening a page to check something must not take over the user's
 * screen. Before the headless host existed, `browser_open` always asked a client
 * for a surface, because a page with no surface could not be driven at all — so
 * every agent-opened page appeared as a live tab in the user's browser pane.
 * That is now a cost paid for nothing, and it also pinned the page to the
 * client's `<webview>`, which is the host where a screenshot can stall.
 */
describe('opening a page on the agent’s behalf', () => {
  const toolsSource = readFileSync(
    join(import.meta.dir, '../../packages/server/src/browser/browser-tools.ts'),
    'utf8',
  )

  test('does not ask for a surface unless the user wants to see it', () => {
    expect(toolsSource).not.toContain('requestSurface: true')
    expect(toolsSource).toContain('requestSurface: input.show === true')
  })

  test('offers showing as a deliberate choice, defaulting to invisible', () => {
    // WHY: the reverse state already exists — a page opened quietly is still
    // listed in the page strip, so the user can bring up anything the agent made.
    const open = toolsSource.slice(toolsSource.indexOf("name: 'browser_open'"))
    const spec = open.slice(0, open.indexOf('\nexport const'))
    expect(spec).toContain('show: z.boolean().optional()')
    expect(spec).toContain('Default false')
  })
})
