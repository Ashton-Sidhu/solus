/**
 * Cold session open, end to end: sidebar click → transcript painted →
 * transcript settled → artifact frames loaded.
 *
 * Run with: bun tests/benchmarks/session-open.ts [--runs 5] [--trace] [--label baseline]
 *
 * The run uses the built `dist/` (it never builds), a disposable HOME with
 * fixture Claude transcripts (`session-open-fixtures.ts`), a temporary
 * SOLUS_DATA_DIR and dev log, and headless Chromium paired through the pair URL
 * the server prints. "Cold" means the client has not loaded the session: each
 * open starts from a fresh page load. The server and the OS file cache are warm,
 * as they are for a user who opens an older session in a running app.
 *
 * --cpu-throttle 4 slows the renderer CPU the way a loaded laptop does.
 * --trace records one Chrome trace for each fixture and splits renderer
 * main-thread time by kind (script, style, layout, paint, HTML parse, GC) and
 * script time by bundle chunk.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright'
import { writeFixtures, type Fixture } from './session-open-fixtures'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const RUNS = Number(flag('--runs') ?? 5)
const LABEL = flag('--label') ?? 'run'
const TRACE = argv.includes('--trace')
const KEEP = argv.includes('--keep')
/** Measure one fixture only, by key. */
const ONLY = flag('--only')
/** Chrome CPU slowdown factor: 4 stands in for a laptop that is busy with agents, builds, and other tabs. */
const CPU_THROTTLE = Number(flag('--cpu-throttle') ?? 1)
/** The transcript is settled when nothing in the workspace changed for this long. */
const QUIET_MS = 800
const OPEN_TIMEOUT_MS = 20_000

interface Rpc { method: string; start: number; end?: number; bytesIn: number; bytesOut: number; text?: string }
interface OpenSample {
  fixture: string
  /** Every time is milliseconds after the pointer went down on the sidebar row. */
  tabShown: number | null
  historyRequested: number | null
  historyReceived: number | null
  contentPainted: number | null
  settled: number | null
  artifactsLoaded: number | null
  frames: number
  /** Elements in the document, and turns the virtualizer mounted, once settled. */
  elements: number
  turnsMounted: number
  /** A tooltip is open once the open settles, and the clicked row was re-created by the open. */
  tooltipOpen: boolean
  composerFocused: boolean
  /** User Timing measures the app wrote during the open (`solus.mount.*`, `solus.open.*`), by name: how many, and
   *  the span from the first start to the last end, in ms after the click. A mount measure ends with its batch, so
   *  spans tell when each part mounted; summed durations would count the same time again. */
  measures: Record<string, { count: number; start: number; end: number }>
  tooltipText: string
  rowReplaced: boolean
  longTasks: number
  longestTask: number
  totalBlocking: number
  historyBytes: number
  /** The history reply as the socket sends it: deflated (`perMessageDeflate`). */
  historyWireBytes: number
  rpcs: Rpc[]
  serverPageMs: number | null
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

// A dev-mode Svelte build mounts far more slowly; its numbers say nothing about
// what users run. Its runtime keeps the ownership warning that production strips.
const clientAssets = join(import.meta.dir, '../../dist/client/assets')
if (readdirSync(clientAssets).some((file) => file.endsWith('.js') && readFileSync(join(clientAssets, file), 'utf8').includes('ownership_invalid_mutation'))) {
  throw new Error('dist/client is a dev-mode Svelte build. Rebuild with `bun run build` (it sets NODE_ENV=production).')
}

const root = mkdtempSync(join(tmpdir(), 'solus-open-bench-'))
const home = join(root, 'home')
const data = join(root, 'data')
const devLog = join(root, 'dev.log')
const fixtures = writeFixtures(home, join(root, 'project')).filter((fixture) => !ONLY || fixture.key === ONLY)

function startServer(): { server: ChildProcess; output: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, SOLUS_DATA_DIR: data, SOLUS_PORT: '0', SOLUS_NO_LAN_DISCOVERY: '1',
    SOLUS_DEV_LOG: devLog, SOLUS_DB: 'sqlite',
  }
  delete env.DATABASE_URL
  const server = spawn('node', [join(import.meta.dir, '../../dist/main/standalone.js'), '--data-dir', data], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  server.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString() })
  return { server, output: () => out }
}

