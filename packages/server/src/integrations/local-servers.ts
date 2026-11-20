import { basename } from 'node:path'
import { z } from 'zod'
import type { FoundServerList, Integration } from '@solus/contracts/integration-types'
import { loopbackServerPort, type FoundPortPlace, type IntegrationReachable } from '@solus/contracts/integrations/local-servers'
import type { RunningServer, ServerEndpoint } from '@solus/contracts/running-servers'
import type { RunningServerRegistry, RunningServerScan } from '../host/running-servers/registry'
import { createLogger } from '../logger'
import type { IntegrationGateway } from './gateway'

const log = createLogger('integrations', 'local-servers.ts')

/** One request waits at most this long (docs/plans/mcp-first-class.md §9.1). */
const PROBE_TIMEOUT_MS = 1500
/** At most this much of one answer is read. */
const MAX_ANSWER_BYTES = 16 * 1024
/** At most this many requests run at one time on the host. */
const MAX_PROBES = 4
/**
 * A running-servers list this old still tells whether a port has a listener
 * (§9.3). The registry scans each 3 seconds while a client holds a lease, and a
 * client renews its lease each 8 seconds.
 */
const FRESH_MS = 10_000
/** The two loopback addresses the running-servers list gives a listener; a wildcard listener is reached on these. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])
/** The body of the one request: `server/discover` of revision 2026-07-28, with no credential. */
const DISCOVER_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'server/discover',
  params: { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'solus', version: '1.0.0' },
  } },
})

/** What one request learned: an MCP server, with what it said about itself, or not one. */
export type LocalProbeAnswer = { isMcp: true; serverInfo?: FoundPortPlace['serverInfo'] } | { isMcp: false }
/** Sends the one `server/discover` request to a loopback URL. Tests give a fake. */
export type LocalProbe = (target: URL) => Promise<LocalProbeAnswer>

/** An MCP server that runs on the host's loopback now: the address that answered, and where it is. */
export interface RunningMcpServer {
  url: string
  place: FoundPortPlace
}

/** One HTTP endpoint of a running server that may be checked, and the paths that may get a request. */
interface Candidate {
  key: string
  server: RunningServer
  endpoint: ServerEndpoint
  origin: string
  paths: string[]
}

type Verdict =
  | { state: 'checking'; port: number; serverId: string; done: Promise<void> }
  | { state: 'mcp'; port: number; serverId: string; url: string; serverInfo?: FoundPortPlace['serverInfo'] }
  | { state: 'not-mcp'; port: number; serverId: string }

type Scan = { at: number; servers: RunningServer[]; listeningPorts: ReadonlySet<number> } | { at: number; error: string }

/** Whether a port has a listener in the newest list, and which listed process holds it. */
interface PortState {
  reachable: IntegrationReachable
  holder: string | null
}

type ServerInfo = NonNullable<FoundPortPlace['serverInfo']>

export interface LocalMcpServersDeps {
  /** Every integration on this host, of every owner: a listener that comes back changes each one on its port. */
  integrations: () => Integration[]
  gateway: Pick<IntegrationGateway, 'invalidate' | 'askForCustomServer'>
  /** Tells clients to read an integration's facts again (`integration.changed`, `change: 'facts'`). */
  factsChanged: (integrationId: string) => void
  probe?: LocalProbe
  now?: () => number
}

/**
 * The MCP servers that run on this host's loopback (docs/plans/mcp-first-class.md
 * §9). It follows the running-servers registry and adds no timer or scan of its
 * own: a scan runs only while a client holds a running-servers lease, or when a
 * person reads Found on this host. The registry learns nothing about MCP.
 *
 * Do no harm to other processes. A request goes only to an endpoint the list
 * already knows as HTTP (a Server URL that answered), on 127.0.0.1 or ::1. Each
 * endpoint of one process gets at most two `server/discover` requests in its
 * life: `POST /mcp`, and `POST /` only when its `GET /` did not answer with
 * HTML; an endpoint with a path gets one, to that path. No `initialize`
 * follows: a server of revision 2025 answers `server/discover` with a JSON-RPC
 * error, and that already says MCP. No credential, no redirect, 1.5 seconds,
 * 16 KB, and four requests at one time. The answer, "not MCP" and a timeout
 * too, is kept until the process lets go of its port or another process holds
 * it, so no refresh sends a request again.
 */
