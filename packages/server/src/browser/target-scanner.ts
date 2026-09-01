import { runAsync } from '../git/exec'
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
 */

/** Ports below this are system services, never a dev server worth offering. */
const MIN_PORT = 1024
/** The probe must not hang the pane behind a wedged server. */
const PROBE_TIMEOUT_MS = 1500
/** Redirect chains longer than this are a loop, not a dev server. */
const MAX_REDIRECTS = 3
/** A scan shells out three times; the pane re-asks on every open and event. */
const CACHE_TTL_MS = 4000

interface Listener {
  pid: number
  port: number
  command: string
}

let cache: { at: number; targets: BrowserDiscoveredTarget[] } | null = null
let inFlight: Promise<BrowserDiscoveredTarget[]> | null = null

/** Invalidate the cache — used when something already knows the world moved. */
export function forgetDiscoveredTargets(): void {
  cache = null
}

export async function discoverBrowserTargets(options: { excludePorts?: number[] } = {}): Promise<BrowserDiscoveredTarget[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.targets
  if (inFlight) return inFlight

  inFlight = scan(new Set(options.excludePorts ?? []))
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

async function scan(excluded: Set<number>): Promise<BrowserDiscoveredTarget[]> {
  const listeners = (await listListeningSockets()).filter(
    (listener) => listener.port >= MIN_PORT && !excluded.has(listener.port) && listener.pid !== process.pid,
  )
  if (listeners.length === 0) return []

  const cwdByPid = await workingDirectories([...new Set(listeners.map((listener) => listener.pid))])
  // One offer per port: a Node server binds both IPv4 and IPv6 and lsof reports
  // each, which would otherwise show the same dev server twice in the picker.
  const byPort = new Map<number, Listener>()
  for (const listener of listeners) {
    if (!byPort.has(listener.port)) byPort.set(listener.port, listener)
  }

  const probed = await Promise.all(
    [...byPort.values()].map(async (listener) => {
      const html = await probeForHtml(listener.port)
      if (!html) return null
      const target: BrowserDiscoveredTarget = {
        url: `http://localhost:${listener.port}/`,
        port: listener.port,
        pid: listener.pid,
        cwd: cwdByPid.get(listener.pid) ?? '',
      }
      if (html.title) target.title = html.title
      return target
    }),
  )

  const targets = probed.filter((target): target is BrowserDiscoveredTarget => target !== null)
  await Promise.all(targets.map((target) => attributeToWorktree(target)))
  return targets.sort((a, b) => a.port - b.port)
}

/**
 * `lsof -F` emits one field per line, prefixed by its type, grouped under the
 * process that owns them. Parsing the field format rather than the human table
 * is what makes the port and pid unambiguous regardless of column widths.
 */
async function listListeningSockets(): Promise<Listener[]> {
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

/** `*:5173`, `127.0.0.1:5173`, `[::1]:5173` — the port is after the last colon. */
function portFromSocketName(name: string): number | null {
  const colon = name.lastIndexOf(':')
  if (colon === -1) return null
  const port = Number(name.slice(colon + 1))
  return Number.isInteger(port) && port > 0 ? port : null
}

async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  if (pids.length === 0) return result
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
async function probeForHtml(port: number, path = '/', redirects = 0): Promise<{ title?: string } | null> {
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
      if (!location || redirects >= MAX_REDIRECTS) return null
      const next = location.startsWith('http') ? new URL(location).pathname : location
      return probeForHtml(port, next, redirects + 1)
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return null
    const title = titleOf(await response.text())
    return title ? { title } : {}
  } catch {
    return null
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
    const worktreePath = await runAsync('git', ['rev-parse', '--show-toplevel'], target.cwd, { timeout: 5000 })
    if (!worktreePath) return
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