async function waitFor<T>(read: () => T | null | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

// ---------------------------------------------------------------------------
// in-page probes
// ---------------------------------------------------------------------------

/** Times every socket.io RPC the page sends: `42<ack>["rpc",id,method,...]` out, `43<ack>` (or a binary `46n-<ack>`) back. */
function installRpcProbe(): void {
  type Probe = { rpcs: Map<string, { method: string; start: number; end?: number; bytesIn: number; bytesOut: number; text?: string }>; pendingBinary: string | null }
  const probe: Probe = { rpcs: new Map(), pendingBinary: null }
  Reflect.set(window, '__rpcProbe', probe)
  const size = (data: unknown): number => typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : 0
  const Native = window.WebSocket
  class ProbedSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('message', (event) => {
        const now = performance.now()
        if (typeof event.data !== 'string') {
          const rpc = probe.pendingBinary ? probe.rpcs.get(probe.pendingBinary) : undefined
          if (rpc) { rpc.bytesIn += size(event.data); rpc.end = now }
          return
        }
        const match = /^4([36])(?:(\d+)-)?(\d+)/.exec(event.data)
        if (!match) return
        const rpc = probe.rpcs.get(match[3])
        if (!rpc) return
        rpc.end = now
        rpc.bytesIn += event.data.length
        // The history reply is deflated on the wire; its text lets the run measure that.
        if (rpc.method === 'loadSessionPage') rpc.text = event.data
        probe.pendingBinary = match[2] ? match[3] : null
      })
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string') {
        const match = /^4[25](?:\d+-)?(\d+)\["rpc","[^"]*","([^"]+)"/.exec(data)
        if (match) probe.rpcs.set(match[1], { method: match[2], start: performance.now(), bytesIn: 0, bytesOut: data.length })
      }
      super.send(data)
    }
  }
  window.WebSocket = ProbedSocket
}

interface PageProbe {
  t0: number
  /** The composer had the keyboard when the click started; if not, the open unfolds it. */
  composerFocused: boolean
  tabShown: number | null
  contentPainted: number | null
  lastMutation: number
  frameLoads: number[]
  longTasks: Array<{ start: number; duration: number }>
}

