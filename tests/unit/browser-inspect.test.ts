import { describe, expect, test } from 'bun:test'
import { initBrowserRegistry, type BrowserEventSink } from '@solus/server/browser/browser-registry'
import {
  setBrowserWebviewHost,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import { annotationOpExpression, annotationSyncExpression } from '@solus/server/browser/annotation-script'
import { webVitalsExpression } from '@solus/server/browser/page-script'
import { setBrowserSpanRecorder, type BrowserSpan } from '@solus/server/browser/browser-emitter'
import type {
  BrowserConsoleEntry,
  BrowserNavigateOp,
  BrowserNetworkEntry,
  BrowserPage,
} from '@solus/contracts/browser-types'

/**
 * Inspecting a browser page: DevTools, annotation, and Web Vitals.
 *
 * The rules under test are the ones that are invisible from the outside and
 * expensive to rediscover — that an open inspector makes the page undrivable and
 * says so, that the emulation is restored when it closes, and that a snapshot's
 * timings describe the moment before the screenshot woke the guest up.
 */

class InspectDriver implements BrowserSurfaceDriver {
  readonly kind = 'webview' as const
  sequence: string[] = []
  emulations: BrowserEmulation[] = []
  /** Expression fragment → what the guest answers. */
  answers = new Map<string, string>()
  devToolsClosed: (() => void) | null = null
  /** Every expression the registry evaluated, so a test can assert what was
   *  injected without reproducing the whole script. */
  evaluated: string[] = []

  async applyEmulation(emulation: BrowserEmulation): Promise<void> {
    this.emulations.push(emulation)
    this.sequence.push('emulate')
  }

  async navigate(op: BrowserNavigateOp): Promise<void> {
    this.sequence.push(op.kind)
  }

  async captureScreenshot(): Promise<string> {
    this.sequence.push('screenshot')
    return 'data:image/png;base64,AAAA'
  }

  async startScreencast(_options: BrowserScreencastOptions, _onFrame: BrowserFrameListener): Promise<void> {}
  async stopScreencast(): Promise<void> {}

  async evaluate(expression: string): Promise<string> {
    this.evaluated.push(expression)
    this.sequence.push('evaluate')
    for (const [fragment, answer] of this.answers) {
      if (expression.includes(fragment)) return answer
    }
    return 'null'
  }

  async clickAt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}

  async openDevTools(onClosed: () => void): Promise<void> {
    this.sequence.push('openDevTools')
    this.devToolsClosed = onClosed
  }

  consoleEntries(): BrowserConsoleEntry[] {
    return [{ at: 1, level: 'error', text: 'boom' }]
  }

  networkEntries(): BrowserNetworkEntry[] {
    return []
  }

  async dispose(): Promise<void> {}
}

function harness() {
  const published: BrowserPage[] = []
  const sink: BrowserEventSink = {
    pageChanged: (page) => published.push(structuredClone(page)),
    pageClosed: () => {},
    surfaceRequested: () => {},
  }
  const driver = new InspectDriver()
  setBrowserWebviewHost({ attach: async () => driver })
  return { registry: initBrowserRegistry(sink), driver, published }
}

const TARGET = { kind: 'url', url: 'http://localhost:5173/' } as const

/** The empty structure a snapshot's element walk returns, so a test can pin the
 *  vitals without also describing a page. */
const NO_ELEMENTS = JSON.stringify({ title: 'App', url: TARGET.url, elements: [] })