export class LocalMcpServers {
  private readonly verdicts = new Map<string, Verdict>()
  private scan: Scan | null = null
  private running = 0
  private readonly queue: Array<() => void> = []
  /** Null until the host's running-servers list exists, and where it has none. */
  private registry: Pick<RunningServerRegistry, 'list' | 'observeScans'> | null = null
  private stopObserving: () => void = () => undefined

  constructor(private readonly deps: LocalMcpServersDeps) {}

  /** Follows the scans of the host's running-servers list from now on. */
  follow(registry: Pick<RunningServerRegistry, 'list' | 'observeScans'>): void {
    this.stopObserving()
    this.registry = registry
    this.stopObserving = registry.observeScans((scan) => this.scanned(scan))
  }

  /**
   * The MCP servers that run on the loopback now (§9.2), after the checks of
   * the newest list end. A person who reads the list is a client that looks, so
   * a list older than the freshness limit is read again: one scan, no timer.
   */
  async runningNow(): Promise<{ servers: RunningMcpServer[]; portScan: NonNullable<FoundServerList['portScan']> }> {
    if (!this.registry) return { servers: [], portScan: { state: 'unavailable', reason: 'This host has no list of its running servers.' } }
    if (!this.isFresh()) {
      try {
        // Its scan reaches `scanned` through the observer.
        await this.registry.list()
      } catch (error) {
        this.scanned({ at: this.now(), error: error instanceof Error ? error.message : String(error) })
      }
    }
    await Promise.all([...this.verdicts.values()].flatMap((verdict) => verdict.state === 'checking' ? [verdict.done] : []))
    const scan = this.scan
    if (!scan || 'error' in scan) return { servers: [], portScan: { state: 'unavailable', reason: scan && 'error' in scan ? scan.error : 'This host did not list its running servers.' } }
    return { servers: this.runningIn(scan.servers), portScan: { state: 'ready' } }
  }

  /**
   * Whether the server of a loopback integration runs (§9.3), derived from the
   * newest list and never saved. Undefined for any other address.
   */
  reachable(integration: Pick<Integration, 'kind' | 'url'>): IntegrationReachable | undefined {
    const port = integration.kind === 'mcp' ? loopbackServerPort(integration.url) : null
    return port === null ? undefined : this.portState(port).reachable
  }

  stop(): void {
    this.stopObserving()
    this.verdicts.clear()
  }

  private scanned(scan: RunningServerScan): void {
    const before = this.loopbackStates()
    this.scan = scan
    if (!('error' in scan)) {
      const holders = portHolders(scan.servers)
      // A process that let go of its port, or a port another process holds now: its answer goes (§9.1).
      for (const [key, verdict] of this.verdicts) {
        const holder = holders.get(verdict.port)
        if (!scan.listeningPorts.has(verdict.port) || (holder && holder !== verdict.serverId)) this.verdicts.delete(key)
      }
      for (const candidate of candidatesOf(scan.servers)) {
        if (!this.verdicts.has(candidate.key)) this.check(candidate)
      }
    }
    this.followIntegrations(before)
  }

  /**
   * A loopback integration whose state changed gets a facts event, so an open
   * row says it at once. When its port has a listener again, or another process
   * holds it, the gateway drops its sessions and lists: the next run lists the
   * tools of the server that runs now (§9.3).
   */
  private followIntegrations(before: Map<string, PortState>): void {
    for (const [integrationId, now] of this.loopbackStates()) {
      const was = before.get(integrationId)
      if (was && was.reachable === now.reachable && was.holder === now.holder) continue
      const cameBack = now.reachable === 'running' && (was?.reachable === 'not-running' || (!!was?.holder && !!now.holder && was.holder !== now.holder))
      if (cameBack) {
        this.deps.gateway.invalidate(integrationId)
        log.info('integration_local_server_back', { integrationId })
      }
      this.deps.factsChanged(integrationId)
    }
  }

  private loopbackStates(): Map<string, PortState> {
    const states = new Map<string, PortState>()
    for (const integration of this.deps.integrations()) {
      const port = integration.kind === 'mcp' ? loopbackServerPort(integration.url) : null
      if (port !== null) states.set(integration.id, this.portState(port))
    }
    return states
  }