/** Arms the open probes, then resolves once the click lands. Runs in the page. */
function armOpenProbe(title: string): void {
  const probe: PageProbe = { t0: 0, composerFocused: false, tabShown: null, contentPainted: null, lastMutation: 0, frameLoads: [], longTasks: [] }
  Reflect.set(window, '__openProbe', probe)
  const activeTab = (): Element | null => document.querySelector('.tab-slot:not(.tab-hidden)')
  addEventListener('pointerdown', (event) => {
    probe.t0 = event.timeStamp
    probe.composerFocused = !!document.activeElement?.closest('[data-testid="message-input"]')
  }, { capture: true, once: true })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: 'longtask' })
  new MutationObserver(() => { probe.lastMutation = performance.now() })
    .observe(document.body, { subtree: true, childList: true, characterData: true })
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLIFrameElement && event.target.matches('[data-testid="artifact-iframe"]')) probe.frameLoads.push(performance.now())
  }, { capture: true })
  // A frame callback sees the DOM the next paint shows.
  const frame = (): void => {
    if (probe.t0) {
      const tab = activeTab()
      if (probe.tabShown === null && [...document.querySelectorAll('header, [data-tab-title], nav')].some((el) => el.textContent?.includes(title))) probe.tabShown = performance.now()
      if (probe.contentPainted === null && tab?.querySelector('[data-testid="assistant-message"]')) probe.contentPainted = performance.now()
    }
    if (probe.contentPainted === null || performance.now() - probe.lastMutation < 2000) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// ---------------------------------------------------------------------------
// trace summary
// ---------------------------------------------------------------------------

interface TraceEvent { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { data?: { url?: string; functionName?: string }; name?: string } }

const KIND: Record<string, string> = {
  FunctionCall: 'script', EvaluateScript: 'script', 'v8.compile': 'compile', 'v8.compileModule': 'compile', CompileScript: 'compile', TimerFire: 'script',
  EventDispatch: 'script', FireAnimationFrame: 'script', RunMicrotasks: 'script', 'V8.Execute': 'script',
  UpdateLayoutTree: 'style', RecalculateStyles: 'style', ParseAuthorStyleSheet: 'style',
  Layout: 'layout', UpdateLayerTree: 'paint', Paint: 'paint', PrePaint: 'paint', Layerize: 'paint', Commit: 'paint', CompositeLayers: 'paint',
  ParseHTML: 'html-parse', MinorGC: 'gc', MajorGC: 'gc', 'V8.GC_SCAVENGER': 'gc', 'V8.GC_MARK_COMPACTOR': 'gc', BlinkGC: 'gc',
}

/** Self time per kind on every renderer main thread between `from` and `to` (trace µs). */
function summarizeTrace(events: TraceEvent[], from: number, to: number): { byKind: Record<string, number>; byChunk: Record<string, number>; byThread: Record<string, number> } {
  const mains = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`))
  const byKind: Record<string, number> = {}
  const byChunk: Record<string, number> = {}
  const byThread: Record<string, number> = {}
  const threads = new Map<string, TraceEvent[]>()
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`
    if (!mains.has(key) || event.ph !== 'X' || !event.dur || event.ts + event.dur < from || event.ts > to) continue
    let list = threads.get(key)
    if (!list) threads.set(key, list = [])
    list.push(event)
  }
  for (const [key, list] of threads) {
    list.sort((a, b) => a.ts - b.ts || b.dur! - a.dur!)
    // Self time: an event's duration minus the duration of its direct children.
    const stack: Array<{ event: TraceEvent; child: number }> = []
    const close = (entry: { event: TraceEvent; child: number }): void => {
      const self = entry.event.dur! - entry.child
      const kind = entry.event.name === 'RunTask' ? 'task-self' : KIND[entry.event.name] ?? `other:${entry.event.name}`
      byKind[kind] = (byKind[kind] ?? 0) + self
      if (entry.event.name === 'RunTask') byThread[key] = (byThread[key] ?? 0) + entry.event.dur!
      if (kind === 'script' || kind === 'compile') {
        const url = entry.event.args?.data?.url ?? ''
        const chunk = url.split('/').pop()?.replace(/-[\w-]{8}\.(m?js)$/, '') || '(no url)'
        byChunk[chunk] = (byChunk[chunk] ?? 0) + self
      }
    }
    for (const event of list) {
      while (stack.length && stack[stack.length - 1].event.ts + stack[stack.length - 1].event.dur! <= event.ts) close(stack.pop()!)
      if (stack.length) stack[stack.length - 1].child += event.dur!
      stack.push({ event, child: 0 })
    }
    while (stack.length) close(stack.pop()!)
  }
  const ms = (record: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, Math.round(v / 100) / 10]).sort((a, b) => b[1] - a[1]))
  return { byKind: ms(byKind), byChunk: ms(byChunk), byThread: ms(byThread) }
}

async function startTrace(cdp: CDPSession): Promise<void> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'blink', 'loading', '__metadata'] },
  })
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; hitCount?: number }
const assetSource = new Map<string, string>()

/** Self time of the hottest JS functions, each with a snippet of its minified source so it can be found in the code. */
/** The last JS profile, written beside the trace with --keep for phase analysis. */
let lastProfile: object | null = null

