import { randomUUID } from 'node:crypto'
import { gitOutputPath, runAsync } from '../../git/exec'
import { resolveRepoRoot } from '../../git/git-helpers'
import { loadProjectConfig } from '../../project-config/project-config'
import { resolveHomePath } from '../../platform/paths'
import { runBounded } from '../../lib/concurrency'
import type { RunningServer, ServerEndpoint } from '@solus/contracts/running-servers'
import { listListeningSockets, localListenerAddress, type Listener } from './listeners'
import { processFacts, readProcessTags, workingDirectories, type ProcessFacts } from './processes'
import { probeServerUrl, type ProbeResult } from './probe'
import { defaultJobStop, type JobStopDeps } from './stop-job'
import { notifyCommandStop } from './command-stops'

interface KnownProcess { identity: string; serverId: string }
interface ConfiguredUrl { cwd: string; url: string }
export interface DiscoveryDeps {
  listeners: () => Promise<Listener[]>
  processes: () => Promise<Map<number, ProcessFacts>>
  tags: (facts: Map<number, ProcessFacts>, pids: number[]) => Promise<void>
  directories: (pids: number[]) => Promise<Map<number, string>>
  configured: (paths: string[]) => Promise<ConfiguredUrl[]>
  probe: (url: URL) => Promise<ProbeResult>
  locate: (server: RunningServer) => Promise<void>
  now: () => number
  beforeStop: JobStopDeps['beforeStop']
}

async function configuredUrls(paths: string[]): Promise<ConfiguredUrl[]> {
  const entries = await runBounded(paths.map((path) => async () => {
    const cwd = resolveHomePath(path)
    const config = await loadProjectConfig(cwd)
    return (config?.serverUrls ?? []).map((url) => ({ cwd, url }))
  }), 8)
  return entries.flat()
}

/** One scan per host. Socket discovery sends no bytes to an unknown service. */
export class ServerDiscovery {
  private readonly locations = new Map<string, { at: number; location: RunningServer['location'] }>()
  private readonly known = new Map<number, KnownProcess>()
  private readonly responses = new Map<string, { at: number; verdict: ProbeResult }>()
  private readonly deps: DiscoveryDeps
  /** The loopback and wildcard ports of the last scan, owned or not. Read by other host modules; nothing is sent to them. */
  private ports: ReadonlySet<number> = new Set()

  constructor(deps: Partial<DiscoveryDeps> = {}) {
    this.deps = { listeners: listListeningSockets, processes: processFacts, tags: readProcessTags, directories: workingDirectories, configured: configuredUrls, probe: probeServerUrl, locate: attributeToWorktree, now: Date.now, beforeStop: (_server, members, table) => notifyCommandStop(members, table), ...deps }
  }

