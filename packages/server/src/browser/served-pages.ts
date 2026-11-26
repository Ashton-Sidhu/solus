import type { BrowserCloseResult } from '@solus/contracts/browser-types'
import type { RunningServer } from '@solus/contracts/running-servers'
import { runningServers } from '../host/running-servers/registry'
import { createLogger } from '../logger'
import { browserRegistry } from './browser-registry'

const log = createLogger('browser', 'served-pages.ts')

const CHECK_INTERVAL_MS = 3000
/** How long a stopped server has to listen again before its page closes. An
 *  agent often stops a dev server and starts it again; that is not a close. */
export const SERVER_RETURN_GRACE_MS = 15_000

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/** One page an agent opened on a dev server that the same session started. */
interface ServedPage {
  sessionId: string
  port: number
  pid: number
  /** When the server process was first seen gone, or null while it runs. */
  goneAt: number | null
}

export interface ServedPagesDeps {
  /** A fresh scan of the running servers on this host. */
  servers: () => Promise<RunningServer[]>
  isAlive: (pid: number) => boolean
  /** The current address of a page, or null when the page is gone. */
  pageUrl: (browserPageId: string) => string | null
  close: (browserPageId: string) => Promise<BrowserCloseResult>
  now: () => number
  schedule: (tick: () => Promise<void>, delayMs: number) => () => void
}

/**
 * The in-memory link from a browser page to the dev server it shows, for pages
 * an agent opened on a server its own session started. When that server stops
 * and does not listen again within the grace, the page closes. A page the user
 * opened, a server another session started, and a page in agent use stay open.
 * Nothing is saved: after a host restart, no page is linked.
 */
export class ServedPages {
  private readonly links = new Map<string, ServedPage>()
  private cancelCheck: (() => void) | null = null

  constructor(private readonly deps: ServedPagesDeps) {}

  /** Link a page the agent of `sessionId` just opened, if its own server serves it. */
  async follow(browserPageId: string, url: string, sessionId: string): Promise<void> {
    const port = loopbackPort(url)
    if (port === null) return
    let servers: RunningServer[]
    try { servers = await this.deps.servers() } catch (error) {
      log.warn('browser_served_page_scan_failed', { browserPageId, error: String(error) })
      return
    }
    const server = serverOf(servers, port, sessionId)
    if (!server || this.deps.pageUrl(browserPageId) === null) return
    this.links.set(browserPageId, { sessionId, port, pid: server.process.pid, goneAt: null })
    log.info('browser_served_page_linked', { browserPageId, sessionId, port, pid: server.process.pid })
    this.scheduleCheck()
  }

  private scheduleCheck(): void {
    if (this.cancelCheck || !this.links.size) return
    this.cancelCheck = this.deps.schedule(async () => {
      this.cancelCheck = null
      try { await this.check() } finally { this.scheduleCheck() }
    }, CHECK_INTERVAL_MS)
  }

  private async check(): Promise<void> {
    const expired: [string, ServedPage][] = []
    for (const [browserPageId, link] of this.links) {
      const url = this.deps.pageUrl(browserPageId)
      // The page closed, or now shows another site: the link no longer means anything.
      if (url === null || showsOtherSite(url, link.port)) {
        this.links.delete(browserPageId)
        continue
      }
      // A PID reused within one interval hides a stop; the next scan does not see it either.
      if (link.goneAt === null && !this.deps.isAlive(link.pid)) link.goneAt = this.deps.now()
      if (link.goneAt !== null && this.deps.now() - link.goneAt >= SERVER_RETURN_GRACE_MS) expired.push([browserPageId, link])
    }
    if (!expired.length) return
    let servers: RunningServer[]
    try { servers = await this.deps.servers() } catch (error) {
      log.warn('browser_served_page_scan_failed', { error: String(error) })
      return
    }
    for (const [browserPageId, link] of expired) {
      const restarted = serverOf(servers, link.port, link.sessionId)
      if (restarted) {
        link.pid = restarted.process.pid
        link.goneAt = null
        log.info('browser_served_page_relinked', { browserPageId, sessionId: link.sessionId, port: link.port, pid: link.pid })
        continue
      }
      // An agent at work in the page refuses the close; the next check asks again.
      const result = await this.deps.close(browserPageId)
      if (!result.closed) continue
      this.links.delete(browserPageId)
      log.info('browser_served_page_closed', { browserPageId, sessionId: link.sessionId, port: link.port })
    }
  }
}

function loopbackPort(url: string): number | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
}

/** An error page or a blank page during a failed load is not another site. */
function showsOtherSite(url: string, port: number): boolean {
  if (!/^https?:/.test(url)) return false
  return loopbackPort(url) !== port
}

function serverOf(servers: RunningServer[], port: number, sessionId: string): RunningServer | undefined {
  return servers.find((server) => server.startedBy.kind === 'agent'
    && server.startedBy.sessionId === sessionId
    && server.endpoints.some((endpoint) => endpoint.port === port))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

let served: ServedPages | null = null

/** One link table per host process, made on the first agent open. */
export function servedPages(): ServedPages {
  served ??= new ServedPages({
    servers: () => runningServers().list(true),
    isAlive,
    pageUrl: (browserPageId) => browserRegistry().get(browserPageId)?.url ?? null,
    close: (browserPageId) => browserRegistry().close(browserPageId),
    now: Date.now,
    schedule: (tick, delayMs) => {
      const timer = setTimeout(() => void tick(), delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    },
  })
  return served
}
