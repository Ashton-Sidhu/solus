import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostSupervisor } from '@solus/client-core/host-supervisor'
import { WsTransport } from '@solus/client-core/ws-transport'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { createLogger } from '../../logger'
import type { PairedHosts } from './paired-hosts'

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

/** The paired hosts as `RemoteHosts` reads them (§10). */
export type PairedHostSource = Pick<PairedHosts, 'list' | 'credential'>

/**
 * A host work can start on, and how this host reaches it: a paired host with
 * its pairing token, or a host in the owner's directory with an account grant
 * (§10.3: one credential for each host, no fallback).
 */
export interface HostTarget {
  /** The directory id; for a paired host, its installation id. */
  hostId: string
  installationId: string
  label: string
  /** Managed hosts only; work starts only on a `ready` one. */
  managedState?: DirectoryHost['managedState']
  url: string
  paired: boolean
  /** The credential for one dial; null when none could be had. */
  credential(): Promise<string | null>
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
 * opened on first use. A host is a paired host, or one in the owner's
 * directory; any other host is refused.
 */
export class RemoteHosts {
  private readonly connections = new Map<string, Connection>()

  constructor(
    /** The owner's account; null on a host with no account session. */
    private readonly access: HostAccess | null,
    private readonly paired: PairedHostSource,
    /** This host's own id in the directory, so it is never its own target. */
    private readonly selfHostId: () => string | null,
  ) {}

  /** The hosts work can start on: the paired hosts, then each directory host with a route that is not paired and not this host. */
  async list(): Promise<HostTarget[] | { error: string }> {
    const paired: HostTarget[] = this.paired.list().map((host) => ({
      hostId: host.installationId,
      installationId: host.installationId,
      label: host.label,
      url: host.url,
      paired: true,
      credential: () => this.paired.credential(host.installationId),
    }))
    if (!this.access) {
      return paired.length > 0 ? paired : { error: 'This host has no other hosts. Pair a host in Settings → Hosts → this host → Access, or sign in to your Solus account in the desktop app.' }
    }
    const access = this.access
    const directory = await access.hosts().catch(() => null)
    if (!directory) {
      return paired.length > 0 ? paired : { error: 'Your Solus account did not answer. Sign in to Solus on this host and try again.' }
    }
    const self = this.selfHostId()
    const pairedIds = new Set(paired.map((host) => host.installationId))
    const reachable = directory.flatMap((host): HostTarget[] => {
      // A `direct` route is dialed before the `tunnel`.
      const route = host.routes.find((candidate) => candidate.kind === 'direct') ?? host.routes[0]
      if (host.hostId === self || pairedIds.has(host.installationId) || !route) return []
      return [{
        hostId: host.hostId,
        installationId: host.installationId,
        label: host.label,
        managedState: host.managedState,
        url: route.url,
        paired: false,
        credential: () => access.accessToken(host.hostId),
      }]
    })
    return [...paired, ...reachable]
  }

  /** Finds one host by id, installation id, or label; the label match ignores case. */
  async find(ref: string): Promise<HostTarget | { error: string }> {
    const hosts = await this.list()
    if ('error' in hosts) return hosts
    const wanted = ref.trim().toLowerCase()
    const matches = hosts.filter((host) => [host.hostId, host.installationId, host.label.trim()].some((name) => name.toLowerCase() === wanted))
    if (matches.length === 1) return matches[0]!
    const names = hosts.map((host) => `${host.label} (${host.hostId})`).join(', ') || '(none)'
    if (matches.length > 1) return { error: `More than one host is named "${ref}". Use its id. Hosts: ${names}.` }
    return { error: `No host "${ref}" is paired or in your Solus account. Hosts you can start work on: ${names}.` }
  }

  /** The connection to `host`, opened on first use. */
  connect(host: HostTarget): RemoteHost | { error: string } {
    if (host.managedState && host.managedState !== 'ready') {
      return { error: `${host.label} is ${host.managedState}. Start it first, then try again.` }
    }
    const open = this.connections.get(host.hostId)
    if (open) {
      if (open.transport.serverUrl !== host.url) open.transport.switchServerUrl(host.url)
      return open.host
    }
    const reconnected = new Set<() => void>()
    let hasConnected = false
    const transport = new WsTransport({
      serverUrl: host.url,
      serverId: host.hostId,
      // Every dial presents the credential again: a fresh account grant, or the
      // pairing token after the paired host proves its identity.
      sessionToken: '',
      acquireGrant: () => host.credential(),
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
        const refused = host.paired ? ' It refused this host\'s pairing. Pair it again.' : ' It refused the token from your Solus account.'
        const blocked = supervisor.blockedReason === 'auth' ? refused : ''
        return `${host.label} did not answer ${what} within ${CALL_TIMEOUT_MS / 1000} s.${blocked}`
      }),
    }
    this.connections.set(host.hostId, { host: remote, transport, supervisor })
    return remote
  }

  /** Closes the connection to one host, as when its pairing is forgotten. */
  disconnect(hostId: string): void {
    const open = this.connections.get(hostId)
    if (!open) return
    open.supervisor.destroy()
    open.transport.destroy()
    this.connections.delete(hostId)
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

/** The owner's other hosts: the paired hosts, and the directory where the process holds the owner's account session. */
export function remoteHostsFor(
  owner: { ownerAccessToken?: (hostId: string) => Promise<string | null>; ownerHosts?: () => Promise<DirectoryHost[] | null> },
  paired: PairedHostSource,
  selfHostId: () => string | null,
): RemoteHosts {
  const { ownerAccessToken, ownerHosts } = owner
  const access = ownerAccessToken && ownerHosts ? { hosts: ownerHosts, accessToken: ownerAccessToken } : null
  return new RemoteHosts(access, paired, selfHostId)
}
