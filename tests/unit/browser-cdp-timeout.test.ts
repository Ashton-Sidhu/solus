import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * A hung `browser_snapshot` is the worst shape a failure can take here: the
 * agent waits forever, there is no error to react to and no line in the log, and
 * the user sees a turn that never ends.
 *
   * It happened for a specific reason. `Page.captureScreenshot` answers from the
   * compositor, and a background-throttled `<webview>` can stop swapping the
   * frame it needs. `Debugger.sendCommand` has no timeout of its own, so nothing
   * below it ever gave up. The first timeout fix exposed that Electron's
   * `capturePage` fallback waits on the same guest and stalls in the same state.
 *
 * Both halves of the fix are asserted against the source, because neither is
 * observable from the registry: the driver must not send a raw CDP command, and
 * the screenshot must have somewhere to fall back to.
 */
const driverSource = readFileSync(
  join(import.meta.dir, '../../apps/desktop/src/main/browser/chromium-driver.ts'),
  'utf8',
)

describe('CDP commands from the browser driver', () => {
  test('never reach the debugger without a timeout around them', () => {
    // Every `sendCommand` in the file — the one inside `send`, and the domain
    // enables in the static attach — must sit directly inside a `withTimeout`.
    // Anything else is a call that can hang, which is the whole defect.
    const all = driverSource.match(/[\w.]*cdp\.sendCommand\(/g) ?? []
    const wrapped = driverSource.match(/withTimeout\([\w.]*cdp\.sendCommand\(/g) ?? []

    expect(all.length).toBeGreaterThan(0)
    expect(wrapped.length).toBe(all.length)
  })

  test('the screenshot wakes the BrowserWindow only after the passive read fails', () => {
    const capture = driverSource.slice(driverSource.indexOf('async captureScreenshot()'))
    const body = capture.slice(0, capture.indexOf('\n  async ', 10))

    // The CDP path stays primary — it is the only one that honours the emulated
    // device pixel ratio, so a phone preset really comes back at 3x.
    expect(body).toContain('Page.captureScreenshot')
    expect(body).toContain('SCREENSHOT_TIMEOUT_MS')
    // The live failure reached `capturePage` after the CDP timeout and that call
    // timed out too. A screencast actively asks the compositor for a fresh frame
    // before the passive Electron reader gets its last chance.
    expect(body).toContain('captureScreencastFrame()')
    expect(body).toContain('capturePage()')
    expect(body).toContain('getBackgroundThrottling()')
    expect(body).toContain('setBackgroundThrottling(false)')
    expect(body).toContain('requestAnimationFrame')
    expect(body).toContain('finally')
    expect(body).toContain('setBackgroundThrottling(true)')

    // WHY: toggling one webview's background throttling makes Electron draw the
    // whole BrowserWindow. Annotation comments capture a page that just painted,
    // so waking first made both the browser and conversation appear to refresh.
    expect(body.indexOf('Page.captureScreenshot')).toBeLessThan(
      body.indexOf('getBackgroundThrottling()'),
    )
    expect(body.indexOf('Page.captureScreenshot')).toBeLessThan(
      body.indexOf('setBackgroundThrottling(false)'),
    )
  })

  test('uses the fast PNG encoder so a visible capture does not hold a frame', () => {
    const capture = driverSource.slice(driverSource.indexOf('async captureScreenshot()'))
    const body = capture.slice(0, capture.indexOf('\n  async ', 10))

    expect(body).toContain("format: 'png'")
    expect(body).toContain('optimizeForSpeed: true')
  })

  test('captures a webview view without swapping its visible device surface', () => {
    const capture = driverSource.slice(driverSource.indexOf('async captureScreenshot()'))
    const body = capture.slice(0, capture.indexOf('\n  async ', 10))

    // WHY: surface capture on an emulated native webview can visibly replace
    // the fitted page with its device-sized surface, then restore it.
    expect(body).toContain("fromSurface: this.kind !== 'webview'")
  })

  test('the webview fallback requests one frame and releases its subscription', () => {
    // WHY: both passive screenshot APIs timed out while Runtime evaluation was
    // healthy. The fallback must create compositor demand, but it must not leave
    // a continuously repainting screencast or an event listener behind.
    const capture = driverSource.slice(driverSource.indexOf('private async captureScreencastFrame()'))
    const body = capture.slice(0, capture.indexOf('\n  async ', 10))

    expect(body).toContain('Page.startScreencast')
    expect(body).toContain('Page.screencastFrame')
    expect(body).toContain('Page.screencastFrameAck')
    expect(body).toContain("this.cdp.off('message', onFrame)")
    expect(body).toContain('Page.stopScreencast')
    expect(body).toContain('finally')
  })

  test('waits less for a screenshot than for a command it cannot retry', () => {
    // WHY: the screenshot has somewhere to go when it gives up, so making the
    // user wait the full command timeout for it would be a choice to be slow.
    const screenshot = /SCREENSHOT_TIMEOUT_MS = ([\d_]+)/.exec(driverSource)?.[1]
    const command = /CDP_TIMEOUT_MS = ([\d_]+)/.exec(driverSource)?.[1]
    expect(Number(screenshot?.replace(/_/g, ''))).toBeLessThan(Number(command?.replace(/_/g, '')))
  })
})

/**
 * A verb that fails tells the agent something. A verb that hangs tells it
 * nothing: no error, no event, no line in the transcript — the turn just stops,
 * and the only way to find out where is to read the logs by hand. That happened
 * three times on `browser_snapshot`, each time for a different stalled step, so
 * the guarantee belongs at the verb rather than at whichever step is at fault.
 */
const toolsSource = readFileSync(
  join(import.meta.dir, '../../packages/server/src/browser/browser-tools.ts'),
  'utf8',
)

describe('browser verbs', () => {
  test('answer within a deadline rather than hanging the agent', () => {
    // The race lives in `browserTool`, so it covers every verb declared with it
    // — including ones added later, which is the point of putting it there.
    const factory = toolsSource.slice(toolsSource.indexOf('function browserTool'))
    const body = factory.slice(0, factory.indexOf('\nexport const'))

    expect(body).toContain('Promise.race')
    expect(body).toContain('deadlineMs')
    // The message has to name the verb, or a hung turn still says nothing useful.
    expect(body).toContain('spec.name')
  })

  test('let the waiting verb outlast the backstop meant for the others', () => {
    // WHY: `browser_wait_for` is allowed to be slow — waiting is its job. A
    // shared deadline that cut it short would turn a working verb into a flake.
    const wait = Number(/WAIT_DEADLINE_MS = ([\d_]+)/.exec(toolsSource)?.[1].replace(/_/g, ''))
    const verb = Number(/VERB_DEADLINE_MS = ([\d_]+)/.exec(toolsSource)?.[1].replace(/_/g, ''))
    expect(wait).toBeGreaterThan(verb)
    expect(toolsSource).toContain('deadlineMs: WAIT_DEADLINE_MS')
  })
})

/**
 * The stage log is the diagnosis. A stalled snapshot emits no error, so the last
 * `browser_snapshot_stage` line is the only record of how far it got.
 */
describe('the snapshot stage log', () => {
  const registrySource = readFileSync(
    join(import.meta.dir, '../../packages/server/src/browser/browser-registry.ts'),
    'utf8',
  )

  test('marks every step a snapshot can stall on', () => {
    const snapshot = registrySource.slice(registrySource.indexOf('async snapshot('))
    const body = snapshot.slice(0, snapshot.indexOf('\n  async '))

    for (const step of ['hosted', 'structure', 'screenshot']) {
      expect(body).toContain(`stage('${step}'`)
    }
  })

  test('covers the asset write, which happens after the registry is done', () => {
    // WHY: the write is the last thing a snapshot does. Without a line for it, a
    // stall in the asset store is indistinguishable from a stall in the capture
    // — the two would have produced the same silence.
    expect(toolsSource).toContain("stage: 'asset'")
  })

  test('records how long each step took, not just that it happened', () => {
    // WHY: "slow" and "stalled" look identical without a duration, and the
    // difference decides whether to tune something or fix something.
    const timer = registrySource.slice(registrySource.indexOf('function stageTimer'))
    expect(timer.slice(0, 400)).toContain('ms: now - last')
  })
})

/**
 * A visual QA tool whose output only the agent can see is half a feature — tool
 * output never reaches a client, so the capture would exist only in the agent's
 * context. The conversation card is what closes that, and it is fed by an event
 * carrying the asset id rather than by the agent remembering to paste a link:
 * whether the user sees their own screenshot must not depend on the model.
 */
describe('what a snapshot hands back', () => {
  test('publishes the capture to the conversation, not just to the agent', () => {
    expect(toolsSource).toContain("type: 'browser_snapshot_captured'")
    expect(toolsSource).toContain('assetId,')
  })

  test('publishes only when there is a capture to show', () => {
    // WHY: `screenshot: false` is a legitimate structure-only call. Emitting a
    // card for it would put an empty frame in the transcript.
    expect(toolsSource).toContain('if (assetId) {')
  })

  test('still gives the agent a path it can read as an image', () => {
    // WHY: the two readers need different things. Dropping either one costs
    // either the agent's own look at the page or the user's.
    expect(toolsSource).toContain("join(dataDir(), 'assets', stored.id)")
  })
})