async function hotFunctions(cdp: CDPSession): Promise<Array<{ ms: number; fn: string; at: string; source: string; callers?: string[] }>> {
  const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: Array<ProfileNode & { children?: number[] }>; samples: number[]; timeDeltas: number[] } }
  lastProfile = profile
  const selfMs = new Map<number, number>()
  profile.samples.forEach((id, index) => selfMs.set(id, (selfMs.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000))
  const parentOf = new Map<number, number>()
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id)
  const keyOf = (frame: ProfileNode['callFrame']): string => `${frame.functionName}@${frame.url}:${frame.lineNumber}:${frame.columnNumber}`
  const sourceOf = (frame: ProfileNode['callFrame'], length: number): string => {
    const file = frame.url.split('/').pop() ?? ''
    if (!/\.m?js$/.test(file)) return ''
    const path = join(import.meta.dir, '../../dist/client/assets', file)
    if (!assetSource.has(file) && existsSync(path)) assetSource.set(file, readFileSync(path, 'utf8'))
    const lines = assetSource.get(file)?.split('\n') ?? []
    return (lines[frame.lineNumber] ?? '').slice(frame.columnNumber, frame.columnNumber + length)
  }
  const byFunction = new Map<string, { ms: number; frame: ProfileNode['callFrame']; callers: Map<string, number> }>()
  for (const node of profile.nodes) {
    const frame = node.callFrame
    if (!frame.url && ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(frame.functionName)) continue
    const entry = byFunction.get(keyOf(frame)) ?? { ms: 0, frame, callers: new Map() }
    const ms = selfMs.get(node.id) ?? 0
    entry.ms += ms
    // A function is named by the script that called it: a native read (layout,
    // style) by its caller, and a library function by the code that uses it.
    const parent = nodeById.get(parentOf.get(node.id) ?? -1)
    if (parent && ms > 0) {
      // The direct caller with its source, then up to five frames above it by name.
      const chain: string[] = []
      for (let up = nodeById.get(parentOf.get(parent.id) ?? -1); up && chain.length < 5; up = nodeById.get(parentOf.get(up.id) ?? -1)) {
        chain.push(`${up.callFrame.functionName || '(anonymous)'}@${up.callFrame.url.split('/').pop()}:${up.callFrame.lineNumber}:${up.callFrame.columnNumber}`)
      }
      const caller = `${parent.callFrame.url.split('/').pop()}:${parent.callFrame.lineNumber}:${parent.callFrame.columnNumber} ${sourceOf(parent.callFrame, 70)}${chain.length ? ` ⟵ ${chain.join(' ⟵ ')}` : ''}`
      entry.callers.set(caller, (entry.callers.get(caller) ?? 0) + ms)
    }
    byFunction.set(keyOf(frame), entry)
  }
  return [...byFunction.values()].sort((a, b) => b.ms - a.ms).slice(0, 25).map(({ ms, frame, callers }) => ({
    ms: Math.round(ms * 10) / 10,
    fn: frame.functionName || '(anonymous)',
    at: `${frame.url.split('/').pop() ?? ''}:${frame.lineNumber}:${frame.columnNumber}`,
    source: sourceOf(frame, 140),
    ...(callers.size ? { callers: [...callers].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([caller, callerMs]) => `${callerMs.toFixed(1)}ms ${caller}`) } : {}),
  }))
}

async function stopTrace(cdp: CDPSession): Promise<TraceEvent[]> {
  const complete = new Promise<string>((resolve) => cdp.once('Tracing.tracingComplete', (event) => resolve(event.stream!)))
  await cdp.send('Tracing.end')
  const stream = await complete
  let text = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream })
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  const parsed: { traceEvents: TraceEvent[] } | TraceEvent[] = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : parsed.traceEvents
}

// ---------------------------------------------------------------------------
// one open
// ---------------------------------------------------------------------------

function serverPageTimes(): Map<string, number[]> {
  const times = new Map<string, number[]>()
  if (!existsSync(devLog)) return times
  for (const line of readFileSync(devLog, 'utf8').split('\n')) {
    if (!line.includes('session_history_page_loaded')) continue
    const entry: { sessionId: string; durationMs: number } = JSON.parse(line)
    times.set(entry.sessionId, [...(times.get(entry.sessionId) ?? []), entry.durationMs])
  }
  return times
}

