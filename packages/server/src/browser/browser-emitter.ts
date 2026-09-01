import {
  snapshotViewportLabel,
  type BrowserPage,
  type BrowserWebVitals,
} from '@solus/contracts/browser-types'
import { SPAN_KINDS, SPAN_SERVICES, type SpanAttributes, type SpanStatus } from '../observability/registries'

/**
 * The browser domain's half of the observability facade.
 *
 * Browser is an emitter, not an owner: it states what happened in the registered
 * vocabulary and the tracer decides where that lands (`metrics.db` always, a
 * collector when the operator asked for one). Two things are worth recording
 * here and nothing else — how long a page took to load, and what a capture found
 * — because those are the two questions Insights cannot answer from anywhere
 * else.
 *
 * Web Vitals ride on the capture span rather than on a metric of their own. The
 * capture is already standing in front of a real Chromium at a known viewport in
 * a known worktree, so attaching them there is what makes "did this branch make
 * the board slower to paint on a phone than main does" one query rather than a
 * new subsystem.
 */

/** One finished interval, in the registered vocabulary. Both spans are emitted
 *  after the fact, with explicit start and end times: a guest can be replaced or
 *  migrated mid-load, and a span held open across that would measure the wrong
 *  thing. */
export interface BrowserSpan {
  kind: typeof SPAN_KINDS.browserLoad | typeof SPAN_KINDS.browserCapture
  name: string
  service: typeof SPAN_SERVICES.browser
  startedAt: number
  endedAt: number
  status: SpanStatus
  attrs: SpanAttributes
  dimensions: { projectRoot?: string }
}

export type BrowserSpanRecorder = (span: BrowserSpan) => void

/**
 * Where browser spans go, set by whoever can record them.
 *
 * The same seam the surface hosts use, and for the same reason: the tracer
 * reaches `metrics.db` and therefore `node:sqlite`, which only the packaged
 * runtime has. Registering rather than importing keeps the browser domain
 * usable on a host — or in a test — where observability is not, and keeps the
 * wiring somewhere a reader can see it instead of buried in a lazy import.
 */
let recorder: BrowserSpanRecorder | null = null

export function setBrowserSpanRecorder(next: BrowserSpanRecorder | null): void {
  recorder = next
}

function emit(input: {
  kind: typeof SPAN_KINDS.browserLoad | typeof SPAN_KINDS.browserCapture
  page: BrowserPage
  startedAt: number
  endedAt: number
  status: SpanStatus
  attrs: SpanAttributes
}): void {
  if (!recorder) return
  recorder({
    kind: input.kind,
    name: input.page.label,
    service: SPAN_SERVICES.browser,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: input.status,
    attrs: input.attrs,
    dimensions: dimensionsFor(input.page),
  })
}

/** The facts every browser span carries, so a query can group by any of them
 *  without knowing which kind it is looking at. */
function pageAttributes(page: BrowserPage): SpanAttributes {
  const attrs: SpanAttributes = {
    url: page.url,
    viewport: snapshotViewportLabel(page.viewport),
    hostKind: page.hostKind,
  }
  if (page.viewport.presetId) attrs.preset = page.viewport.presetId
  if (page.target.kind === 'url') {
    if (page.target.branch) attrs.branch = page.target.branch
    if (page.target.worktreePath) attrs.worktree = page.target.worktreePath
  }
  return attrs
}

/** The project a span is attributed to. `projectRoot` is a promoted column, so
 *  this is what lets a cross-worktree comparison group by repository. */
function dimensionsFor(page: BrowserPage): { projectRoot?: string } {
  const projectRoot = page.target.kind === 'url' ? page.target.projectRoot : undefined
  return projectRoot ? { projectRoot } : {}
}

/**
 * Record a load that has already finished.
 *
 * Emitted after the fact rather than opened at navigation and closed at ready:
 * a guest can be replaced, migrated between hosts, or simply never report, and a
 * span held open across all of that would measure the wrong thing or leak. The
 * registry already knows when the load started, so the honest form is to state
 * the interval once it is a fact.
 */
export function emitBrowserLoad(input: {
  page: BrowserPage
  startedAt: number
  endedAt: number
  problem?: string
}): void {
  const attrs = pageAttributes(input.page)
  if (input.problem) attrs.problem = input.problem
  emit({
    kind: SPAN_KINDS.browserLoad,
    page: input.page,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: input.problem ? 'error' : 'ok',
    attrs,
  })
}

export interface BrowserCaptureSpanInput {
  page: BrowserPage
  startedAt: number
  endedAt: number
  vitals?: BrowserWebVitals
  elementCount?: number
  consoleErrorCount?: number
  /** Where the capture was filed, when it became evidence rather than a look. */
  attachedTo?: string
}

export function emitBrowserCapture(input: BrowserCaptureSpanInput): void {
  const attrs = pageAttributes(input.page)
  if (input.elementCount !== undefined) attrs.elementCount = input.elementCount
  if (input.consoleErrorCount !== undefined) attrs.consoleErrorCount = input.consoleErrorCount
  if (input.attachedTo) attrs.attachedTo = input.attachedTo
  // Spread member by member rather than wholesale: an absent metric must stay
  // absent, and `undefined` in an attribute bag is a key OTel still ships.
  const vitals = input.vitals
  if (vitals) {
    if (vitals.ttfbMs !== undefined) attrs.ttfbMs = vitals.ttfbMs
    if (vitals.fcpMs !== undefined) attrs.fcpMs = vitals.fcpMs
    if (vitals.lcpMs !== undefined) attrs.lcpMs = vitals.lcpMs
    if (vitals.cls !== undefined) attrs.cls = vitals.cls
    if (vitals.domContentLoadedMs !== undefined) attrs.domContentLoadedMs = vitals.domContentLoadedMs
    if (vitals.loadMs !== undefined) attrs.loadMs = vitals.loadMs
  }
  emit({
    kind: SPAN_KINDS.browserCapture,
    page: input.page,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: 'ok',
    attrs,
  })
}