  async discover(paths: string[] = []): Promise<RunningServer[]> {
    const [listeners, facts, configured] = await Promise.all([this.deps.listeners(), this.deps.processes(), this.deps.configured(paths)])
    this.ports = new Set(listeners.map((listener) => listener.port))
    const pids = [...new Set(listeners.map((listener) => listener.pid))]
    const relevant = new Set(pids)
    for (const pid of pids) {
      let parent = facts.get(pid)?.parentPid
      while (parent && facts.has(parent) && !relevant.has(parent)) { relevant.add(parent); parent = facts.get(parent)?.parentPid }
    }
    const [directories] = await Promise.all([this.deps.directories(pids), this.deps.tags(facts, [...relevant])])
    for (const pid of this.known.keys()) if (!pids.includes(pid)) this.known.delete(pid)
    const byPort = new Map<number, Set<number>>()
    for (const listener of listeners) {
      const owners = byPort.get(listener.port) ?? new Set<number>()
      owners.add(listener.pid)
      byPort.set(listener.port, owners)
    }
    // A reused/shared port cannot be attributed safely to one job.
    const unique = [...new Map(listeners.filter((listener) => byPort.get(listener.port)?.size === 1).map((listener) => [`${listener.pid}:${listener.port}`, listener])).values()]
    const servers = new Map<string, RunningServer>()
    const add = (listener: Listener, explicit?: ConfiguredUrl): RunningServer | null => {
      const fact = facts.get(listener.pid)
      if (fact?.protected) return null
      const owned = isOwned(fact)
      if (!owned && !explicit) return null
      const key = listener.pid ? String(listener.pid) : `${explicit?.cwd}:${explicit?.url}`
      const found = servers.get(key)
      if (found) return found
      const server = this.createServer(listener, fact, directories, explicit)
      servers.set(key, server)
      return server
    }
    for (const listener of unique) {
      const server = add(listener)
      if (!server) continue
      const address = listener.address ?? '127.0.0.1'
      const host = address.includes(':') ? `[${address}]` : address
      server.endpoints.push({ endpointId: String(listener.port), address, port: listener.port, url: `http://${host}:${listener.port}/`, response: null })
    }
    const configuredKeys = new Set(configured.map((entry) => entry.url))
    for (const key of this.responses.keys()) if (!configuredKeys.has(key)) this.responses.delete(key)
    // Only explicit URLs are probed, with bounded concurrency and retryable verdicts.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(8, configured.length) }, async () => {
      while (next < configured.length) {
        const entry = configured[next++]
        const url = new URL(entry.url)
        const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
        if ((byPort.get(port)?.size ?? 0) > 1) continue
        const listener = unique.find((candidate) => candidate.port === port)
        if (listener && facts.get(listener.pid)?.protected) continue
        const cached = this.responses.get(entry.url)
        const verdict = cached && this.deps.now() - cached.at < 15_000 ? cached.verdict : await this.deps.probe(url)
        this.responses.set(entry.url, { at: cached && this.deps.now() - cached.at < 15_000 ? cached.at : this.deps.now(), verdict })
        if (verdict.kind !== 'http') continue
        const server = add(listener ?? { pid: 0, port, command: 'Configured server' }, entry)
        if (!server) continue
        const endpoint = configuredEndpoint(entry.url, url, listener, verdict.response)
        // The explicit address replaces a guessed root address, preserving path and scheme.
        const guessed = server.endpoints.findIndex((candidate) => candidate.port === port && candidate.response === null)
        if (guessed >= 0) server.endpoints.splice(guessed, 1, endpoint)
        else if (!server.endpoints.some((candidate) => candidate.url === entry.url)) server.endpoints.push(endpoint)
      }
    }))
    const directoriesInUse = new Set([...servers.values()].map((server) => server.process.workingDirectory))
    for (const cwd of this.locations.keys()) if (!directoriesInUse.has(cwd)) this.locations.delete(cwd)
    await Promise.all([...directoriesInUse].map(async (cwd) => {
      if (!cwd) return
      const cached = this.locations.get(cwd)
      const matching = [...servers.values()].filter((server) => server.process.workingDirectory === cwd)
      if (cached && this.deps.now() - cached.at < 30_000) {
        for (const server of matching) server.location = cached.location
      } else {
        await this.deps.locate(matching[0])
        const location = matching[0].location
        this.locations.set(cwd, { at: this.deps.now(), location })
        for (const server of matching) server.location = location
      }
    }))
    return [...servers.values()].sort((a, b) => a.process.pid - b.process.pid)
  }

  listeningPorts(): ReadonlySet<number> { return this.ports }

  private createServer(listener: Listener, fact: ProcessFacts | undefined, directories: Map<number, string>, explicit?: ConfiguredUrl): RunningServer {
    const identity = fact?.identity ?? ''
    let known = this.known.get(listener.pid)
    if (listener.pid && (!known || known.identity !== identity)) {
      known = { identity, serverId: randomUUID() }
      this.known.set(listener.pid, known)
    }
    const cwd = processDirectory(listener.pid, fact, directories, explicit)
    return {
      serverId: known?.serverId ?? `configured:${explicit?.cwd}:${explicit?.url}`,
      process: { pid: listener.pid, name: fact?.name || listener.command || 'Configured server', workingDirectory: cwd },
      location: { projectRoot: null, worktreePath: null, branch: null },
      startedBy: serverOwner(fact), endpoints: [],
      actions: { canStop: isOwned(fact) && !!identity && !fact?.protected },
    }
  }

  /** Resolve on the host: a session can start in a subfolder or a nested worktree. */
  async checkoutRoots(paths: string[]): Promise<{ path: string; root: string | null }[]> {
    return runBounded(paths.map((path) => async () => {
      const cwd = resolveHomePath(path)
      const top = await runAsync('git', ['rev-parse', '--show-toplevel'], cwd, { timeout: 5000 }).catch(() => null)
      return { path, root: top ? gitOutputPath(cwd, top) : null }
    }), 8)
  }

  async identityMatches(server: RunningServer): Promise<boolean> {
    const known = this.known.get(server.process.pid)
    if (!known?.identity || known.serverId !== server.serverId) return false
    const fact = (await this.deps.processes()).get(server.process.pid)
    return !!fact && !fact.protected && fact.identity === known.identity
  }

  async stopJob(server: RunningServer) {
    const known = this.known.get(server.process.pid)
    if (!known?.identity || known.serverId !== server.serverId) return { status: 'refused' as const, reason: 'identity-changed' as const }
    return defaultJobStop(server, known.identity, this.deps.beforeStop)
  }
}

async function attributeToWorktree(server: RunningServer): Promise<void> {
  const cwd = server.process.workingDirectory
  if (!cwd) return
  try {
    const toplevel = await runAsync('git', ['rev-parse', '--show-toplevel'], cwd, { timeout: 5000 })
    if (!toplevel) return
    const worktreePath = gitOutputPath(cwd, toplevel)
    server.location.worktreePath = worktreePath
    const [branch, root] = await Promise.all([
      runAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, { timeout: 5000 }),
      resolveRepoRoot(worktreePath),
    ])
    server.location.branch = branch && branch !== 'HEAD' ? branch : null
    server.location.projectRoot = root ?? null
  } catch { /* A server outside a repository still appears at host level. */ }
}


function serverOwner(fact: ProcessFacts | undefined): RunningServer['startedBy'] {
  if (fact?.terminalId) return { kind: 'terminal', terminalId: fact.terminalId, sessionId: fact.sessionId }
  if (fact?.sessionId || fact?.agentOwned) return { kind: 'agent', sessionId: fact.sessionId }
  return { kind: 'configured' }
}
function isOwned(fact: ProcessFacts | undefined): boolean { return !!(fact?.sessionId || fact?.terminalId || fact?.agentOwned) }
function processDirectory(pid: number, fact: ProcessFacts | undefined, directories: Map<number, string>, explicit?: ConfiguredUrl): string | null {
  return directories.get(pid) ?? fact?.launchDirectory ?? explicit?.cwd ?? null
}
function configuredEndpoint(raw: string, url: URL, listener: Listener | undefined, response: ServerEndpoint['response']): ServerEndpoint {
  return { endpointId: raw, address: listener?.address ?? localListenerAddress(url.hostname) ?? '127.0.0.1', port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), url: raw, response }
}