type OpenTrace = ReturnType<typeof summarizeTrace> & { hot: Awaited<ReturnType<typeof hotFunctions>> }
async function openOnce(page: Page, base: string, fixture: Fixture, cdp: CDPSession | null): Promise<{ sample: OpenSample; trace?: OpenTrace }> {
  // Forget the tabs the last open left, on a same-origin page the app does not run on.
  await page.goto(`${base}/health`)
  await page.evaluate(() => { for (const key of ['solus-open-tabs', 'solus-open-sidebar-tasks']) localStorage.removeItem(key) })
  await page.goto(`${base}/?skip-onboarding`)
  const row = page.locator(`[data-task-key="session:${fixture.sessionId}"]`).first()
  await row.waitFor({ timeout: OPEN_TIMEOUT_MS }).catch(async (error: Error) => {
    await page.screenshot({ path: join(root, `no-row-${fixture.key}.png`) })
    throw error
  })
  // Let boot work drain so it does not land inside the measured open.
  await page.waitForFunction((quietMs) => {
    const probe = Reflect.get(window, '__quiet') ?? { last: performance.now() }
    if (!Reflect.get(window, '__quiet')) {
      Reflect.set(window, '__quiet', probe)
      new MutationObserver(() => { probe.last = performance.now() }).observe(document.body, { subtree: true, childList: true, characterData: true })
    }
    return performance.now() - probe.last > quietMs
  }, 1500, { timeout: 30_000, polling: 100 })
  await page.evaluate(armOpenProbe, fixture.title)
  const serverBefore = serverPageTimes().get(fixture.sessionId)?.length ?? 0
  if (cdp) await startTrace(cdp)
  await row.evaluate((element) => { Reflect.set(window, '__clickedRow', element) })
  await row.click()

  // Settled: content painted, then nothing changed for QUIET_MS.
  await page.waitForFunction(({ quietMs }) => {
    const probe = Reflect.get(window, '__openProbe')
    return probe.contentPainted !== null && performance.now() - probe.lastMutation > quietMs
  }, { quietMs: QUIET_MS }, { timeout: OPEN_TIMEOUT_MS, polling: 50 }).catch(async (error: Error) => {
    const state = await page.evaluate(() => { const p = Reflect.get(window, '__openProbe'); return { ...p, now: performance.now(), longTasks: p.longTasks.length } })
    await page.screenshot({ path: join(root, `timeout-${fixture.key}.png`) })
    throw new Error(`${fixture.key}: ${error.message} ${JSON.stringify(state)}`)
  })

  // Frames that exist now must finish loading; their own scripts run after.
  const frames = await page.locator('.tab-slot:not(.tab-hidden) [data-testid="artifact-iframe"]').count()
  if (frames) {
    await page.waitForFunction((count) => Reflect.get(window, '__openProbe').frameLoads.length >= count, frames, { timeout: OPEN_TIMEOUT_MS, polling: 50 }).catch(() => {})
  }
  const result = await page.evaluate(() => {
    const probe = Reflect.get(window, '__openProbe')
    const elements = document.getElementsByTagName('*').length
    const turnsMounted = document.querySelectorAll('.tab-slot:not(.tab-hidden) .virtual-turn').length
    const rpcs = [...Reflect.get(window, '__rpcProbe').rpcs.values()].filter((rpc: Rpc) => rpc.start >= probe.t0)
    const measures: Record<string, { count: number; start: number; end: number }> = {}
    for (const entry of performance.getEntriesByType('measure')) {
      if (!entry.name.startsWith('solus.') || entry.startTime < probe.t0) continue
      const start = entry.startTime - probe.t0
      const end = start + entry.duration
      const span = measures[entry.name] ?? { count: 0, start, end }
      span.count++
      span.start = Math.min(span.start, start)
      span.end = Math.max(span.end, end)
      measures[entry.name] = span
    }
    const tooltip = document.querySelector('[data-tooltip-content]')
    const tooltipOpen = !!tooltip
    const tooltipText = tooltip?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? ''
    const clicked = Reflect.get(window, '__clickedRow')
    const rowReplaced = !(clicked instanceof Element && clicked.isConnected)
    return { probe, rpcs, elements, turnsMounted, tooltipOpen, tooltipText, rowReplaced, measures }
  })
  const { probe } = result
  const rpcs: Rpc[] = result.rpcs.map((rpc: Rpc) => ({ ...rpc, start: rpc.start - probe.t0, end: rpc.end === undefined ? undefined : rpc.end - probe.t0 }))
  const history = rpcs.find((rpc) => rpc.method === 'loadSessionPage' || rpc.method === 'loadSession')
  const settled = probe.lastMutation - probe.t0
  const tasks = probe.longTasks.filter((task: { start: number }) => task.start >= probe.t0 && task.start <= probe.lastMutation)
  let trace: (ReturnType<typeof summarizeTrace> & { hot: Awaited<ReturnType<typeof hotFunctions>> }) | undefined
  if (cdp) {
    const hot = await hotFunctions(cdp)
    const events = await stopTrace(cdp)
    // Align page time to trace time on the pointer event the click dispatched.
    const pointer = events.find((e) => e.name === 'EventDispatch' && (e.args?.data as { type?: string } | undefined)?.type === 'pointerdown')
    const from = pointer?.ts ?? 0
    trace = { ...summarizeTrace(events, from, from + Math.max(settled, ...probe.frameLoads.map((t: number) => t - probe.t0)) * 1000 + 300_000), hot }
    if (KEEP) {
      writeFileSync(join(root, `trace-${fixture.key}.json`), JSON.stringify(events))
      // Page times are after the pointer went down; the profile counts on the trace clock.
      writeFileSync(join(root, `profile-${fixture.key}.json`), JSON.stringify({
        pointerTs: from, profile: lastProfile,
        marks: { tabShown: probe.tabShown === null ? null : probe.tabShown - probe.t0, received: history?.end ?? null, painted: probe.contentPainted === null ? null : probe.contentPainted - probe.t0 },
      }))
    }
  }
  // The server logs a page read after it answers; give the log a moment.
  await Bun.sleep(50)
  const serverTimes = serverPageTimes().get(fixture.sessionId) ?? []
  return {
    sample: {
      fixture: fixture.key,
      tabShown: probe.tabShown === null ? null : probe.tabShown - probe.t0,
      historyRequested: history?.start ?? null,
      historyReceived: history?.end ?? null,
      contentPainted: probe.contentPainted === null ? null : probe.contentPainted - probe.t0,
      settled,
      artifactsLoaded: probe.frameLoads.length ? Math.max(...probe.frameLoads) - probe.t0 : null,
      frames,
      elements: result.elements,
      turnsMounted: result.turnsMounted,
      tooltipOpen: result.tooltipOpen,
      composerFocused: probe.composerFocused,
      measures: result.measures,
      tooltipText: result.tooltipText,
      rowReplaced: result.rowReplaced,
      longTasks: tasks.length,
      longestTask: Math.max(0, ...tasks.map((task: { duration: number }) => task.duration)),
      totalBlocking: tasks.reduce((sum: number, task: { duration: number }) => sum + Math.max(0, task.duration - 50), 0),
      historyBytes: history?.bytesIn ?? 0,
      historyWireBytes: history?.text ? deflateRawSync(history.text).length : 0,
      rpcs: rpcs.map(({ text: _text, ...rpc }) => rpc),
      serverPageMs: serverTimes.length > serverBefore ? serverTimes[serverTimes.length - 1] : null,
    },
    trace,
  }
}