  private portState(port: number): PortState {
    const scan = this.scan
    if (!scan || 'error' in scan || !this.isFresh()) return { reachable: 'unknown', holder: null }
    if (!scan.listeningPorts.has(port)) return { reachable: 'not-running', holder: null }
    return { reachable: 'running', holder: portHolders(scan.servers).get(port) ?? null }
  }

  private isFresh(): boolean {
    return this.scan !== null && this.now() - this.scan.at <= FRESH_MS
  }

  /** The MCP endpoints of the servers in a list, with the place each shows. */
  private runningIn(servers: RunningServer[]): RunningMcpServer[] {
    return servers.flatMap((server) => server.endpoints.flatMap((endpoint) => {
      const verdict = this.verdicts.get(keyOf(server, endpoint))
      return verdict?.state === 'mcp' ? [{ url: verdict.url, place: placeOf(server, endpoint, verdict.serverInfo) }] : []
    }))
  }

  private check(candidate: Candidate): void {
    const entry: Verdict = { state: 'checking', port: candidate.endpoint.port, serverId: candidate.server.serverId, done: Promise.resolve() }
    this.verdicts.set(candidate.key, entry)
    entry.done = this.verdictOf(candidate).then((verdict) => {
      // The process let go of its port while it was checked.
      if (this.verdicts.get(candidate.key) !== entry) return
      this.verdicts.set(candidate.key, verdict)
      log.info('integration_local_server_checked', { port: candidate.endpoint.port, isMcp: verdict.state === 'mcp' })
      if (verdict.state === 'mcp') this.offerToSession(candidate, verdict.url, verdict.serverInfo)
    })
  }

  /** The requests of one endpoint, one after the other; the first MCP answer ends them. */
  private async verdictOf(candidate: Candidate): Promise<Verdict> {
    const at = { port: candidate.endpoint.port, serverId: candidate.server.serverId }
    for (const path of candidate.paths) {
      const target = new URL(path, candidate.origin)
      const answer = await this.inSlot(() => (this.deps.probe ?? discoverOnLoopback)(target)).catch((): LocalProbeAnswer => ({ isMcp: false }))
      if (answer.isMcp) return { state: 'mcp', ...at, url: target.href, serverInfo: answer.serverInfo }
    }
    return { state: 'not-mcp', ...at }
  }

  /**
   * An MCP server that an agent started raises the custom server card in its
   * session, once for the process and endpoint (§9.4). The person adds it; an
   * agent never adds an address by itself.
   */
  private offerToSession(candidate: Candidate, url: string, serverInfo: FoundPortPlace['serverInfo']): void {
    const startedBy = candidate.server.startedBy
    if (startedBy.kind !== 'agent' || !startedBy.sessionId) return
    if (this.deps.integrations().some((integration) => integration.kind === 'mcp' && sameLocalAddress(integration.url, url))) return
    this.deps.gateway.askForCustomServer({ sessionId: startedBy.sessionId, name: serverInfo?.title ?? serverInfo?.name ?? candidate.server.process.name, url })
  }