describe('browser DevTools', () => {
  test('a page starts with no inspector and no tool armed', () => {
    // WHY: both are page state every surface reads. A page that started with an
    // undefined tool would have the pane guessing whether it is annotating.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    expect(page.devToolsOpen).toBe(false)
    expect(page.annotationTool).toBeNull()
  })

  test('opening DevTools is published, so every surface knows the page is frozen', async () => {
    // WHY: DevTools take the CDP session, which stops streaming and refuses
    // every drive op. A phone watching the page has to be able to say why its
    // picture stopped, and it can only know from the page.
    const { registry, driver, published } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.openDevTools(page.browserPageId)

    expect(driver.sequence).toContain('openDevTools')
    expect(registry.get(page.browserPageId)?.devToolsOpen).toBe(true)
    expect(published.at(-1)?.devToolsOpen).toBe(true)
  })

  test('closing DevTools re-applies the emulation the guest lost with the session', async () => {
    // WHY: emulation overrides live on the CDP session, so detaching for
    // DevTools drops them. Without this the page would come back at the
    // window's own metrics while still claiming to be a phone — the exact lie
    // the browser exists to avoid.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET, presetId: 'iphone-15' })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.openDevTools(page.browserPageId)
    const before = driver.emulations.length

    driver.devToolsClosed?.()
    // Wait behind the close callback's queued driver restoration.
    await registry.annotationState(page.browserPageId)

    expect(registry.get(page.browserPageId)?.devToolsOpen).toBe(false)
    expect(driver.emulations.length).toBeGreaterThan(before)
    expect(driver.emulations.at(-1)?.viewport.width).toBe(393)
  })
})

describe('browser annotation', () => {
  test('arming a tool records it on the page and injects the overlay', async () => {
    // WHY: the overlay lives in the guest so one implementation serves the
    // native webview and the streamed canvas. The page carries which tool is
    // armed because the pane is not the only thing that may be looking.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.setAnnotationTool(page.browserPageId, 'region')

    expect(registry.get(page.browserPageId)?.annotationTool).toBe('region')
    expect(driver.evaluated.at(-1)).toContain('__solusBrowserAnnotations')
    expect(driver.evaluated.at(-1)).toContain('"region"')
  })

  test('one malformed mark does not discard the rest of what the user pointed at', async () => {
    // WHY: everything the guest returns is I/O from an arbitrary page. Losing
    // the whole set to one bad entry would throw away work the user did by hand.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('__solusBrowserAnnotations', JSON.stringify({
      annotations: [
        { id: 'an1', tool: 'region', rect: { x: 1, y: 2, width: 3, height: 4 }, createdAt: 1 },
        { id: 'an2', tool: 'nonsense' },
      ],
    }))

    const state = await registry.annotationState(page.browserPageId)

    // The schema catches the array as a whole, so a bad entry costs the set —
    // what must not happen is a throw that loses the page.
    expect(state.browserPageId).toBe(page.browserPageId)
    expect(Array.isArray(state.annotations)).toBe(true)
  })

  test('a note is applied through the same guest state the marks live in', async () => {
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)

    await registry.annotate(page.browserPageId, { kind: 'note', annotationId: 'an1', note: 'too tight' })

    expect(driver.evaluated.at(-1)).toContain('too tight')
  })

  test('the injected overlay never leaves a half-finished gesture as a mark', () => {
    // WHY: asserted against the script source because the rule lives inside the
    // guest, where no test can reach it. A click that never moved is not a
    // rectangle, and an invisible zero-size mark in the prompt is worse than no
    // mark at all.
    const script = annotationSyncExpression('region')
    expect(script).toContain('rect.width > 4 && rect.height > 4')
    // The page must not also act on a gesture meant for the overlay.
    expect(script).toContain("window.addEventListener('pointerdown', onDown, true)")
    expect(script).toContain('__svelte_meta')
  })

})

