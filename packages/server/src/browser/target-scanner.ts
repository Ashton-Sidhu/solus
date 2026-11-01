import { gitOutputPath, runAsync } from '../git/exec'
import { resolveRepoRoot } from '../git/git-helpers'
import { createLogger } from '../logger'
import type { BrowserDiscoveredTarget } from '@solus/contracts/browser-types'

const log = createLogger('browser', 'target-scanner.ts')

/**
 * Read-only discovery of running dev servers, offered as browser targets.
 *
 * Solus does not own these processes — the boot layer waits for the integrated
 * terminal (see `docs/plans/cross-platform-visual-qa.md` §5). So this never
 * spawns anything: it reads the listening sockets the OS already has, asks each
 * owner where it is working, and probes the port to confirm it serves HTML
 * before offering it. A port that answers with JSON is an API, not a browser.
 *
 * The probe is an HTTP request to someone else's process, and Redis, Postgres,
 * or a game engine on that port reads it as junk. So each listener is probed
 * once for its lifetime (see `ProbeVerdicts`), not once per scan.
 */

/** Ports below this are system services, never a dev server worth offering. */
const MIN_PORT = 1024
/** The probe must not hang the pane behind a wedged server. */
const PROBE_TIMEOUT_MS = 1500
/** Redirect chains longer than this are a loop, not a dev server. */
const MAX_REDIRECTS = 3
/** A scan shells out three times; the pane re-asks on every open and event. */
const CACHE_TTL_MS = 4000
/** A timed-out probe may be a dev server that bound its port before it was
 *  ready, so it is asked again after this long. Every other answer is final. */
const TIMEOUT_RETRY_MS = 30_000

export interface Listener {
  pid: number
  port: number
  command: string
}

/** What a probe learned about one listener. `other` is any answer that is not
 *  HTML: JSON, a closed socket, a protocol error — a service that is not a page. */
export type ProbeResult = { kind: 'html'; title?: string } | { kind: 'other' } | { kind: 'timeout' }

/**
 * The probe verdict of each listener, keyed by its process and port, so a
 * process's port is probed at most once while it lives. A timeout is the one
 * exception: it is asked again after `TIMEOUT_RETRY_MS`. A listener that is no
 * longer in the socket list loses its verdict, which keeps the map bounded and
 * lets a new process on the same port be probed fresh. Exported for its test.
 */
export class ProbeVerdicts {
  private readonly verdicts = new Map<string, { result: ProbeResult; at: number }>()

  constructor(private readonly probe: (port: number) => Promise<ProbeResult>) {}

  /** The verdict of each listener, in order. Probes only the ones without one. */
  async verdictsFor(listeners: Listener[], now = Date.now()): Promise<ProbeResult[]> {
    const live = new Set(listeners.map(verdictKey))
    for (const key of this.verdicts.keys()) {
      if (!live.has(key)) this.verdicts.delete(key)
    }
    return Promise.all(listeners.map(async (listener) => {
      const key = verdictKey(listener)
      const known = this.verdicts.get(key)
      if (known && (known.result.kind !== 'timeout' || now - known.at < TIMEOUT_RETRY_MS)) return known.result
      const result = await this.probe(listener.port)
      this.verdicts.set(key, { result, at: now })
      return result
    }))
  }
}

function verdictKey(listener: Listener): string {
  return `${listener.pid}:${listener.port}`
}

const probeVerdicts = new ProbeVerdicts((port) => probeForHtml(port))
let cache: { at: number; targets: BrowserDiscoveredTarget[] } | null = null
let inFlight: Promise<BrowserDiscoveredTarget[]> | null = null

/** Invalidate the scan cache — used when something already knows the world
 *  moved. The socket list is read again; known listeners are not re-probed. */
export function forgetDiscoveredTargets(): void {
  cache = null
}

