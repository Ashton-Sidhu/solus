import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  defaultViewport,
  BROWSER_BLANK_URL,
  BROWSER_MARK_TOOLS,
  BROWSER_FRAME_MAX_DIMENSION,
  BROWSER_FRAME_QUALITY,
  BROWSER_DEFAULT_PROFILE_ID,
  BROWSER_RING_LIMIT,
  isBrowserProfileId,
  presetById,
  browserProfilePartition,
  resolveViewport,
  viewportFor,
  type BrowserAgentUse,
  type BrowserAnnotateOp,
  type BrowserAnnotationState,
  type BrowserAnnotationTool,
  type BrowserAppearance,
  type BrowserCloseResult,
  type BrowserDetachReason,
  type BrowserInteractOp,
  type BrowserInteractResult,
  type BrowserNavigateOp,
  type BrowserOpenRequest,
  type BrowserPage,
  type BrowserProblem,
  type BrowserSnapshot,
  type BrowserSnapshotOptions,
  type BrowserSurfaceReport,
  type BrowserViewport,
  type BrowserViewportRequest,
} from '@solus/contracts/browser-types'
import { createLogger } from '../logger'
import { annotationOpExpression, annotationSyncExpression } from './annotation-script'
import {
  clearFieldExpression,
  elementRectExpression,
  elementSnapshotExpression,
  guardedExpression,
  webVitalsExpression,
} from './page-script'
import { emitBrowserCapture, emitBrowserLoad, type BrowserCaptureSpanInput } from './browser-emitter'
import {
  browserHeadlessHost,
  browserProfileHost,
  browserWebviewHost,
  type BrowserEmulation,
  type BrowserHeadlessHost,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from './surface-driver'
import type { BrowserFrameChannel } from './browser-frame-channel'

const log = createLogger('browser', 'browser-registry.ts')

/** How often an unreachable target is re-probed before the pane offers to
 *  reload. Slow enough to be free, fast enough that a restarted dev server
 *  comes back on its own. */
const LIVENESS_INTERVAL_MS = 3000
const DEFAULT_MAX_ELEMENTS = 120

/** Only reachable where no headless host is registered — everywhere else an
 *  unhosted page is waiting for a need, not for a pane. */
const NO_SURFACE: BrowserProblem = {
  kind: 'no-surface',
  message: 'Waiting for a browser pane to render this page.',
}

const WAIT_POLL_MS = 200
const DEFAULT_WAIT_TIMEOUT_MS = 5000

/** How long after an agent's last verb a page still counts as in use. A turn
 *  is verbs with model round trips between them, and `running` is zero for most
 *  of that wall clock (ADR 0024). Host-only: clients read presence, not time. */
const AGENT_USE_GRACE_MS = 45_000

interface PageRecord {
  page: BrowserPage
  driver: BrowserSurfaceDriver | null
  /** Driver work is ordered per page. A headless open, a native handover, and
   *  a command must not replace or dispose the surface another one is using. */
  driverQueue: Promise<void>
  closing: boolean
  livenessTimer: NodeJS.Timeout | null
  /** When the current load began, so the time it took is a logged fact rather
   *  than something the next "it feels slow" has to reconstruct from RPC
   *  timestamps. Null between loads. */
  loadStartedAt: number | null
}

export interface BrowserEventSink {
  pageChanged(page: BrowserPage): void
  pageClosed(browserPageId: string): void
  surfaceRequested(browserPageId: string): void
}

/**
 * The server-authoritative browser registry.
 *
 * A page's state lives here, not in whichever client happens to be looking, so
 * an agent addresses the same page the user sees and keeps addressing it after
 * the user closes the pane. What a client owns is the surface: it hands one
 * over with `attachSurface` and takes it back with `detachSurface`, and the
 * page survives both.
 *
 * Which backend renders a page is decided here, not asked for. A desktop pane
 * showing the page hosts it natively; otherwise the headless host renders it on
 * demand, so an agent can drive a page nobody is looking at. Migration between
 * the two reloads at the same URL — the design's own admission that in-page
 * state does not cross — which is why a page is only hosted headless once
 * something actually needs it.
 */
export class BrowserRegistry {
  private records = new Map<string, PageRecord>()
  /** Which clients are watching each page's stream. Empty or absent means the
   *  page produces no frames — the "hidden panes stream nothing" rule lives
   *  here, at the source, not in a filter on the wire. */
  private frameWatchers = new Map<string, Map<string, number>>()
  /** A second subscriber that arrives during a slow first open waits for the
   *  same startup result instead of returning before a stream exists. */
  private streamStarts = new Map<string, Promise<void>>()
  /** The per-page frame counter, so a client can drop a frame that decoded
   *  slower than its successor. */
  private frameSeq = new Map<string, number>()
  /** One pending announcement per page that an agent has stopped using it.
   *  Held so a close, a shutdown, or a fresh verb cancels the old one rather
   *  than letting a stale timer clear a use that started since. */
  private agentUseTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly events: BrowserEventSink,
    /** Absent on a host that cannot stream (or in a test that does not exercise
     *  it): frame subscription then fails loudly rather than silently doing
     *  nothing, the same way a drive op against no surface does. */
    private readonly frames: BrowserFrameChannel | null = null,
  ) {}

  list(): BrowserPage[] {
    return [...this.records.values()].map((record) => record.page)
  }

  get(browserPageId: string): BrowserPage | null {
    return this.records.get(browserPageId)?.page ?? null
  }

  open(request: BrowserOpenRequest): BrowserPage {
    // A page opens at the size of the pane. A preset is only ever chosen
    // deliberately — by the caller here, or by the user later — and once chosen
    // it stays until somebody chooses again.
    const preset = request.presetId ? presetById(request.presetId) : undefined
    if (request.presetId && !preset) throw new Error(`Unknown device preset: ${request.presetId}`)
    // Fixed once, here: both hosts mint the partition from it. Which profile a
    // caller *meant* is the profile store's question, answered before this point
    // — the registry owns pages, not the durable list of identities.
    const profileId = request.profileId ?? BROWSER_DEFAULT_PROFILE_ID
    if (!isBrowserProfileId(profileId)) throw new Error(`Not a browser profile id: ${profileId}`)
    const page: BrowserPage = {
      browserPageId: `browser_${randomUUID()}`,
      target: request.target,
      url: request.target.kind === 'url' ? request.target.url : '',
      title: '',
      viewport: preset ? viewportFor(preset, request.orientation ?? 'portrait') : defaultViewport(),
      appearance: request.appearance ?? 'system',
      profileId,
      hostKind: 'none',
      loadState: 'idle',
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
      annotationTool: null,
      label: request.label ?? labelFor(request),
      createdAt: Date.now(),
    }
    // A page nothing is rendering is only a *problem* where nothing can render
    // it. Where the headless host exists, an unhosted page is merely waiting for
    // someone to need it.
    if (!browserHeadlessHost()) page.problem = { ...NO_SURFACE }
    this.records.set(page.browserPageId, {
      page,
      driver: null,
      driverQueue: Promise.resolve(),
      closing: false,
      livenessTimer: null,
      loadStartedAt: null,
    })
    this.events.pageChanged(page)
    if (request.requestSurface) this.events.surfaceRequested(page.browserPageId)
    log.info('browser_page_opened', {
      browserPageId: page.browserPageId,
      targetKind: page.target.kind,
      profileId: page.profileId,
    })
    return page
  }

  /**
   * Close a page, unless an agent is working in it.
   *
   * The guard lives here because only the host can answer at the moment of the
   * close: a client's copy of `agentUse` is at least one event old (ADR 0024).
   * `force` is the answer to the question the refusal asked.
   */
  async close(browserPageId: string, options: { force?: boolean } = {}): Promise<BrowserCloseResult> {
    const record = this.records.get(browserPageId)
    // Already gone, or already going, is closed as far as the caller is concerned.
    if (!record || record.closing) return { closed: true }
    const use = record.page.agentUse
    if (use && !options.force && this.isInAgentUse(use)) {
      // Copied: the caller holds this across a round trip while the live one
      // keeps moving as the agent works.
      return { closed: false, reason: 'agent-use', agentUse: { ...use } }
    }
    record.closing = true
    this.stopLiveness(record)
    this.stopAgentUseExpiry(browserPageId)
    this.frameWatchers.delete(browserPageId)
    this.streamStarts.delete(browserPageId)
    this.frameSeq.delete(browserPageId)
    await this.queueDriver(record, async () => {
      await record.driver?.dispose().catch(() => {})
      record.driver = null
    })
    if (this.records.get(browserPageId) !== record) return { closed: true }
    this.records.delete(browserPageId)
    this.events.pageClosed(browserPageId)
    log.info('browser_page_closed', { browserPageId, forced: options.force === true })
    return { closed: true }
  }

  /**
   * Bracket one agent verb against a page.
   *
   * Returns the release rather than taking a callback, so every caller releases
   * in a `finally`: a verb that threw or timed out must not leave the page
   * unclosable. Releasing twice releases one hold.
   *
   * Clients only render whether `agentUse` is present, so the page is published
   * when use begins and when it lapses — not on every verb boundary, which for a
   * busy turn would be two broadcasts per click.
   */
  beginAgentUse(browserPageId: string, verb: string, sessionId?: string): () => void {
    const record = this.records.get(browserPageId)
    // A page already going away cannot be held open; the verb will fail on its own.
    if (!record || record.closing) return () => {}
    const use = this.touchAgentUse(record, verb, sessionId)
    use.running += 1
    this.stopAgentUseExpiry(browserPageId)
    let released = false
    return () => {
      if (released) return
      released = true
      // The page may have been force-closed under the verb. Nothing to release.
      const current = this.records.get(browserPageId)
      const active = current?.page.agentUse
      if (!current || !active) return
      active.running = Math.max(0, active.running - 1)
      active.at = Date.now()
      if (active.running === 0) this.scheduleAgentUseExpiry(current)
    }
  }

  /** Record that an agent touched a page without holding it — `browser_open`.
   *  A page created two seconds ago is one to ask about; it decays like any
   *  other use. */
  noteAgentUse(browserPageId: string, verb: string, sessionId?: string): void {
    const record = this.records.get(browserPageId)
    if (!record || record.closing) return
    this.touchAgentUse(record, verb, sessionId)
    this.scheduleAgentUseExpiry(record)
  }

  private touchAgentUse(record: PageRecord, verb: string, sessionId: string | undefined): BrowserAgentUse {
    const existing = record.page.agentUse
    const use = existing ?? { running: 0, verb, at: 0 }
    use.verb = verb
    use.at = Date.now()
    if (sessionId) use.sessionId = sessionId
    record.page.agentUse = use
    if (!existing) this.publish(record)
    return use
  }

  private isInAgentUse(use: BrowserAgentUse): boolean {
    return use.running > 0 || Date.now() - use.at < AGENT_USE_GRACE_MS
  }

  /** Publish the moment the grace window lapses, so a pane does not keep
   *  warning about an agent that finished minutes ago. */
  private scheduleAgentUseExpiry(record: PageRecord): void {
    const { browserPageId } = record.page
    this.stopAgentUseExpiry(browserPageId)
    const timer = setTimeout(() => {
      this.agentUseTimers.delete(browserPageId)
      const current = this.records.get(browserPageId)
      if (!current || current.closing) return
      if (!current.page.agentUse || current.page.agentUse.running > 0) return
      delete current.page.agentUse
      this.publish(current)
    }, AGENT_USE_GRACE_MS)
    timer.unref?.()
    this.agentUseTimers.set(browserPageId, timer)
  }

  private stopAgentUseExpiry(browserPageId: string): void {
    const timer = this.agentUseTimers.get(browserPageId)
    if (!timer) return
    clearTimeout(timer)
    this.agentUseTimers.delete(browserPageId)
  }

  /**
   * Adopt a client's mounted `<webview>`. Desktop-local only: the server runs in
   * Electron main there and reaches the guest's `webContents` directly, so the
   * "bridge" is a function call rather than a broker.
   */
  async attachSurface(browserPageId: string, webContentsId: number): Promise<void> {
    const record = this.require(browserPageId)
    const host = browserWebviewHost()
    if (!host) throw new Error('This host cannot render a browser surface.')
    await this.queueDriver(record, async () => {
      await record.driver?.dispose().catch(() => {})
      record.driver = null
      try {
        record.driver = await host.attach(webContentsId)
        record.page.hostKind = record.driver.kind
        delete record.page.problem
        await this.applyEmulation(record)
        // A page a remote client was already streaming keeps streaming through the
        // migration onto the guest the desktop user now watches — one source, so
        // the phone and the pane cannot show different states.
        await this.startStreamingOnCurrentDriver(record)
        // Only now does the guest go anywhere. It was mounted blank precisely so
        // that attach and emulation could happen first, and the real page could
        // lay out once at the size the user chose instead of at the window's.
        this.startInitialLoad(record)
      } catch (error) {
        // A surface the host cannot emulate is worse than no surface: the pane
        // would show a live guest at the window's own metrics while the page
        // still claims to be a phone. Refuse it, and say so where it is visible.
        await record.driver?.dispose().catch(() => {})
        record.driver = null
        record.page.hostKind = 'none'
        record.page.problem = {
          kind: 'load-failed',
          message: error instanceof Error ? error.message : 'The browser surface could not be prepared.',
        }
        this.publish(record)
        log.warn('browser_surface_attach_failed', { browserPageId, message: record.page.problem.message })
        throw error
      }
      this.publish(record)
    })
  }

  /**
   * Take a surface back.
   *
   * A guest whose render process died still has to say so — the pane offers a
   * reload, and "waiting for a pane" in front of a dead guest would tell the
   * user to do the one thing that cannot help. A pane that simply closed leaves
   * no problem at all where the headless host exists: the page is unhosted, not
   * broken, and the next agent verb re-hosts it.
   */
  async detachSurface(browserPageId: string, reason: BrowserDetachReason = 'released'): Promise<void> {
    const record = this.records.get(browserPageId)
    if (!record || record.closing) return
    await this.queueDriver(record, async () => {
      await record.driver?.dispose().catch(() => {})
      record.driver = null
      record.page.hostKind = 'none'
      record.page.loadState = 'idle'
      if (reason === 'crashed') {
        record.page.problem = {
          kind: 'surface-crashed',
          message: 'The browser page stopped responding and could not be restarted.',
        }
      } else if (browserHeadlessHost()) {
        delete record.page.problem
      } else {
        record.page.problem = { ...NO_SURFACE }
      }
      this.stopLiveness(record)
      this.publish(record)
      if (reason === 'crashed') {
        log.warn('browser_surface_crashed', { browserPageId })
        return
      }
      // The desktop pane closed, but a remote client may still be watching. Re-host
      // headless and keep its stream alive rather than going dark until the next
      // drive op. A crashed guest is not resumed — the user reloads that one.
      this.resumeStreamingIfWatched(record)
    })
  }

  /** The client owns what its guest is actually showing; the registry owns
   *  publishing it, so every other client and every agent sees the same page. */
  reportSurface(browserPageId: string, report: BrowserSurfaceReport): void {
    const record = this.records.get(browserPageId)
    if (!record) return
    const { page } = record
    // The scaffolding a guest is mounted at is never the page's address. A
    // client that reports it anyway would put `about:blank` in the toolbar of a
    // page that is about to be somewhere else.
    if (report.url === BROWSER_BLANK_URL) return
    page.url = report.url || page.url
    page.title = report.title
    if (report.loadState === 'ready' && page.loadState !== 'ready' && record.loadStartedAt) {
      log.info('browser_page_load', {
        browserPageId: page.browserPageId,
        stage: 'ready',
        ms: Date.now() - record.loadStartedAt,
      })
      emitBrowserLoad({ page, startedAt: record.loadStartedAt, endedAt: Date.now() })
      record.loadStartedAt = null
    }
    page.loadState = report.loadState
    page.canGoBack = report.canGoBack
    page.canGoForward = report.canGoForward
    if (report.loadState === 'failed') {
      page.problem = {
        kind: 'target-unreachable',
        message: report.failure ?? 'The dev server is not answering on this port.',
      }
      // A load that failed is still a load, and the one an operator most wants
      // to find. Recording only the successes would make the trace a survey of
      // the pages that worked.
      if (record.loadStartedAt) {
        emitBrowserLoad({
          page,
          startedAt: record.loadStartedAt,
          endedAt: Date.now(),
          problem: page.problem.message,
        })
        record.loadStartedAt = null
      }
      this.startLiveness(record)
    } else if (page.problem?.kind !== 'no-surface') {
      delete page.problem
      this.stopLiveness(record)
    }
    this.publish(record)
  }

  async navigate(browserPageId: string, op: BrowserNavigateOp): Promise<void> {
    const record = this.require(browserPageId)
    await this.withDriver(record, async (driver) => {
      if (op.kind === 'goto') record.page.url = op.url
      record.page.loadState = 'loading'
      this.publish(record)
      await driver.navigate(op)
    })
  }

  async setViewport(browserPageId: string, request: BrowserViewportRequest): Promise<void> {
    const record = this.require(browserPageId)
    const next = resolveViewport(request)
    // A pane being dragged in fill mode sends a request per frame it settles on.
    // Re-emulating an identical viewport would reload layout for nothing, and
    // every mounted client would re-render the page row behind it.
    if (sameViewport(record.page.viewport, next)) return
    record.page.viewport = next
    this.publish(record)
    if (record.driver) {
      await this.queueDriver(record, async () => this.applyEmulation(record))
      // The stream's caps are derived from the viewport, so a resize has to
      // restart it or a watcher keeps receiving frames at the old size.
      await this.startStreaming(record)
    }
  }

  async setAppearance(browserPageId: string, appearance: BrowserAppearance): Promise<void> {
    const record = this.require(browserPageId)
    record.page.appearance = appearance
    this.publish(record)
    if (record.driver) await this.queueDriver(record, async () => this.applyEmulation(record))
  }

  /**
   * Everything an agent needs to judge a page: its structure, its screenshot,
   * and what it has been saying.
   *
   * Each stage is timed and logged because a snapshot is the one verb where a
   * stall is invisible from outside — the tool simply never answers, and the
   * agent has nothing to react to. `browser_snapshot_stage` makes the next stall
   * name itself instead of costing a round of log archaeology.
   */
  async snapshot(browserPageId: string, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshot> {
    const record = this.require(browserPageId)
    const stage = stageTimer(browserPageId)
    const startedAt = Date.now()

    return this.withDriver(record, async (driver) => {
      stage('hosted', record.page.hostKind)

      const structure = parseJson(
        structureSchema,
        await driver.evaluate(elementSnapshotExpression(options.maxElements ?? DEFAULT_MAX_ELEMENTS)),
      ) ?? { title: '', url: '', elements: [] }
      stage('structure', `${structure.elements.length} elements`)
      const snapshot: BrowserSnapshot = {
        browserPageId,
        url: structure.url || record.page.url,
        title: structure.title || record.page.title,
        viewport: record.page.viewport,
        appearance: record.page.appearance,
        elements: structure.elements,
        console: driver.consoleEntries().slice(-BROWSER_RING_LIMIT),
        network: driver.networkEntries().slice(-BROWSER_RING_LIMIT),
        capturedAt: Date.now(),
      }
      // Read before the screenshot: the capture wakes a throttled guest and can
      // take seconds, and a page that painted something in the meantime would make
      // the timings describe a moment after the one being described.
      if (options.vitals !== false) {
        const vitals = parseJson(vitalsSchema, await driver.evaluate(webVitalsExpression()))
        if (vitals && Object.keys(vitals).length > 0) snapshot.vitals = vitals
        stage('vitals', vitals ? Object.keys(vitals).join(',') : 'none')
      }
      if (options.screenshot !== false) {
        snapshot.screenshot = await driver.captureScreenshot()
        stage('screenshot', `${Math.round(snapshot.screenshot.length / 1024)}kb`)
      }
      const capture: BrowserCaptureSpanInput = {
        page: record.page,
        startedAt,
        endedAt: Date.now(),
        elementCount: snapshot.elements.length,
        consoleErrorCount: snapshot.console.filter((entry) => entry.level === 'error').length,
      }
      if (snapshot.vitals) capture.vitals = snapshot.vitals
      emitBrowserCapture(capture)
      return snapshot
    })
  }

  /**
   * The picture alone, with the page facts that describe it.
   *
   * Evidence is not a snapshot: nobody reading a screenshot on a pull request
   * wants the accessibility tree, and extracting it would make a capture pay for
   * a DOM walk it never uses. Hosting rules are the snapshot's, so capturing a
   * page no pane is showing still works.
   */
  async capture(browserPageId: string): Promise<{ screenshot: string; page: BrowserPage }> {
    const record = this.require(browserPageId)
    return this.withDriver(record, async (driver) => ({
      screenshot: await driver.captureScreenshot(),
      page: record.page,
    }))
  }

  /**
   * Hand the page's guest to Chromium's own DevTools.
   *
   * The inspector is the browser's, not a reimplementation: elements, styles,
   * network and the console, on the exact guest the pane is showing, with the
   * device emulation already applied. The cost is the CDP session — Chromium
   * allows one debugger per target — so the page is undrivable until the window
   * closes, which is why `devToolsOpen` is page state every surface can see
   * rather than a fact known only to the pane that opened it.
   */
  async openDevTools(browserPageId: string): Promise<void> {
    const record = this.require(browserPageId)
    await this.withDriver(record, async (driver) => {
      await driver.openDevTools(() => {
        record.page.devToolsOpen = false
        this.publish(record)
        // The overrides went away with the session. The page's own state is the
        // only copy that survived, so it is what the guest is restored from.
        void this.queueDriver(record, async () => {
          await this.applyEmulation(record)
          await this.startStreamingOnCurrentDriver(record)
        })
          .catch((error) => {
            log.warn('browser_devtools_restore_failed', {
              browserPageId,
              message: error instanceof Error ? error.message : String(error),
            })
          })
      })
      record.page.devToolsOpen = true
      this.publish(record)
      log.info('browser_devtools_opened', { browserPageId })
    })
  }

  /**
   * Arm an annotation tool on a page, or disarm it.
   *
   * The overlay is injected into the guest rather than drawn by the client, so
   * one implementation serves the desktop `<webview>` a user draws on directly
   * and the streamed canvas a phone forwards taps from — and any capture taken
   * while the marks are up contains them.
   */
  async setAnnotationTool(browserPageId: string, tool: BrowserAnnotationTool | null): Promise<BrowserAnnotationState> {
    const record = this.require(browserPageId)
    return this.withDriver(record, async (driver) => {
      const state = await this.readAnnotations(driver, browserPageId, annotationSyncExpression(tool))
      record.page.annotationTool = tool
      this.publish(record)
      return state
    })
  }

  /** What the user has marked. Re-arms the tool on the way in: the guest may
   *  have reloaded since the last read, which takes the overlay with it. */
  async annotationState(browserPageId: string): Promise<BrowserAnnotationState> {
    const record = this.require(browserPageId)
    return this.withDriver(record, async (driver) => this.readAnnotations(
        driver,
        browserPageId,
        annotationSyncExpression(record.page.annotationTool),
      ))
  }

  async annotate(browserPageId: string, op: BrowserAnnotateOp): Promise<BrowserAnnotationState> {
    const record = this.require(browserPageId)
    return this.withDriver(record, async (driver) =>
      this.readAnnotations(driver, browserPageId, annotationOpExpression(op)))
  }

  private async readAnnotations(
    driver: BrowserSurfaceDriver,
    browserPageId: string,
    expression: string,
  ): Promise<BrowserAnnotationState> {
    const parsed = parseJson(annotationStateSchema, await driver.evaluate(expression))
    return { browserPageId, annotations: parsed?.annotations ?? [] }
  }

  async interact(browserPageId: string, op: BrowserInteractOp): Promise<BrowserInteractResult> {
    const record = this.require(browserPageId)
    return this.withDriver(record, async (driver) => {

    if (op.kind === 'evaluate') return runGuarded(driver, op.expression)

    // Coordinate-addressed input from a streamed surface: the client already
    // mapped a pointer to a CSS-viewport coordinate, so these go straight to the
    // guest without resolving a selector first.
    if (op.kind === 'clickAt') {
      await driver.clickAt(op.x, op.y)
      return { ok: true }
    }
    if (op.kind === 'scrollAt') {
      await driver.scrollAt(op.x, op.y, op.deltaY)
      return { ok: true }
    }
    if (op.kind === 'insertText') {
      await driver.insertText(op.text)
      return { ok: true }
    }

    if (op.kind === 'press') {
      await driver.pressKey(op.key)
      return { ok: true }
    }

    if (op.kind === 'waitFor') {
      const deadline = Date.now() + (op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
      for (;;) {
        const result = await runGuarded(driver, op.expression)
        if (result.ok && result.value && result.value !== 'null' && result.value !== 'false') return result
        if (Date.now() >= deadline) {
          return { ok: false, message: `Timed out waiting for: ${op.expression}` }
        }
        await delay(WAIT_POLL_MS)
      }
    }

    if (op.kind === 'scroll') {
      const point = op.ref
        ? await this.pointOf(driver, op.ref)
        : { x: record.page.viewport.width / 2, y: record.page.viewport.height / 2 }
      if (!point) return { ok: false, message: `No element matches ${op.ref}` }
      await driver.scrollAt(point.x, point.y, op.deltaY)
      return { ok: true }
    }

    const point = await this.pointOf(driver, op.ref)
    if (!point) return { ok: false, message: `No visible element matches ${op.ref}` }

    if (op.kind === 'click') {
      await driver.clickAt(point.x, point.y)
      return { ok: true }
    }

    // Type: clear first when asked, then click to focus so the guest sees a real
    // caret placement rather than a programmatic value assignment.
    if (op.clear) await driver.evaluate(clearFieldExpression(op.ref))
    await driver.clickAt(point.x, point.y)
    await driver.insertText(op.text)
      return { ok: true }
    })
  }

  /**
   * Send a freshly attached guest to the page's address.
   *
   * The client mounts every native guest blank, so this is what actually loads
   * the page — after CDP is attached and the emulation is applied, which is the
   * whole point of the ordering: the page lays out once, at the size the user
   * chose, instead of laying out at the window's size and reflowing when the
   * metrics override lands mid-load.
   *
   * Deliberately not awaited. `loadURL` resolves only when the page has finished
   * loading, and the client is waiting on the attach RPC — blocking it for the
   * length of a page load would delay the pane learning it has a surface at all.
   * The load reports itself through `reportSurface` like any other navigation.
   */
  private startInitialLoad(record: PageRecord): void {
    const { page } = record
    if (page.target.kind !== 'url' || !page.url) return
    const driver = record.driver
    if (!driver) return
    page.loadState = 'loading'
    record.loadStartedAt = Date.now()
    this.publish(record)
    log.info('browser_page_load', { browserPageId: page.browserPageId, stage: 'navigating', url: page.url })
    void driver.navigate({ kind: 'goto', url: page.url }).catch((error) => {
      // A load that fails still commits an error page, and the guest reports
      // that failure itself; this only records the reason it never started.
      log.warn('browser_initial_load_failed', {
        browserPageId: page.browserPageId,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * Start streaming a page to one client.
   *
   * The first watcher is what starts the guest painting frames; later watchers
   * join a stream already running. Streaming a page hosts it if nothing else
   * has — a phone watching a page no desktop pane is showing is exactly the case
   * the headless host exists for — so this walks the same `ensureDriver` path a
   * drive op does, and fails the same way where nothing can host.
   */
  async subscribeFrames(browserPageId: string, clientId: string): Promise<void> {
    const record = this.require(browserPageId)
    if (!this.frames) throw new Error('This host cannot stream browser frames.')
    let watchers = this.frameWatchers.get(browserPageId)
    if (!watchers) {
      watchers = new Map()
      this.frameWatchers.set(browserPageId, watchers)
    }
    const wasEmpty = watchers.size === 0
    watchers.set(clientId, (watchers.get(clientId) ?? 0) + 1)
    let startup = this.streamStarts.get(browserPageId)
    if (wasEmpty) {
      startup = this.startStreaming(record)
      this.streamStarts.set(browserPageId, startup)
      void startup.finally(() => {
        if (this.streamStarts.get(browserPageId) === startup) {
          this.streamStarts.delete(browserPageId)
        }
      }).catch(() => {})
    }
    if (!startup) return
    // The first watcher is what starts the guest. If it cannot be hosted — no
    // headless engine on this host — drop the watcher again so a retry is a
    // fresh first subscribe rather than a no-op against a page that never
    // started, and let the caller see why.
    try {
      await startup
    } catch (error) {
      await this.dropWatcher(browserPageId, clientId)
      throw error
    }
  }

  /** One client stops watching. The last one leaving stops the guest painting,
   *  so a page returns to costing nothing the moment no pane shows it. */
  unsubscribeFrames(browserPageId: string, clientId: string): Promise<void> {
    return this.dropWatcher(browserPageId, clientId)
  }

  /** A client's connection expired. It cannot unsubscribe for itself, so the
   *  transport drops it from every page — otherwise a disconnected phone would
   *  keep a guest painting frames into the void. */
  async dropClient(clientId: string): Promise<void> {
    // Deleting the current key during a Map key iteration is safe, and
    // `dropWatcher` only ever deletes the key it was handed.
    await Promise.all([...this.frameWatchers.keys()].map((browserPageId) =>
      this.dropWatcher(browserPageId, clientId, true)))
  }

  private async dropWatcher(browserPageId: string, clientId: string, all = false): Promise<void> {
    const watchers = this.frameWatchers.get(browserPageId)
    const count = watchers?.get(clientId)
    if (!watchers || !count) return
    if (!all && count > 1) {
      watchers.set(clientId, count - 1)
      return
    }
    watchers.delete(clientId)
    if (watchers.size > 0) return
    this.frameWatchers.delete(browserPageId)
    this.frameSeq.delete(browserPageId)
    const record = this.records.get(browserPageId)
    if (record) {
      await this.queueDriver(record, async () => {
        await record.driver?.stopScreencast().catch(() => {})
      })
    }
  }

  /**
   * Point the current driver's stream at this page's watchers.
   *
   * Called for the first watcher, and again whenever the thing being streamed
   * changes underneath them: a viewport resize (new caps), or a host migration
   * (new guest). `startScreencast` replaces caps and listener rather than
   * stacking, so calling it repeatedly is a restart, not a leak.
   */
  private async startStreaming(record: PageRecord): Promise<void> {
    if (!this.frames) return
    await this.withDriver(record, async (driver) => {
      await this.startStreamingOnCurrentDriver(record, driver)
    })
  }

  private async startStreamingOnCurrentDriver(
    record: PageRecord,
    driver = record.driver,
  ): Promise<void> {
    if (!this.frames || !driver) return
    const { browserPageId } = record.page
    // The pane can hide while a slow headless guest is opening. Do not start an
    // unwatched screencast after that open finishes.
    if (!this.frameWatchers.get(browserPageId)?.size) return
    await driver.startScreencast(screencastOptionsFor(record.page.viewport), (frame) => {
      const watchers = this.frameWatchers.get(browserPageId)
      if (!watchers || watchers.size === 0) return
      const seq = (this.frameSeq.get(browserPageId) ?? 0) + 1
      this.frameSeq.set(browserPageId, seq)
      this.frames?.publish(watchers.keys(), { browserPageId, seq }, frame)
    })
  }

  /** Restart the stream after the guest or its size changed, but only if someone
   *  is watching. A page with no watchers must not be hosted just because it was
   *  resized. */
  private resumeStreamingIfWatched(record: PageRecord): void {
    if (!this.frameWatchers.get(record.page.browserPageId)?.size) return
    void this.startStreaming(record).catch((error) => {
      log.warn('browser_stream_resume_failed', {
        browserPageId: record.page.browserPageId,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** The cookie jar one page's guest runs in. */
  partitionOf(page: BrowserPage): string {
    return browserProfilePartition(
      page.target.kind === 'url' ? page.target.projectRoot : undefined,
      page.profileId,
    )
  }

  /** The open pages signed in to one jar. What a profile deletion has to name
   *  before it takes a live login away. */
  pagesOnPartition(partition: string): BrowserPage[] {
    return this.list().filter((page) => this.partitionOf(page) === partition)
  }

  /** Forget a profile, then reload every page using it so the pane shows the
   *  logged-out state instead of a stale rendering of the old session. */
  async clearProfile(partition: string): Promise<void> {
    const host = browserProfileHost()
    if (!host) throw new Error('This host holds no browser profiles.')
    await host.clearProfile(partition)
    for (const record of this.records.values()) {
      if (this.partitionOf(record.page) !== partition) continue
      await this.queueDriver(record, async () => {
        await record.driver?.navigate({ kind: 'reload' }).catch(() => {})
      })
    }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.agentUseTimers.values()) clearTimeout(timer)
    this.agentUseTimers.clear()
    for (const record of this.records.values()) {
      record.closing = true
      this.stopLiveness(record)
      await this.queueDriver(record, async () => {
        await record.driver?.dispose().catch(() => {})
        record.driver = null
      })
    }
    this.records.clear()
    this.frameWatchers.clear()
    this.streamStarts.clear()
    this.frameSeq.clear()
  }

  private async pointOf(
    driver: BrowserSurfaceDriver,
    ref: string,
  ): Promise<{ x: number; y: number } | null> {
    const parsed = parseJson(pointSchema, await driver.evaluate(elementRectExpression(ref)))
    return parsed ?? null
  }

  /** What a guest must be emulating to be showing this page. One definition, so
   *  a guest handed to a pane and a guest opened headless cannot differ. */
  private emulationFor(page: BrowserPage): BrowserEmulation {
    // A sized viewport names no device, so the guest keeps the host browser's
    // own user agent: claiming to be an iPhone at 900px wide would make every
    // agent-sniffing page lie about what the user is looking at.
    const presetId = page.viewport.presetId
    const preset = presetId ? presetById(presetId) : undefined
    const emulation: BrowserEmulation = {
      viewport: page.viewport,
      appearance: page.appearance,
    }
    if (preset?.userAgent) emulation.userAgent = preset.userAgent
    return emulation
  }

  private async applyEmulation(record: PageRecord): Promise<void> {
    await record.driver?.applyEmulation(this.emulationFor(record.page))
  }

  private require(browserPageId: string): PageRecord {
    const record = this.records.get(browserPageId)
    if (!record || record.closing) throw new Error(`No browser page ${browserPageId}`)
    return record
  }

  /** Add one operation to the page's driver lane. A rejected operation does not
   *  poison later cleanup or recovery work. */
  private queueDriver<T>(record: PageRecord, operation: () => Promise<T>): Promise<T> {
    const result = record.driverQueue.catch(() => {}).then(operation)
    record.driverQueue = result.then(() => {}, () => {})
    return result
  }

  private withDriver<T>(
    record: PageRecord,
    operation: (driver: BrowserSurfaceDriver) => Promise<T>,
  ): Promise<T> {
    return this.queueDriver(record, async () => operation(await this.ensureDriver(record)))
  }

  /**
   * The driver a drive op should use, opening a headless guest if the page has
   * none.
   *
   * This is the whole point of the headless host: an agent in a worktree, an
   * automation, or a phone drives a page without a desktop pane anywhere. Where
   * no headless host is registered the op still fails loudly rather than
   * succeeding against nothing.
   */
  private async ensureDriver(record: PageRecord): Promise<BrowserSurfaceDriver> {
    if (record.driver) return record.driver
    const host = browserHeadlessHost()
    if (!host) {
      throw new Error(
        'This browser page has no surface, and this host cannot render one. Open it in a '
        + 'browser pane on the desktop app, or call browser_open with show: true so a '
        + 'connected client provides one.',
      )
    }
    if (record.page.target.kind !== 'url') {
      throw new Error('Device targets need their platform adapter, which this host does not have.')
    }
    if (!record.page.url) throw new Error('This browser page has no address to open.')

    return this.openHeadless(host, record)
  }

  private async openHeadless(host: BrowserHeadlessHost, record: PageRecord): Promise<BrowserSurfaceDriver> {
    const { page } = record
    page.loadState = 'loading'
    this.publish(record)

    let driver: BrowserSurfaceDriver
    try {
      // The emulation travels with the open rather than following it: only the
      // host can apply it before the guest navigates, which is what keeps the
      // page from laying out twice and lets the rings cover its own load.
      driver = await host.open({
        url: page.url,
        // The page's own profile inside the project, not the worktree's: a
        // headless page uses the same login the user obtained in a pane.
        partition: this.partitionOf(page),
        emulation: this.emulationFor(page),
        report: (report) => { this.reportSurface(page.browserPageId, report) },
      })
    } catch (error) {
      // A guest that could not be prepared — most often one that refused the
      // emulation — would render at the window's own metrics while the page
      // still claims to be a phone. Worse than no guest at all.
      page.hostKind = 'none'
      page.problem = {
        kind: 'load-failed',
        message: error instanceof Error ? error.message : 'The headless guest could not be prepared.',
      }
      this.publish(record)
      log.warn('browser_headless_open_failed', { browserPageId: page.browserPageId, message: page.problem.message })
      throw error
    }

    record.driver = driver
    page.hostKind = driver.kind
    // A page that was merely unhosted, or whose last guest died, is neither now.
    // A target that is not answering still is, and its problem stays.
    if (page.problem?.kind === 'no-surface' || page.problem?.kind === 'surface-crashed') {
      delete page.problem
    }
    this.publish(record)
    log.info('browser_headless_hosted', { browserPageId: page.browserPageId })
    return driver
  }

  /**
   * While the target is unreachable, watch the port rather than the process —
   * nothing here owns the dev server, so its return is the only signal
   * available. When it answers, the page reloads itself.
   */
  private startLiveness(record: PageRecord): void {
    if (record.livenessTimer || record.page.target.kind !== 'url') return
    record.livenessTimer = setInterval(() => {
      void reachable(record.page.url).then(async (isUp) => {
        if (
          !isUp ||
          !record.livenessTimer ||
          record.closing ||
          this.records.get(record.page.browserPageId) !== record
        ) return
        this.stopLiveness(record)
        record.page.loadState = 'loading'
        delete record.page.problem
        this.publish(record)
        await record.driver?.navigate({ kind: 'reload' }).catch(() => {})
      })
    }, LIVENESS_INTERVAL_MS)
    record.livenessTimer.unref?.()
  }

  private stopLiveness(record: PageRecord): void {
    if (!record.livenessTimer) return
    clearInterval(record.livenessTimer)
    record.livenessTimer = null
  }

  private publish(record: PageRecord): void {
    this.events.pageChanged(record.page)
  }
}

/**
 * Log each stage of a snapshot as it finishes, with the time it took.
 *
 * A snapshot that stalls produces no error and no event — the tool call simply
 * never answers. The last stage logged is then the only evidence of where it
 * stopped, which is what turns "it hangs" into a one-line diagnosis.
 */
function stageTimer(browserPageId: string): (name: string, detail: string) => void {
  let last = Date.now()
  return (name, detail) => {
    const now = Date.now()
    log.debug('browser_snapshot_stage', { browserPageId, stage: name, detail, ms: now - last })
    last = now
  }
}

/**
 * The caps a page streams at.
 *
 * Bounded to CSS-viewport size, not the emulated device-pixel size: a phone
 * preset composites at 3x, and streaming those pixels to a remote screen that
 * then scales the picture down anyway is wire budget spent on detail no one
 * sees. The dimension ceiling then keeps even a large desktop viewport from
 * streaming an oversized frame.
 */
function screencastOptionsFor(viewport: BrowserViewport): BrowserScreencastOptions {
  return {
    maxWidth: Math.min(viewport.width, BROWSER_FRAME_MAX_DIMENSION),
    maxHeight: Math.min(viewport.height, BROWSER_FRAME_MAX_DIMENSION),
    quality: BROWSER_FRAME_QUALITY,
  }
}

function sameViewport(current: BrowserViewport, next: BrowserViewport): boolean {
  return (
    current.mode === next.mode
    && current.presetId === next.presetId
    && current.width === next.width
    && current.height === next.height
    && current.deviceScaleFactor === next.deviceScaleFactor
    && current.hasTouch === next.hasTouch
  )
}

function labelFor(request: BrowserOpenRequest): string {
  if (request.target.kind === 'device') return request.target.deviceId
  if (request.target.branch) return request.target.branch
  try {
    const url = new URL(request.target.url)
    return url.port ? `localhost:${url.port}` : url.host
  } catch {
    return request.target.url
  }
}

/**
 * Everything a guest returns is I/O: the page can be anything, including a page
 * that redefined `JSON.stringify`. Each shape is parsed before the registry
 * treats it as a value.
 */
const pointSchema = z.object({ x: z.number(), y: z.number() }).nullable()

const guardedSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.json().nullable() }),
  z.object({ ok: z.literal(false), message: z.string() }),
])

const elementSchema = z.object({
  role: z.string(),
  label: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  ref: z.string(),
  identifier: z.string().optional(),
  source: z.object({ file: z.string(), line: z.number(), column: z.number() }).optional(),
  disabled: z.boolean().optional(),
  value: z.string().optional(),
})

/** Every member optional and non-negative: a metric that has not happened is
 *  absent, and a negative timing is a page that lied about its own clock. */
const vitalsSchema = z.object({
  ttfbMs: z.number().nonnegative().optional(),
  fcpMs: z.number().nonnegative().optional(),
  lcpMs: z.number().nonnegative().optional(),
  cls: z.number().nonnegative().optional(),
  domContentLoadedMs: z.number().nonnegative().optional(),
  loadMs: z.number().nonnegative().optional(),
})

const pointsSchema = z.array(z.object({ x: z.number(), y: z.number() }))

const annotationSchema = z.object({
  id: z.string(),
  // From the contract, never restated: a tool this does not know makes the whole
  // array fail to parse, so every mark on the page disappears because of one.
  tool: z.enum(BROWSER_MARK_TOOLS),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  path: pointsSchema.optional(),
  element: elementSchema.optional(),
  elements: z.array(elementSchema).optional(),
  note: z.string().optional(),
  createdAt: z.number(),
  number: z.number().optional(),
})

const annotationStateSchema = z.object({
  // One malformed mark must not discard the rest of what the user pointed at.
  annotations: z.array(annotationSchema).catch([]).default([]),
})

const structureSchema = z.object({
  title: z.string().default(''),
  url: z.string().default(''),
  // One malformed entry must not cost the whole snapshot; the rest still
  // describes the view.
  elements: z.array(elementSchema).catch([]).default([]),
})

function parseJson<Schema extends z.ZodType>(schema: Schema, raw: string): z.output<Schema> | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = schema.safeParse(decoded)
  return parsed.success ? parsed.data : null
}

async function runGuarded(driver: BrowserSurfaceDriver, expression: string): Promise<BrowserInteractResult> {
  const outcome = parseJson(guardedSchema, await driver.evaluate(guardedExpression(expression)))
  if (!outcome) return { ok: false, message: 'The page returned nothing.' }
  return outcome.ok
    ? { ok: true, value: JSON.stringify(outcome.value) }
    : { ok: false, message: outcome.message }
}

async function reachable(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let registry: BrowserRegistry | null = null

/** One registry per host process. Agent verbs and RPC handlers address the same
 *  pages, which is the entire point of the state being server-owned. */
export function initBrowserRegistry(
  events: BrowserEventSink,
  frames: BrowserFrameChannel | null = null,
): BrowserRegistry {
  registry = new BrowserRegistry(events, frames)
  return registry
}

export function browserRegistry(): BrowserRegistry {
  if (!registry) throw new Error('The browser domain is not available on this host.')
  return registry
}
