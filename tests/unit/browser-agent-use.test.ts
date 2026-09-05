import { afterEach, describe, expect, test } from 'bun:test'
import { initBrowserRegistry, type BrowserEventSink } from '@solus/server/browser/browser-registry'
import {
  setBrowserHeadlessHost,
  setBrowserWebviewHost,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import {
  BROWSER_AGENT_USE_GRACE_MS,
  isBrowserPageInAgentUse,
  type BrowserConsoleEntry,
  type BrowserNavigateOp,
  type BrowserNetworkEntry,
  type BrowserPage,
} from '@solus/contracts/browser-types'

/**
 * Closing a browser page an agent is working in.
 *
 * A page outlives the pane showing it — that is the whole point of its state
 * being server-owned — so a user closing a chip can end a verb that is running
 * on another machine. These tests encode the two halves of the answer: what
 * counts as use (and, just as importantly, what stops counting), and where the
 * decision is made.
 */

class FakeDriver implements BrowserSurfaceDriver {
  readonly kind = 'webview' as const
  disposed = false
  async applyEmulation(_emulation: BrowserEmulation): Promise<void> {}
  async navigate(_op: BrowserNavigateOp): Promise<void> {}
  async captureScreenshot(): Promise<string> {
    return 'data:image/png;base64,AAAA'
  }
  async startScreencast(_options: BrowserScreencastOptions, _onFrame: BrowserFrameListener): Promise<void> {}
  async stopScreencast(): Promise<void> {}
  async evaluate(): Promise<string> {
    return 'null'
  }
  async clickAt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}
  async openDevTools(): Promise<void> {}
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

function harness() {
  const published: BrowserPage[] = []
  const closed: string[] = []
  const sink: BrowserEventSink = {
    pageChanged: (page) => published.push(structuredClone(page)),
    pageClosed: (browserPageId) => closed.push(browserPageId),
    surfaceRequested: () => {},
  }
  const driver = new FakeDriver()
  setBrowserWebviewHost({ attach: async () => driver })
  return { registry: initBrowserRegistry(sink), driver, published, closed }
}

afterEach(() => {
  setBrowserWebviewHost(null)
  setBrowserHeadlessHost(null)
})

const TARGET = { kind: 'url', url: 'http://localhost:5173/' } as const

describe('what counts as an agent using a browser page', () => {
  test('a page nobody has driven closes without a question', async () => {
    // WHY: the warning has to be rare enough to mean something. A page the user
    // opened and looked at is the ordinary case, and it must not be gated.
    const { registry, closed } = harness()
    const page = registry.open({ target: TARGET })

    expect(page.agentUse).toBeUndefined()
    expect(await registry.close(page.browserPageId)).toEqual({ closed: true })
    expect(closed).toEqual([page.browserPageId])
  })

  test('a verb in flight names itself on the page, and refuses the close', async () => {
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    const release = registry.beginAgentUse(page.browserPageId, 'browser_click', 'session_7')
    const refused = await registry.close(page.browserPageId)

    expect(refused).toEqual({
      closed: false,
      reason: 'agent-use',
      agentUse: { running: 1, verb: 'browser_click', sessionId: 'session_7', at: expect.any(Number) },
    })
    // The page is still there to be driven: a refusal is an answer, not a close
    // that half happened.
    expect(registry.get(page.browserPageId)).not.toBeNull()
    release()
  })

  test('opening a page is use, because a page created a second ago is live work', async () => {
    // WHY: an agent that has opened a page but not yet snapshotted it has no verb
    // in flight, and closing it there is still an interruption.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    registry.noteAgentUse(page.browserPageId, 'browser_open', 'session_7')

    const refused = await registry.close(page.browserPageId)
    expect(refused.closed).toBe(false)
  })

  test('use decays, so a page an agent finished with hours ago is not busy forever', async () => {
    // WHY: "an agent opened this" never expires. A page marked on that basis
    // would be permanently unclosable without a prompt, and by the third warning
    // the user would be dismissing it without reading.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    registry.beginAgentUse(page.browserPageId, 'browser_snapshot')()

    const live = registry.get(page.browserPageId)
    expect(live?.agentUse).toBeDefined()
    expect(isBrowserPageInAgentUse(live!)).toBe(true)

    // Wind the last activity past the grace window the contract declares. Both
    // sides read that one number, so the badge and the refusal cannot disagree.
    live!.agentUse!.at = Date.now() - BROWSER_AGENT_USE_GRACE_MS - 1
    expect(isBrowserPageInAgentUse(live!)).toBe(false)

    expect(await registry.close(page.browserPageId)).toEqual({ closed: true })
  })

  test('a hold survives its verb throwing only until the caller releases it', async () => {
    // WHY: every verb releases in a `finally`. If a thrown verb could strand its
    // hold, one failed snapshot would make the page unclosable for the session.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    const release = registry.beginAgentUse(page.browserPageId, 'browser_snapshot')
    expect((await registry.close(page.browserPageId)).closed).toBe(false)

    release()
    const live = registry.get(page.browserPageId)
    expect(live?.agentUse?.running).toBe(0)
  })

  test('releasing twice releases one hold, so a finally beside an explicit release is safe', async () => {
    const { registry } = harness()
    const page = registry.open({ target: TARGET })

    const first = registry.beginAgentUse(page.browserPageId, 'browser_click')
    const second = registry.beginAgentUse(page.browserPageId, 'browser_type')
    expect(registry.get(page.browserPageId)?.agentUse?.running).toBe(2)

    first()
    first()
    expect(registry.get(page.browserPageId)?.agentUse?.running).toBe(1)
    second()
    expect(registry.get(page.browserPageId)?.agentUse?.running).toBe(0)
  })

  test('releasing a hold on a page that was force-closed under it does nothing', async () => {
    // WHY: the user answered "close anyway" while a verb was running. The verb
    // still runs its `finally`, and it must not resurrect state for a page that
    // no longer exists.
    const { registry, closed } = harness()
    const page = registry.open({ target: TARGET })

    const release = registry.beginAgentUse(page.browserPageId, 'browser_wait_for')
    await registry.close(page.browserPageId, { force: true })
    expect(closed).toEqual([page.browserPageId])

    expect(() => release()).not.toThrow()
    expect(registry.get(page.browserPageId)).toBeNull()
  })
})

describe('the host decides, not the client', () => {
  test('a confirmed close goes through while the verb is still running', async () => {
    // WHY: the refusal is a question, and the user is allowed to answer it. A
    // guard with no way past it is a page that can never be closed.
    const { registry, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    registry.beginAgentUse(page.browserPageId, 'browser_snapshot')

    expect(await registry.close(page.browserPageId, { force: true })).toEqual({ closed: true })
    expect(driver.disposed).toBe(true)
  })

  test('the refusal carries a copy, so the answer describes the moment it was asked', async () => {
    // WHY: the client holds this across a round trip and a user reading a dialog.
    // Handing out the live object would let the sentence change under them as the
    // agent kept working.
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    registry.beginAgentUse(page.browserPageId, 'browser_click')

    const refused = await registry.close(page.browserPageId)
    if (refused.closed) throw new Error('expected the close to be refused')
    registry.beginAgentUse(page.browserPageId, 'browser_type')

    expect(refused.agentUse.verb).toBe('browser_click')
    expect(refused.agentUse.running).toBe(1)
  })

  test('closing a page that is already gone answers closed rather than asking about it', async () => {
    const { registry } = harness()
    const page = registry.open({ target: TARGET })
    await registry.close(page.browserPageId)

    expect(await registry.close(page.browserPageId)).toEqual({ closed: true })
  })

  test('every change to agent use reaches the clients that mirror the page', async () => {
    // WHY: the chip that says "an agent is using this" is drawn from published
    // page state. State that changed without an event would leave the badge on a
    // page nothing is doing, or absent from one that is busy.
    const { registry, published } = harness()
    const page = registry.open({ target: TARGET })
    const before = published.length

    const release = registry.beginAgentUse(page.browserPageId, 'browser_click')
    expect(published.at(-1)?.agentUse?.running).toBe(1)
    release()
    expect(published.at(-1)?.agentUse?.running).toBe(0)
    expect(published.length).toBeGreaterThan(before + 1)
  })
})