export async function discoverBrowserTargets(): Promise<BrowserDiscoveredTarget[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.targets
  if (inFlight) return inFlight

  inFlight = scan()
    .then((targets) => {
      cache = { at: Date.now(), targets }
      return targets
    })
    .catch((err) => {
      log.warn('browser_scan_failed', { error: err instanceof Error ? err.message : String(err) })
      return []
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Every HTML-serving port above the system range, Solus's own included: a
 *  user who wants to look at the Solus client in a Solus pane is allowed to. */
async function scan(): Promise<BrowserDiscoveredTarget[]> {
  const listeners = (await listListeningSockets()).filter((listener) => listener.port >= MIN_PORT)
  if (listeners.length === 0) return []

  const cwdByPid = await workingDirectories([...new Set(listeners.map((listener) => listener.pid))])
  // One offer per port: a Node server binds both IPv4 and IPv6 and lsof reports
  // each, which would otherwise show the same dev server twice in the picker.
  const byPort = new Map<number, Listener>()
  for (const listener of listeners) {
    if (!byPort.has(listener.port)) byPort.set(listener.port, listener)
  }

  const unique = [...byPort.values()]
  const verdicts = await probeVerdicts.verdictsFor(unique)
  const targets: BrowserDiscoveredTarget[] = []
  unique.forEach((listener, index) => {
    const verdict = verdicts[index]
    if (verdict.kind !== 'html') return
    const target: BrowserDiscoveredTarget = {
      url: `http://localhost:${listener.port}/`,
      port: listener.port,
      pid: listener.pid,
      cwd: cwdByPid.get(listener.pid) ?? '',
    }
    if (verdict.title) target.title = verdict.title
    targets.push(target)
  })
  await Promise.all(targets.map((target) => attributeToWorktree(target)))
  return targets.sort((a, b) => a.port - b.port)
}

/**
 * `lsof -F` emits one field per line, prefixed by its type, grouped under the
 * process that owns them. Parsing the field format rather than the human table
 * is what makes the port and pid unambiguous regardless of column widths.
 */
async function listListeningSockets(): Promise<Listener[]> {
  if (process.platform === 'win32') return listWindowsListeners()
  let output: string
  try {
    output = await runAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], process.cwd(), { timeout: 5000 })
  } catch {
    // No lsof (or no permission to read other processes): discovery degrades to
    // manual URL entry, which is a supported path rather than an error.
    return []
  }

  const listeners: Listener[] = []
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    const kind = line[0]
    const value = line.slice(1)
    if (kind === 'p') {
      pid = Number(value) || 0
      command = ''
    } else if (kind === 'c') {
      command = value
    } else if (kind === 'n' && pid) {
      const port = portFromSocketName(value)
      if (port) listeners.push({ pid, port, command })
    }
  }
  return listeners
}

/**
 * Windows has no lsof. `netstat -ano` lists every TCP socket with its owner's
 * process id; IPv4 and IPv6 are asked for separately, at the same time.
 */
async function listWindowsListeners(): Promise<Listener[]> {
  const tables = await Promise.all(['tcp', 'tcpv6'].map((protocol) =>
    runAsync('netstat', ['-ano', '-p', protocol], process.cwd(), { timeout: 5000 }).catch(() => '')))
  return tables.flatMap(windowsListeners)
}

/**
 * The listening sockets in `netstat -ano` output. The state column is
 * translated (`LISTENING`, `ABHÖREN`, `À l'écoute`), so a listener is read by
 * its foreign address instead, which is `0.0.0.0:0` or `[::]:0` in every
 * language. Exported for its test.
 */
export function windowsListeners(output: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== 'TCP' || fields.length < 4) continue
    if (fields[2] !== '0.0.0.0:0' && fields[2] !== '[::]:0') continue
    const port = portFromSocketName(fields[1])
    const pid = Number(fields[fields.length - 1])
    if (port && Number.isInteger(pid) && pid > 0) listeners.push({ pid, port, command: '' })
  }
  return listeners
}

/** `*:5173`, `127.0.0.1:5173`, `[::1]:5173` — the port is after the last colon. */
function portFromSocketName(name: string): number | null {
  const colon = name.lastIndexOf(':')
  if (colon === -1) return null
  const port = Number(name.slice(colon + 1))
  return Number.isInteger(port) && port > 0 ? port : null
}

async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  // Windows has no cheap way to read another process's working directory, so a
  // Windows offer names its port and no project; the client handles that.
  if (pids.length === 0 || process.platform === 'win32') return result
  let output: string
  try {
    output = await runAsync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], process.cwd(), { timeout: 5000 })
  } catch {
    return result
  }
  let pid = 0
  for (const line of output.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0
    else if (line[0] === 'n' && pid) result.set(pid, line.slice(1))
  }
  return result
}

/**
 * Confirm a port serves a page before offering it. Any status counts — dev
 * servers legitimately 404 at `/` when the app is mounted elsewhere — but the
 * content type must be HTML, which is what separates the app from its API.
 */
async function probeForHtml(port: number, path = '/', redirects = 0): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects >= MAX_REDIRECTS) return { kind: 'other' }
      const next = location.startsWith('http') ? new URL(location).pathname : location
      return probeForHtml(port, next, redirects + 1)
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return { kind: 'other' }
    const title = titleOf(await response.text())
    return title ? { kind: 'html', title } : { kind: 'html' }
  } catch {
    // A non-HTTP service closes the socket or answers in its own protocol; only
    // a probe we aborted ourselves is a timeout.
    return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'other' }
  } finally {
    clearTimeout(timer)
  }
}

function titleOf(html: string): string | undefined {
  const match = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)
  return match?.[1].trim() || undefined
}

/**
 * Name the target by the checkout it is serving. This is what makes several
 * worktrees of one project legible in the page strip instead of a row of ports.
 */
async function attributeToWorktree(target: BrowserDiscoveredTarget): Promise<void> {
  if (!target.cwd) return
  try {
    const toplevel = await runAsync('git', ['rev-parse', '--show-toplevel'], target.cwd, { timeout: 5000 })
    if (!toplevel) return
    const worktreePath = gitOutputPath(target.cwd, toplevel)
    target.worktreePath = worktreePath
    const branch = await runAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, { timeout: 5000 })
    if (branch && branch !== 'HEAD') target.branch = branch
    const projectRoot = await resolveRepoRoot(worktreePath)
    if (projectRoot) target.projectRoot = projectRoot
  } catch {
    // A dev server outside a repository is still a valid target; it just has no
    // worktree label.
  }
}
