import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostSupervisor } from '@solus/client-core/host-supervisor'
import { WsTransport } from '@solus/client-core/ws-transport'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { createLogger } from '../../logger'

const log = createLogger('orchestration', 'remote-hosts.ts')

/**
 * What this host may do for its owner on the owner's other hosts
 * (docs/plans/cross-host-sessions.md §5.1). The process that holds the owner's
 * account session supplies it; a host without one has no host access.
 */
export interface HostAccess {
  /** The hosts the owner's account can reach; null when signed out or the account plane did not answer. */
  hosts(): Promise<DirectoryHost[] | null>
  /** A short-lived token for one host, for the owner; null when none could be had. */
  accessToken(hostId: string): Promise<string | null>
}

/** One target host, reached as a client reaches it, with the owner's token. */
export interface RemoteHost {
  hostId: string
  /** The id clients know the host by, so a link opens the session there. */
  installationId: string
  label: string
  api: HostApi
  events: HostEventSubscriber
  /** Calls `listener` each time the connection is accepted again after a drop. */
  onReconnected(listener: () => void): () => void
  /** Rejects when the host does not answer in time, with the reason when one is known. */
  call<T>(what: string, request: () => Promise<T>): Promise<T>
}

/** How long one call to a target host may take before it fails. */
const CALL_TIMEOUT_MS = 30_000

interface Connection {
  host: RemoteHost
  transport: WsTransport
  supervisor: HostSupervisor
}

/**
 * The connections this host keeps to the owner's other hosts: one per host,
 * opened on first use. A host is found by id or label in the owner's
 * directory; a host that is not there is refused.
 */
export class RemoteHosts {
  private readonly connections = new Map<string, Connection>()

  constructor(
    private readonly access: HostAccess,
    /** This host's own id in the directory, so it is never its own target. */
    private readonly selfHostId: () => string | null,
  ) {}

  /** The hosts work can start on: each one in the directory with a route, except this host. */
  async list(): Promise<DirectoryHost[] | { error: string }> {
    const hosts = await this.access.hosts().catch(() => null)
    if (!hosts) return { error: 'Your Solus account did not answer. Sign in to Solus on this host and try again.' }
    const self = this.selfHostId()
    return hosts.filter((host) => host.hostId !== self && host.routes.length > 0)
  }

  /** Finds one host by id or label; the label match ignores case. */
  async find(ref: string): Promise<DirectoryHost | { error: string }> {
    const hosts = await this.list()
    if ('error' in hosts) return hosts
    const wanted = ref.trim().toLowerCase()
    const matches = hosts.filter((host) => host.hostId.toLowerCase() === wanted || host.label.trim().toLowerCase() === wanted)
    if (matches.length === 1) return matches[0]!
    const names = hosts.map((host) => `${host.label} (${host.hostId})`).join(', ') || '(none)'
    if (matches.length > 1) return { error: `More than one host is named "${ref}". Use its id. Hosts: ${names}.` }
    return { error: `No host "${ref}" in your Solus account. Hosts you can start work on: ${names}.` }
  }

  /** The connection to `host`, opened on first use. */
  connect(host: DirectoryHost): RemoteHost | { error: string } {
    if (host.managedState && host.managedState !== 'ready') {
      return { error: `${host.label} is ${host.managedState}. Start it first, then try again.` }
    }
    const route = host.routes.find((candidate) => candidate.kind === 'direct') ?? host.routes[0]
    if (!route) return { error: `${host.label} has no route yet.` }
    const open = this.connections.get(host.hostId)
    if (open) {
      if (open.transport.serverUrl !== route.url) open.transport.switchServerUrl(route.url)
      return open.host
    }
    const reconnected = new Set<() => void>()
    let hasConnected = false
    const transport = new WsTransport({
      serverUrl: route.url,
      serverId: host.hostId,
      // Every dial presents a fresh token from the owner's account; there is no paired credential.
      sessionToken: '',
      acquireGrant: () => this.access.accessToken(host.hostId),
    })
    const supervisor = new HostSupervisor({
      transport,
      onPhaseChange: (phase) => {
        log.info('remote_host_phase', { hostId: host.hostId, phase })
        if (phase !== 'connected') return
        if (hasConnected) for (const listener of reconnected) listener()
        hasConnected = true
      },
    })
    transport.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
    supervisor.start()
    const remote: RemoteHost = {
      hostId: host.hostId,
      installationId: host.installationId,
      label: host.label,
      api: asHostApi(transport.buildSolusApi()),
      events: transport.events,
      onReconnected: (listener) => {
        reconnected.add(listener)
        return () => { reconnected.delete(listener) }
      },
      call: (what, request) => withTimeout(request(), () => {
        const blocked = supervisor.blockedReason === 'auth' ? ' It refused the token from your Solus account.' : ''
        return `${host.label} did not answer ${what} within ${CALL_TIMEOUT_MS / 1000} s.${blocked}`
      }),
    }
    this.connections.set(host.hostId, { host: remote, transport, supervisor })
    return remote
  }

  close(): void {
    for (const { transport, supervisor } of this.connections.values()) {
      supervisor.destroy()
      transport.destroy()
    }
    this.connections.clear()
  }
}

function withTimeout<T>(work: Promise<T>, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), CALL_TIMEOUT_MS)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** The owner's other hosts, where the process holds the owner's account session; null elsewhere. */
export function remoteHostsFor(
  owner: { ownerAccessToken?: (hostId: string) => Promise<string | null>; ownerHosts?: () => Promise<DirectoryHost[] | null> },
  selfHostId: () => string | null,
): RemoteHosts | null {
  const { ownerAccessToken, ownerHosts } = owner
  return ownerAccessToken && ownerHosts ? new RemoteHosts({ hosts: ownerHosts, accessToken: ownerAccessToken }, selfHostId) : null
}
