import { describe, expect, jest, test } from 'bun:test'
import { initBrowserRegistry, type BrowserEventSink } from '@solus/server/browser/browser-registry'
import { BrowserFrameChannel } from '@solus/server/browser/browser-frame-channel'
import {
  setBrowserProfileHost,
  setBrowserWebviewHost,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import {
  BROWSER_MARK_TOOLS,
  browserPartition,
  type BrowserConsoleEntry,
  type BrowserNavigateOp,
  type BrowserNetworkEntry,
  type BrowserPage,
} from '@solus/contracts/browser-types'

/**
 * The registry is where "one page, one owner" is actually enforced. These tests
 * encode the rules that make an agent and a user agree about what they are
 * looking at, and the rule that keeps a drive op from succeeding against
 * nothing.
 */

class FakeDriver implements BrowserSurfaceDriver {
  readonly kind = 'webview' as const
  emulations: BrowserEmulation[] = []
  navigations: BrowserNavigateOp[] = []
  clicks: { x: number; y: number }[] = []
  typed: string[] = []
  disposed = false
  /** Keyed by a fragment of the expression, so a test states what the guest
   *  answers without reproducing the whole injected script. */
  answers = new Map<string, string>()

  /** Every call in order, so a test can assert that emulation reached the guest
   *  before the page it has to lay out did. */
  sequence: string[] = []

  async applyEmulation(emulation: BrowserEmulation): Promise<void> {
    this.emulations.push(emulation)
    this.sequence.push(`emulate:${emulation.viewport.width}x${emulation.viewport.height}`)
  }

  async navigate(op: BrowserNavigateOp): Promise<void> {
    this.navigations.push(op)
    this.sequence.push(op.kind === 'goto' ? `goto:${op.url}` : op.kind)
  }

  async captureScreenshot(): Promise<string> {
    return 'data:image/png;base64,AAAA'
  }

  async evaluate(expression: string): Promise<string> {
    this.sequence.push('evaluate')
    for (const [fragment, answer] of this.answers) {
      if (expression.includes(fragment)) return answer
    }
    return 'null'
  }

  async clickAt(x: number, y: number): Promise<void> {
    this.clicks.push({ x, y })
  }

  async insertText(text: string): Promise<void> {
    this.typed.push(text)
  }

  async pressKey(): Promise<void> {}

  scrolls: { x: number; y: number; deltaY: number }[] = []
  async scrollAt(x: number, y: number, deltaY: number): Promise<void> {
    this.scrolls.push({ x, y, deltaY })
  }

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

  /** What the guest was told to do when DevTools closed. Held rather than
   *  called, because closing is the user's act and a test has to stand in for
   *  it. */
  devToolsClosed: (() => void) | null = null
  async openDevTools(onClosed: () => void): Promise<void> {
    this.sequence.push('openDevTools')
    this.devToolsClosed = onClosed
  }

  consoleEntries(): BrowserConsoleEntry[] {
    return [{ at: 1, level: 'error', text: 'boom' }]
  }

  networkEntries(): BrowserNetworkEntry[] {
    return [{ at: 1, method: 'GET', url: 'http://localhost:5173/api', status: 500 }]
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function harness() {
  const published: BrowserPage[] = []
  const closed: string[] = []
  const requested: string[] = []
  const sink: BrowserEventSink = {
    pageChanged: (page) => published.push(structuredClone(page)),
    pageClosed: (browserPageId) => closed.push(browserPageId),
    surfaceRequested: (browserPageId) => requested.push(browserPageId),
  }
  const driver = new FakeDriver()
  const otherDriver = new FakeDriver()
  const cleared: string[] = []
  setBrowserWebviewHost({
    attach: async (webContentsId) => webContentsId === 2 ? otherDriver : driver,
  })
  // The jars are a separate host from the thing that renders a page: a
  // standalone server holds them as directories, the desktop as Electron
  // sessions, and both answer this.
  setBrowserProfileHost({
    clearProfile: async (partition) => {
      cleared.push(partition)
    },
    importCookies: async () => ({ imported: 0, failed: 0 }),
  })
  const frames = new BrowserFrameChannel()
  return {
    registry: initBrowserRegistry(sink, frames),
    driver,
    otherDriver,
    frames,
    published,
    closed,
    requested,
    cleared,
  }
}

const TARGET = { kind: 'url', url: 'http://localhost:5173/' } as const

describe('browser registry', () => {
  test('a new page is honest about having nowhere to render', () => {
    // WHY: the page exists on the host before any client offers a surface. If it
    // claimed to be ready, an agent would drive a page nothing is showing.
    const { registry, published } = harness()
    const page = registry.open({ target: TARGET })

    expect(page.hostKind).toBe('none')
    expect(page.problem?.kind).toBe('no-surface')
    expect(published.at(-1)?.browserPageId).toBe(page.browserPageId)
  })

  test('a drive op against a page with no surface fails instead of doing nothing', async () => {
    // WHY: silence here reads to an agent as "the click worked". The whole
    // verification loop depends on the failure being loud.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    await expect(registry.interact(page.browserPageId, { kind: 'click', ref: '#go' }))
      .rejects.toThrow(/no surface/i)
  })

  test('opening with requestSurface asks a client for one, and only then', () => {
    // WHY: nothing renders without an explicit request — an agent asking is the
    // invocation, not a background auto-open.
    const { registry, requested } = harness()
    registry.open({ target: TARGET })
    expect(requested).toHaveLength(0)

    const asked = registry.open({ target: TARGET, requestSurface: true })
    expect(requested).toEqual([asked.browserPageId])
  })

  test('rotating a preset swaps the viewport and re-emulates the guest', async () => {
    // WHY: emulation is the product. A viewport change that only moved a number
    // in the UI would give a browser that lies about the device.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET, presetId: 'iphone-15' })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.setViewport(page.browserPageId, {
      mode: 'preset',
      presetId: 'iphone-15',
      orientation: 'landscape',
    })

    const applied = driver.emulations.at(-1)
    expect(applied?.viewport.width).toBe(852)
    expect(applied?.viewport.height).toBe(393)
    expect(applied?.viewport.hasTouch).toBe(true)
    expect(applied?.userAgent).toContain('iPhone')
  })

  test('a desktop preset keeps the host browser user agent', async () => {
    // WHY: overriding the agent with a fabricated desktop string would make the
    // browser differ from the browser the developer actually ships against.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET, presetId: 'laptop' })
    await registry.attachSurface(page.browserPageId, 1)

    expect(driver.emulations.at(-1)?.userAgent).toBeUndefined()
  })

  test('a page opens filling its pane, not at a device nobody chose', async () => {
    // WHY: opening a dev server is looking at the app, not at a phone. A
    // device is an act of QA, so it is only ever chosen deliberately — opening
    // at a preset would hand every user a viewport they have to undo first.
    const { registry } = harness()

    const page = registry.open({ target: TARGET })

    expect(page.viewport.mode).toBe('fill')
    expect(page.viewport.presetId).toBeUndefined()
  })

  test('a chosen size survives everything but another choice', async () => {
    // WHY: the mode is the user's, not the session's. Navigating, reloading, or
    // resizing the pane under a page must never quietly put it back to fill —
    // the viewport a check was set up at has to still be there afterwards.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.setViewport(page.browserPageId, { mode: 'preset', presetId: 'iphone-15' })

    await registry.navigate(page.browserPageId, { kind: 'goto', url: 'http://localhost:5173/tasks' })
    await registry.setAppearance(page.browserPageId, 'dark')
    registry.reportSurface(page.browserPageId, {
      url: 'http://localhost:5173/tasks',
      title: 'Tasks',
      loadState: 'ready',
      canGoBack: true,
      canGoForward: false,
    })

    expect(registry.get(page.browserPageId)?.viewport.presetId).toBe('iphone-15')
  })

  test('a custom size emulates the numbers asked for, and claims no device', async () => {
    // WHY: a rectangle is not a phone. Carrying a preset's user agent or pixel
    // ratio into an arbitrary width would make every agent-sniffing page report
    // a device the user is not looking at.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET, presetId: 'iphone-15' })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.setViewport(page.browserPageId, { mode: 'custom', width: 913, height: 640 })

    const applied = driver.emulations.at(-1)
    expect(applied?.viewport.width).toBe(913)
    expect(applied?.viewport.height).toBe(640)
    expect(applied?.viewport.deviceScaleFactor).toBe(1)
    expect(applied?.viewport.hasTouch).toBe(false)
    expect(applied?.userAgent).toBeUndefined()
    expect(registry.get(page.browserPageId)?.viewport.presetId).toBeUndefined()
  })

  test('a size outside the bounds is clamped rather than refused', async () => {
    // WHY: the numbers come from a drag and from a text field, and neither is a
    // place to tell the user the value was invalid — the page just stops at the
    // edge of what a viewport can be.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    await registry.setViewport(page.browserPageId, { mode: 'custom', width: 40, height: 99_999 })

    expect(registry.get(page.browserPageId)?.viewport.width).toBe(120)
    expect(registry.get(page.browserPageId)?.viewport.height).toBe(3840)
  })

  test('a repeated size does not re-emulate the guest', async () => {
    // WHY: a pane drag under a filling page sends a size per frame it settles
    // on. Re-applying an identical viewport would reload layout in the guest and
    // re-render the page in every client for nothing.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    const applied = driver.emulations.length

    await registry.setViewport(page.browserPageId, { mode: 'fill', width: 800, height: 600 })
    await registry.setViewport(page.browserPageId, { mode: 'fill', width: 800, height: 600 })

    expect(driver.emulations.length).toBe(applied + 1)
  })

  test('a snapshot carries the elements, the image, and the retroactive rings', async () => {
    // WHY: a screenshot alone cannot be acted on, and errors that happened
    // before anyone looked are exactly the ones worth reporting.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('data-solus-browser-ref', JSON.stringify({
      title: 'Solus',
      url: 'http://localhost:5173/tasks',
      elements: [{
        role: 'button',
        label: 'New task',
        rect: { x: 8, y: 12, width: 100, height: 32 },
        ref: '[data-solus-browser-ref="e1"]',
        source: { file: 'src/tasks/TaskBar.svelte', line: 42, column: 3 },
      }],
    }))

    const snapshot = await registry.snapshot(page.browserPageId)

    expect(snapshot.url).toBe('http://localhost:5173/tasks')
    expect(snapshot.elements[0]?.source?.file).toBe('src/tasks/TaskBar.svelte')
    expect(snapshot.screenshot).toStartWith('data:image/png;base64,')
    expect(snapshot.console[0]?.text).toBe('boom')
    expect(snapshot.network[0]?.status).toBe(500)
  })

  test('a snapshot can skip the image when only the structure is wanted', async () => {
    // WHY: the image is the expensive half; an agent checking whether a button
    // exists should not pay for it.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    expect((await registry.snapshot(page.browserPageId, { screenshot: false })).screenshot).toBeUndefined()
  })

  test('clicking a ref resolves the point in the guest before dispatching', async () => {
    // WHY: the click is a real trusted event at real coordinates, not a
    // synthetic `.click()` that skips the browser's own hit testing.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('getBoundingClientRect', JSON.stringify({ x: 54, y: 28 }))

    const result = await registry.interact(page.browserPageId, { kind: 'click', ref: '#go' })

    expect(result.ok).toBe(true)
    expect(driver.clicks).toEqual([{ x: 54, y: 28 }])
  })

  test('a stale ref is reported rather than clicked at an arbitrary point', async () => {
    // WHY: the page re-rendered between snapshot and click. Clicking anyway hits
    // whatever moved into that spot.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    const result = await registry.interact(page.browserPageId, { kind: 'click', ref: '#gone' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('#gone')
  })

  test('a failed load becomes a target-unreachable problem, not a browser error string', async () => {
    // WHY: Solus does not own the dev server, so the pane has to say that in its
    // own words instead of showing ERR_CONNECTION_REFUSED.
    const { registry, published } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    registry.reportSurface(page.browserPageId, {
      url: TARGET.url,
      title: '',
      loadState: 'failed',
      canGoBack: false,
      canGoForward: false,
      failure: 'ERR_CONNECTION_REFUSED',
    })

    expect(published.at(-1)?.problem?.kind).toBe('target-unreachable')
    await registry.close(page.browserPageId)
  })

  test('an in-flight liveness probe cannot restore a closed page', async () => {
    // WHY: clearing the interval cannot cancel a fetch already in flight. Its
    // late answer must not publish a deleted page back into every client store.
    jest.useFakeTimers()
    const originalFetch = globalThis.fetch
    let finishProbe = (_response: Response): void => {}
    // SAFETY: this stand-in accepts no arguments because the test controls the
    // only call and models only its pending Response.
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      finishProbe = resolve
    })) as typeof fetch
    try {
      const { registry, published } = harness()
      const page = registry.open({ target: TARGET })
      await registry.attachSurface(page.browserPageId, 1)
      registry.reportSurface(page.browserPageId, {
        url: TARGET.url,
        title: '',
        loadState: 'failed',
        canGoBack: false,
        canGoForward: false,
      })

      jest.advanceTimersByTime(3000)
      await Promise.resolve()
      await registry.close(page.browserPageId)
      const changesAtClose = published.length
      finishProbe(new Response(null, { status: 200 }))
      await Promise.resolve()
      await Promise.resolve()

      expect(published).toHaveLength(changesAtClose)
      expect(registry.get(page.browserPageId)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      jest.useRealTimers()
    }
  })

  test('a surface the host cannot emulate is refused instead of kept', async () => {
    // WHY: a guest that survived a failed emulation renders at the window's own
    // metrics while the page still says it is a phone. Every later snapshot then
    // reports a device that was never applied.
    const { registry, published } = harness()
    const broken = new FakeDriver()
    broken.applyEmulation = async () => {
      throw new Error('Touch points must be between 1 and 16')
    }
    setBrowserWebviewHost({ attach: async () => broken })
    const page = registry.open({ target: TARGET })

    await expect(registry.attachSurface(page.browserPageId, 1)).rejects.toThrow(/touch points/i)

    expect(broken.disposed).toBe(true)
    expect(published.at(-1)?.hostKind).toBe('none')
    expect(published.at(-1)?.problem?.kind).toBe('load-failed')
    await expect(registry.interact(page.browserPageId, { kind: 'click', ref: '#go' }))
      .rejects.toThrow(/no surface/i)
  })

  test('detaching a surface keeps the page and drops the driver', async () => {
    // WHY: closing the pane must not lose the page — an agent may still be
    // working against it, and the user expects it back where they left it.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.detachSurface(page.browserPageId)

    expect(driver.disposed).toBe(true)
    expect(registry.get(page.browserPageId)?.hostKind).toBe('none')
    expect(registry.list()).toHaveLength(1)
  })

  test('a crashed guest is a different state from a closed pane', async () => {
    // WHY: both end with the page having no surface, but only one of them is
    // waiting for the next pane. "Waiting for a browser pane" in front of a
    // dead guest would tell the user to do the one thing that cannot help.
    const { registry, published } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.detachSurface(page.browserPageId, 'crashed')

    expect(published.at(-1)?.hostKind).toBe('none')
    expect(published.at(-1)?.problem?.kind).toBe('surface-crashed')
  })

  test('closing a page disposes its driver and announces the close', async () => {
    const { registry, driver, closed } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.close(page.browserPageId)

    expect(driver.disposed).toBe(true)
    expect(closed).toEqual([page.browserPageId])
    expect(registry.list()).toHaveLength(0)
  })

  test('clearing a profile forgets it and reloads the pages that were using it', async () => {
    // WHY: a persistent login has to have a way out, and a page still showing
    // the signed-in rendering afterwards would say the clear did not work.
    const { registry, driver, otherDriver, cleared } = harness()
    const page = registry.open({
      target: { ...TARGET, projectRoot: '/projects/alpha' },
    })
    await registry.attachSurface(page.browserPageId, 1)
    const otherPage = registry.open({
      target: { ...TARGET, projectRoot: '/projects/beta' },
    })
    await registry.attachSurface(otherPage.browserPageId, 2)

    const partition = browserPartition('/projects/alpha')
    await registry.clearProfile(partition)

    expect(cleared).toEqual([partition])
    expect(driver.navigations.at(-1)).toEqual({ kind: 'reload' })
    expect(otherDriver.navigations.at(-1)).toEqual({ kind: 'goto', url: TARGET.url })
  })

  test('a page is labelled by the worktree branch it serves', () => {
    // WHY: several worktrees of one project are the case the page strip exists
    // for; a row of port numbers would not tell them apart.
    const { registry } = harness()
    const page = registry.open({
      target: { kind: 'url', url: 'http://localhost:5174/', branch: 'solus/visual-qa' },
    })
    expect(page.label).toBe('solus/visual-qa')
  })

  test('a guest is emulated before it is sent to the page, not after', async () => {
    // WHY: this is the whole reason a guest is mounted blank. Loading first and
    // emulating after means the page lays out at the window's size and reflows
    // when the metrics override lands mid-load — visible as a slow, jumpy open.
    // Emulate, then navigate: the page lays out once, at the size it was asked
    // for.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.setViewport(page.browserPageId, { mode: 'custom', width: 500, height: 900 })

    await registry.attachSurface(page.browserPageId, 1)

    expect(driver.sequence).toEqual(['emulate:500x900', 'goto:http://localhost:5173/'])
  })

  test('a page keeps the address it is on across a re-attach', async () => {
    // WHY: the guest is blank on every mount, so the host decides where it goes.
    // Sending it to the original target would silently throw away wherever the
    // user had browsed to whenever a pane reopened or a crashed guest was
    // replaced.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.navigate(page.browserPageId, { kind: 'goto', url: 'http://localhost:5173/settings' })

    await registry.attachSurface(page.browserPageId, 2)

    expect(driver.sequence.at(-1)).toBe('goto:http://localhost:5173/settings')
  })

  test('the blank a guest is mounted at is never published as the page address', async () => {
    // WHY: it is scaffolding, not a navigation. Publishing it would put
    // about:blank in the toolbar of a page that is about to be somewhere else,
    // and announce a load state for a page that has not started loading.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    registry.reportSurface(page.browserPageId, {
      url: 'about:blank',
      title: '',
      loadState: 'ready',
      canGoBack: false,
      canGoForward: false,
    })

    expect(registry.get(page.browserPageId)?.url).toBe('http://localhost:5173/')
    expect(registry.get(page.browserPageId)?.loadState).not.toBe('ready')
  })

  test('the first frame subscriber starts the guest painting, and frames reach it', async () => {
    // WHY: this is the whole streamed surface. A client with no native surface
    // subscribes, the guest starts a screencast, and its frames reach exactly
    // that client.
    const { registry, driver, frames } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    const got: number[] = []
    frames.register('client-a', (header) => got.push(header.seq))
    await registry.subscribeFrames(page.browserPageId, 'client-a')

    expect(driver.screencasts).toHaveLength(1)
    driver.emitFrame(new Uint8Array([1]))
    driver.emitFrame(new Uint8Array([2]))

    expect(got).toEqual([1, 2])
  })

  test('a frame reaches only the clients watching that page', async () => {
    // WHY: a page nobody subscribed to must produce no frames for that client —
    // the "hidden panes stream nothing" rule, enforced at the source.
    const { registry, driver, frames } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    const watcher: number[] = []
    const bystander: number[] = []
    frames.register('watcher', (header) => watcher.push(header.seq))
    frames.register('bystander', (header) => bystander.push(header.seq))
    await registry.subscribeFrames(page.browserPageId, 'watcher')

    driver.emitFrame(new Uint8Array([1]))

    expect(watcher).toEqual([1])
    expect(bystander).toEqual([])
  })

  test('the last watcher leaving stops the guest painting', async () => {
    // WHY: a page returns to costing nothing the moment no pane shows it.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.subscribeFrames(page.browserPageId, 'a')
    await registry.subscribeFrames(page.browserPageId, 'b')
    await registry.unsubscribeFrames(page.browserPageId, 'a')
    expect(driver.screencastStops).toBe(0)

    await registry.unsubscribeFrames(page.browserPageId, 'b')
    expect(driver.screencastStops).toBe(1)
  })

  test('two mounted surfaces on one client keep separate stream references', async () => {
    // WHY: Editor and Pill mode can both mount the same page. Hiding one must
    // not stop the stream that the other visible surface still uses.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.subscribeFrames(page.browserPageId, 'same-client')
    await registry.subscribeFrames(page.browserPageId, 'same-client')
    await registry.unsubscribeFrames(page.browserPageId, 'same-client')
    expect(driver.screencastStops).toBe(0)

    await registry.unsubscribeFrames(page.browserPageId, 'same-client')
    expect(driver.screencastStops).toBe(1)
  })

  test('a disconnected client stops streaming without unsubscribing for itself', async () => {
    // WHY: a phone whose connection expired cannot unsubscribe. The transport
    // drops it, or a guest keeps painting frames into the void.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.subscribeFrames(page.browserPageId, 'phone')

    await registry.dropClient('phone')

    expect(driver.screencastStops).toBe(1)
  })

  test('resizing a watched page restarts its stream at the new caps', async () => {
    // WHY: the caps are derived from the viewport, so a resize that did not
    // restart the stream would leave a watcher receiving frames at the old size.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.subscribeFrames(page.browserPageId, 'a')

    await registry.setViewport(page.browserPageId, { mode: 'custom', width: 500, height: 900 })

    expect(driver.screencasts.length).toBeGreaterThan(1)
    expect(driver.screencasts.at(-1)).toEqual({ maxWidth: 500, maxHeight: 900, quality: 60 })
  })

  test('a coordinate click and scroll go straight to the guest', async () => {
    // WHY: a streamed surface maps a pointer to a viewport coordinate; those go
    // to the guest without resolving a selector, so light interaction works.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.interact(page.browserPageId, { kind: 'clickAt', x: 40, y: 60 })
    await registry.interact(page.browserPageId, { kind: 'scrollAt', x: 40, y: 60, deltaY: 120 })

    expect(driver.clicks).toEqual([{ x: 40, y: 60 }])
    expect(driver.scrolls).toEqual([{ x: 40, y: 60, deltaY: 120 }])
  })

  test('subscribing to frames fails loudly where nothing can host the page', async () => {
    // WHY: a page with no surface and no headless host cannot stream. Silence
    // would leave the client's canvas blank with no reason; the reason is the
    // point.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    await expect(registry.subscribeFrames(page.browserPageId, 'a')).rejects.toThrow(/no surface/i)
  })

  test('a capture is the picture and nothing else', async () => {
    // WHY: evidence is not a snapshot. Nobody reading a screenshot on a pull
    // request wants the accessibility tree, and walking the DOM for it would
    // make every capture pay for structure it never uses.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.sequence.length = 0

    const captured = await registry.capture(page.browserPageId)

    expect(captured.screenshot).toStartWith('data:image/png')
    expect(captured.page.url).toBe(TARGET.url)
    expect(driver.sequence).not.toContain('evaluate')
  })

  test('keeps every kind of mark the guest can make', async () => {
    // WHY: the registry validates what the guest reports, and the array parse
    // fails *whole* — so one tool the validator does not recognise discards
    // every other mark on the page along with it. Adding a tool to the contract
    // and not to the validator therefore reads to the user as annotations
    // silently not working at all. Both lists now come from one export, and a
    // box's selected element group crosses the parser too.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    driver.answers.set(
      '__solusBrowserAnnotations',
      JSON.stringify({
        annotations: BROWSER_MARK_TOOLS.map((tool, index) => ({
          id: `an${index}`,
          tool,
          rect: { x: index, y: index, width: 10, height: 10 },
          elements:
            tool === 'region'
              ? [
                  {
                    role: 'button',
                    label: 'Save',
                    rect: { x: 1, y: 1, width: 8, height: 8 },
                    ref: '[data-solus-browser-ref="a1"]',
                  },
                ]
              : undefined,
          createdAt: 1,
          number: index + 1,
        })),
      }),
    )

    const state = await registry.annotationState(page.browserPageId)
    expect(state.annotations.map((mark) => mark.tool)).toEqual([...BROWSER_MARK_TOOLS])
    expect(state.annotations.find((mark) => mark.tool === 'region')?.elements).toHaveLength(1)
    expect(state.annotations[0]?.number).toBe(1)
  })
})