  private async inSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PROBES) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.running++
    try {
      return await work()
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** The same server on the host's loopback: the same port, path, and query, whatever loopback name each uses. */
export function sameLocalAddress(a: string, b: string): boolean {
  const port = loopbackServerPort(a)
  if (port === null || port !== loopbackServerPort(b)) return false
  const path = (url: string) => {
    const parsed = new URL(url)
    return `${parsed.pathname.replace(/\/+$/, '') || '/'}${parsed.search}`
  }
  return path(a) === path(b)
}

/** The endpoints a request may go to: known as HTTP by the list, on a loopback address. */
function candidatesOf(servers: RunningServer[]): Candidate[] {
  return servers.flatMap((server) => server.endpoints.flatMap((endpoint): Candidate[] => {
    if (endpoint.response?.protocol !== 'http' || !LOOPBACK_ADDRESSES.has(endpoint.address) || !URL.canParse(endpoint.url)) return []
    const named = new URL(endpoint.url)
    const path = `${named.pathname}${named.search}`
    const isPage = endpoint.response.contentType?.toLowerCase().includes('text/html') ?? false
    const host = endpoint.address.includes(':') ? `[${endpoint.address}]` : endpoint.address
    return [{
      key: keyOf(server, endpoint),
      server,
      endpoint,
      origin: `http://${host}:${endpoint.port}`,
      paths: path !== '/' ? [path] : isPage ? ['/mcp'] : ['/mcp', '/'],
    }]
  }))
}

function keyOf(server: RunningServer, endpoint: ServerEndpoint): string {
  return `${server.serverId}\u0000${endpoint.endpointId}`
}

/** The process that holds each port in a list. */
function portHolders(servers: RunningServer[]): Map<number, string> {
  return new Map(servers.flatMap((server) => server.endpoints.map((endpoint) => [endpoint.port, server.serverId] as const)))
}

function placeOf(server: RunningServer, endpoint: ServerEndpoint, serverInfo: FoundPortPlace['serverInfo']): FoundPortPlace {
  const place: FoundPortPlace = { kind: 'port', runningServerId: server.serverId, endpointId: endpoint.endpointId, port: endpoint.port, processName: server.process.name }
  const folder = server.location.worktreePath ?? server.location.projectRoot
  const checkout = server.location.branch ?? (folder ? basename(folder) : null)
  if (checkout) place.checkout = checkout
  if (serverInfo) place.serverInfo = serverInfo
  if (server.startedBy.kind === 'agent' && server.startedBy.sessionId) place.startedBySessionId = server.startedBy.sessionId
  return place
}

const shortText = z.string().trim().min(1).max(200)
const serverInfoSchema = z.object({ name: shortText, title: shortText.optional().catch(undefined), version: shortText.optional().catch(undefined) })
const jsonRpcAnswerSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({ _meta: z.object({ 'io.modelcontextprotocol/serverInfo': serverInfoSchema.optional().catch(undefined) }).optional().catch(undefined) }).optional(),
  error: z.unknown().optional(),
}).refine((answer) => answer.result !== undefined || answer.error !== undefined)

/**
 * The one request to a loopback endpoint (§9.1): `POST` `server/discover`, no
 * credential, no redirect followed, 1.5 seconds, at most 16 KB read. MCP when
 * the answer is a JSON-RPC result or error (a server of revision 2025 answers
 * with an error), an event stream, or a 401 whose challenge names
 * `resource_metadata`.
 */
export async function discoverOnLoopback(target: URL): Promise<LocalProbeAnswer> {
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  if (target.protocol !== 'http:' || !LOOPBACK_ADDRESSES.has(hostname)) return { isMcp: false }
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      credentials: 'omit',
      signal,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-method': 'server/discover' },
      body: DISCOVER_BODY,
    })
    const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      return { isMcp: /resource_metadata/i.test(response.headers.get('www-authenticate') ?? '') }
    }
    if (media === 'text/event-stream') {
      // The stream may stay open after its answer: one event is enough.
      const text = await readBounded(response, (sofar) => sofar.includes('data:') && /\r?\n\r?\n/.test(sofar.slice(sofar.indexOf('data:'))))
      return mcpAnswer(jsonRpcAnswerOf(text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')))
    }
    const answer = jsonRpcAnswerOf(await readBounded(response, () => false))
    return answer ? mcpAnswer(answer) : { isMcp: false }
  } catch {
    // A refused connection, a timeout, or a stream that broke: not MCP for this process.
    return { isMcp: false }
  }
}

type JsonRpcAnswer = z.infer<typeof jsonRpcAnswerSchema>

/** The JSON-RPC answer in a body, or null when it holds none. */
function jsonRpcAnswerOf(text: string): JsonRpcAnswer | null {
  try {
    const answer = jsonRpcAnswerSchema.safeParse(JSON.parse(text))
    return answer.success ? answer.data : null
  } catch {
    return null
  }
}

/** An MCP answer, with what the server said about itself when it is in the answer (an event stream may give none). */
function mcpAnswer(answer: JsonRpcAnswer | null): LocalProbeAnswer {
  const info = answer?.result?._meta?.['io.modelcontextprotocol/serverInfo']
  if (!info) return { isMcp: true }
  const serverInfo: ServerInfo = { name: info.name }
  if (info.title) serverInfo.title = info.title
  if (info.version) serverInfo.version = info.version
  return { isMcp: true, serverInfo }
}

/** Reads at most 16 KB, or until `enough`; then stops the stream, which may stay open. */
async function readBounded(response: Response, enough: (sofar: string) => boolean): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < MAX_ANSWER_BYTES && !enough(text)) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text.slice(0, MAX_ANSWER_BYTES)
}