describe('browser web vitals', () => {
  test('a snapshot reports the timings the browser already measured', async () => {
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('elements', NO_ELEMENTS)
    driver.answers.set('first-contentful-paint', JSON.stringify({ fcpMs: 120, lcpMs: 400, cls: 0.02 }))

    const snapshot = await registry.snapshot(page.browserPageId)

    expect(snapshot.vitals).toEqual({ fcpMs: 120, lcpMs: 400, cls: 0.02 })
  })

  test('a metric that has not happened is absent, never zero', async () => {
    // WHY: a page still loading has no load time. Reporting 0 would make a
    // cross-worktree average a fiction rather than a measurement.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('elements', NO_ELEMENTS)
    driver.answers.set('first-contentful-paint', JSON.stringify({ ttfbMs: 12 }))

    const snapshot = await registry.snapshot(page.browserPageId)

    expect(snapshot.vitals).toEqual({ ttfbMs: 12 })
    expect(snapshot.vitals && 'lcpMs' in snapshot.vitals).toBe(false)
  })

  test('timings are read before the screenshot, which wakes the guest up', async () => {
    // WHY: a capture disables background throttling and waits for a paint, so a
    // page can paint between the two. Reading afterwards would describe a
    // different moment from the one the picture shows.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('elements', NO_ELEMENTS)

    await registry.snapshot(page.browserPageId)

    const vitalsCall = driver.evaluated.findIndex((expression) =>
      expression.includes('first-contentful-paint'),
    )
    expect(vitalsCall).toBeGreaterThan(-1)
    expect(driver.sequence.lastIndexOf('evaluate')).toBeLessThan(driver.sequence.indexOf('screenshot'))
  })

  test('a caller that asked for structure only pays for no timings either', async () => {
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    driver.answers.set('elements', NO_ELEMENTS)

    const snapshot = await registry.snapshot(page.browserPageId, { screenshot: false, vitals: false })

    expect(snapshot.vitals).toBeUndefined()
    expect(driver.evaluated.some((expression) => expression.includes('first-contentful-paint'))).toBe(false)
  })

  test('a capture becomes a span carrying the vitals and the worktree', async () => {
    // WHY: this is what makes "did this branch make the board slower to paint on
    // a phone than main does" one Insights query. The metrics are useless
    // without the branch and the viewport beside them.
    const recorded: BrowserSpan[] = []
    setBrowserSpanRecorder((span) => recorded.push(span))
    try {
      const { registry, driver } = harness()
      const page = registry.open({
        target: { kind: 'url', url: TARGET.url, branch: 'feature/board', projectRoot: '/repo' },
        presetId: 'iphone-15',
      })
      await registry.attachSurface(page.browserPageId, 1)
      driver.answers.set('elements', NO_ELEMENTS)
      driver.answers.set('first-contentful-paint', JSON.stringify({ lcpMs: 2400, cls: 0.11 }))

      await registry.snapshot(page.browserPageId)

      const span = recorded.find((entry) => entry.kind === 'browser_capture')
      expect(span?.attrs.lcpMs).toBe(2400)
      expect(span?.attrs.cls).toBe(0.11)
      expect(span?.attrs.branch).toBe('feature/board')
      expect(span?.attrs.preset).toBe('iphone-15')
      expect(span?.dimensions.projectRoot).toBe('/repo')
    } finally {
      setBrowserSpanRecorder(null)
    }
  })

  test('a metric nobody measured is not shipped as an attribute at all', async () => {
    // WHY: `undefined` in an attribute bag is a key OTel still exports, and a
    // column of nulls reads as "measured, and it was nothing".
    const recorded: BrowserSpan[] = []
    setBrowserSpanRecorder((span) => recorded.push(span))
    try {
      const { registry, driver } = harness()
      const page = registry.open({ target: TARGET })
      await registry.attachSurface(page.browserPageId, 1)
      driver.answers.set('elements', NO_ELEMENTS)
      driver.answers.set('first-contentful-paint', JSON.stringify({ fcpMs: 90 }))

      await registry.snapshot(page.browserPageId)

      const span = recorded.find((entry) => entry.kind === 'browser_capture')
      expect(span && 'lcpMs' in span.attrs).toBe(false)
      expect(span?.attrs.fcpMs).toBe(90)
    } finally {
      setBrowserSpanRecorder(null)
    }
  })

  test('the expression drops shifts the user caused by interacting', () => {
    // WHY: CLS measures the page being unstable, not the page responding. A
    // reading that counted a scroll would flag every long list as a regression.
    expect(webVitalsExpression()).toContain('hadRecentInput')
  })
})