/** Save each `render_artifact` work on the host, as the tool did, with the id
 *  its receipt names. The paired client's session token is the workspace API's bearer. */
async function createFixtureWorks(base: string, servers: string): Promise<void> {
  const [{ sessionToken }]: Array<{ sessionToken: string }> = JSON.parse(servers)
  for (const work of fixtures.flatMap((fixture) => fixture.works)) {
    const created = await fetch(`${base}/v1/works`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': work.workId },
      body: JSON.stringify({ id: work.workId, title: work.title, type: 'artifact', content: work.html }),
    })
    if (!created.ok) throw new Error(`work create failed: ${created.status} ${await created.text()}`)
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const p90 = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : NaN }

const { server, output } = startServer()
const browser = await chromium.launch()
try {
  const lock = await waitFor(() => existsSync(join(data, 'server.lock')) ? readFileSync(join(data, 'server.lock'), 'utf8') : null, 'server lock')
  const port: number = JSON.parse(lock).port
  const base = `http://127.0.0.1:${port}`
  const pairPath = await waitFor(() => /\/pair#token=\S+/.exec(output())?.[0], 'pair URL')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(installRpcProbe)
  // The app's mount and open-step measures are off unless this is set.
  await context.addInitScript(() => localStorage.setItem('solus.mount-timing', '1'))
  const page = await context.newPage()
  await page.goto(base + pairPath)
  await page.waitForFunction(() => (localStorage.getItem('solus.servers') ?? '').includes('sessionToken'), null, { timeout: 30_000 })
  await createFixtureWorks(base, await page.evaluate(() => localStorage.getItem('solus.servers') ?? '[]'))

  const samples: OpenSample[] = []
  const traces: Record<string, OpenTrace> = {}
  const cdp = TRACE || CPU_THROTTLE > 1 ? await context.newCDPSession(page) : null
  if (cdp && CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  // One untimed open loads the lazy chunks into the HTTP cache, as a running app has them.
  await openOnce(page, base, fixtures[0], null)
  for (let run = 0; run < RUNS; run++) {
    // Rotate the order so drift over the run does not favor one fixture.
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[(i + run) % fixtures.length]
      const traced = TRACE && run === 0
      const { sample, trace } = await openOnce(page, base, fixture, traced ? cdp : null)
      if (trace) traces[fixture.key] = trace
      else samples.push(sample)
      process.stderr.write(`${fixture.key} run ${run}: painted ${sample.contentPainted?.toFixed(0)} settled ${sample.settled?.toFixed(0)}${sample.artifactsLoaded ? ` frames ${sample.artifactsLoaded.toFixed(0)}` : ''}\n`)
    }
  }

  const summary = fixtures.map((fixture) => {
    const rows = samples.filter((sample) => sample.fixture === fixture.key)
    const stat = (pick: (sample: OpenSample) => number | null) => {
      const values = rows.map(pick).filter((value): value is number => value !== null)
      return { median: Math.round(median(values)), p90: Math.round(p90(values)) }
    }
    const methods = new Map<string, number[]>()
    for (const row of rows) for (const rpc of row.rpcs) if (rpc.end !== undefined) methods.set(rpc.method, [...(methods.get(rpc.method) ?? []), rpc.end - rpc.start])
    const waterfall = rows[0]?.rpcs.filter((rpc) => rpc.start < (rows[0].settled ?? 0))
      .map((rpc) => `${rpc.start.toFixed(0).padStart(5)} → ${rpc.end === undefined ? '  ...' : rpc.end.toFixed(0).padStart(5)}  ${rpc.method} (${(rpc.bytesIn / 1024).toFixed(1)} KB)`)
    return {
      fixture: fixture.key, fileMB: +(fixture.bytes / 1e6).toFixed(2), artifacts: fixture.artifacts,
      tabShown: stat((s) => s.tabShown), historyRequested: stat((s) => s.historyRequested), historyReceived: stat((s) => s.historyReceived),
      serverPageMs: stat((s) => s.serverPageMs), contentPainted: stat((s) => s.contentPainted), settled: stat((s) => s.settled),
      artifactsLoaded: stat((s) => s.artifactsLoaded), frames: median(rows.map((s) => s.frames)),
      elements: median(rows.map((s) => s.elements)), turnsMounted: median(rows.map((s) => s.turnsMounted)),
      longTasks: median(rows.map((s) => s.longTasks)), longestTask: stat((s) => s.longestTask), totalBlocking: stat((s) => s.totalBlocking),
      historyKB: Math.round(median(rows.map((s) => s.historyBytes)) / 1024),
      historyWireKB: Math.round(median(rows.map((s) => s.historyWireBytes)) / 1024),
      // Median span per measure name, in ms after the click, with the median count.
      measures: Object.fromEntries([...new Set(rows.flatMap((s) => Object.keys(s.measures)))].sort().map((name) => {
        const present = rows.filter((s) => s.measures[name])
        return [name, {
          count: median(present.map((s) => s.measures[name].count)),
          start: Math.round(median(present.map((s) => s.measures[name].start))),
          end: Math.round(median(present.map((s) => s.measures[name].end))),
        }]
      })),
      rpcMedianMs: Object.fromEntries([...methods].map(([method, values]) => [method, Math.round(median(values))]).sort((a, b) => Number(b[1]) - Number(a[1]))),
      waterfall,
      trace: traces[fixture.key],
    }
  })

  for (const row of summary) {
    console.log(`\n## ${row.fixture} (${row.fileMB} MB, ${row.artifacts} artifacts)`)
    console.log(`  tab shown        ${row.tabShown.median} ms (p90 ${row.tabShown.p90})`)
    console.log(`  history request  ${row.historyRequested.median} → ${row.historyReceived.median} ms, ${row.historyKB} KB (${row.historyWireKB} KB on the wire), server page ${row.serverPageMs.median} ms`)
    console.log(`  content painted  ${row.contentPainted.median} ms (p90 ${row.contentPainted.p90})`)
    console.log(`  settled          ${row.settled.median} ms (p90 ${row.settled.p90})`)
    if (row.artifacts) console.log(`  frames loaded    ${row.artifactsLoaded.median} ms (p90 ${row.artifactsLoaded.p90}), ${row.frames} frames`)
    console.log(`  DOM              ${row.elements} elements, ${row.turnsMounted} turns mounted`)
    console.log(`  timeline (ms)    ${Object.entries(row.measures).sort((a, b) => a[1].start - b[1].start).map(([name, m]) => `${name.replace(/^solus\./, '')} ${m.start}→${m.end} ×${m.count}`).join('  ')}`)
    console.log(`  long tasks       ${row.longTasks} (longest ${row.longestTask.median} ms, blocking ${row.totalBlocking.median} ms)`)
    console.log(`  RPC waterfall (first run):\n    ${row.waterfall?.join('\n    ')}`)
    if (row.trace) console.log(`  main thread by kind (ms): ${JSON.stringify(Object.fromEntries(Object.entries(row.trace.byKind).slice(0, 12)))}\n  script by chunk (ms): ${JSON.stringify(Object.fromEntries(Object.entries(row.trace.byChunk).slice(0, 10)))}\n  renderer threads busy (ms): ${JSON.stringify(row.trace.byThread)}`)
  }
  // The goal (session-open-goal.json): every fixture meets every limit for this CPU profile.
  const goal: { client: Record<string, Record<string, number>> } = JSON.parse(readFileSync(join(import.meta.dir, 'session-open-goal.json'), 'utf8'))
  const limits = goal.client[String(CPU_THROTTLE)]
  if (limits) {
    let misses = 0
    console.log(`\n## goal at ${CPU_THROTTLE}x CPU (median)`)
    for (const row of summary) {
      const values: Record<string, number | null> = {
        historyRequested: row.historyRequested.median, contentPainted: row.contentPainted.median,
        artifactsLoaded: row.frames ? row.artifactsLoaded.median : null, longestTask: row.longestTask.median,
        totalBlocking: row.totalBlocking.median, historyWireKB: row.historyWireKB,
      }
      const missed = Object.entries(limits).filter(([metric, limit]) => values[metric] !== null && values[metric]! > limit)
        .map(([metric, limit]) => `${metric} ${values[metric]} > ${limit}`)
      misses += missed.length
      console.log(`  ${row.fixture.padEnd(16)} ${missed.length ? `MISS  ${missed.join(', ')}` : 'MET'}`)
    }
    console.log(misses ? `  ${misses} limits missed` : '  every limit met')
  }
  const out = join(import.meta.dir, `session-open-${LABEL}.json`)
  writeFileSync(out, JSON.stringify({ label: LABEL, cpuThrottle: CPU_THROTTLE, recorded: new Date().toISOString(), runs: RUNS, summary, samples }, null, 2))
  console.log(`\nwrote ${out}`)
} finally {
  await browser.close()
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
