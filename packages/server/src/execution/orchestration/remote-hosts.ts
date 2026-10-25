import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { answersAsSavedHost } from '@solus/client-core/host-link'
import { HostSupervisor, type DialOutcome } from '@solus/client-core/host-supervisor'
import { WsTransport } from '@solus/client-core/ws-transport'
import { chooseRoute, dialableRoutes, mergeRoutes, ROUTE_CHECK_TIMEOUT_MS, routeForUrl, type HostRoute } from '@solus/contracts/host-routes'
import { routeNeedsProof } from '@solus/contracts/host-identity'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { createLogger } from '../../logger'
import type { IntroducedHosts } from './introduced-hosts'
import type { ForwardedHosts } from '../../remote-machines/forwarded-hosts'

const log = createLogger('orchestration', 'remote-hosts.ts')

/** The person and scope a dial to another host acts for (docs/plans/host-reach.md §3.2). */
export interface ReachActor {
  userId: string
  /** The delegation the dial uses: the person's own host, or one organization. */
  scope: 'personal' | { organizationId: string }
}

/** What one turn may reach: through the account for a person, and the introduced hosts for the owner. */
export interface ReachRequest {
  /** Null when this host holds no delegation for the turn's person. */
  account: ReachActor | null
  /** Introduced hosts are the owner's local reach (§4): only the owner's turns use them. */
  isOwner: boolean
}

/** Account reach for one person (§3): the hosts the account plane says they reach from here, and a token for one. */
export interface AccountReach {
  /** Null when the account plane did not answer. */
  hosts(): Promise<DirectoryHost[] | null>
  /** An eight-hour host-reach token; null when none could be had. */
  accessToken(hostId: string): Promise<string | null>
}

/** The introduced hosts as `RemoteHosts` reads them (§4). */
export type IntroducedHostSource = Pick<IntroducedHosts, 'list' | 'credential'>

/** The hosts this host holds an SSH forward to (docs/plans/host-routes.md D7). */
export type ForwardedHostSource = Pick<ForwardedHosts, 'list' | 'credential'>

/** A host work can start on, and how this host reaches it (§5: account reach first, then an introduction). */
export interface HostTarget {
  /** The directory id; for an introduced host, its installation id. */
  hostId: string
  installationId: string
  label: string
  /** Managed hosts only; work starts only on a `ready` one. */
  managedState?: DirectoryHost['managedState']
  /** Every route this host knows to the target; a dial goes to the one `chooseRoute` picks. */
  routes: HostRoute[]
  /** The target's identity key: a credential goes on an `http:` route only after the target proves it. */
  identityKey?: string
  source: 'account' | 'introduced' | 'forwarded'
  /** One connection per person and host: two people never share a socket to another host. */
  connectionKey: string
  /** The credential for one dial; null when none could be had. */
  credential(): Promise<string | null>
  /** A dial for an organization delegation: the organization its ticket names (ADR 0001 §6.4). */
  organizationId?: string
}

/** One target host, reached as a client reaches it. */
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

const NO_REACH = 'This host reaches no other host for you. Link both hosts to your Solus account, or connect to both hosts from one of your devices so they are introduced.'

interface Connection {
  /** The target as last listed; its routes can change while the connection lives. */
  routing: { target: HostTarget }
  host: RemoteHost
  transport: WsTransport
  supervisor: HostSupervisor
}

/**
 * The connections this host keeps to a person's other hosts: one per person and
 * host, opened on first use. A host is one the account plane says the person
 * reaches, or, for the owner, one this host was introduced to; any other is refused.
 */
export class RemoteHosts {
  private readonly connections = new Map<string, Connection>()
  /** What each target said about itself once connected: its routes and identity key (docs/plans/host-routes.md D2). */
  private readonly learned = new Map<string, { routes: HostRoute[]; identityKey?: string }>()

  constructor(
    /** Account reach for one person; null when this host is not registered with the account plane. */
    private readonly accountReach: (actor: ReachActor) => AccountReach | null,
    private readonly introduced: IntroducedHostSource,
    /** This host's own id in the directory, so it is never its own target. */
    private readonly selfHostId: () => string | null,
    /** Hosts on the local network: a saved host found there is dialed there before its tunnel. */
    private readonly discoverNearby: () => Promise<DiscoveredServer[]> = async () => [],
    /** This host's installation id: only it can dial a forward it holds. */
    private readonly selfInstallationId: () => string | null = () => null,
    private readonly forwarded: ForwardedHostSource = { list: () => [], credential: () => null },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One dial, on the route that answers first as the target. No route proved the target: no credential goes anywhere. */
  private async dial(target: HostTarget, transport: WsTransport, report: (outcome: DialOutcome) => void): Promise<void> {
    const routes = dialableRoutes(target.routes, '', this.selfInstallationId())
    const route = await chooseRoute(routes, (url, signal) => this.answersAsTarget(target, url, signal))
    if (!route) {
      report({ kind: 'dial-failed' })
      return
    }
    if (transport.serverUrl !== route.url) transport.switchServerUrl(route.url)
    transport.start({ hostConfirmed: true })
  }

  private answersAsTarget(target: HostTarget, url: string, signal: AbortSignal): Promise<boolean> {
    const route = target.routes.find((candidate) => candidate.url === url) ?? { url }
    return answersAsSavedHost(this.fetchImpl, route, { installationId: target.installationId, identityKey: target.identityKey }, signal)
  }

  /** Keeps what a connected target says about itself, for the next list of targets. */
  private async learn(target: HostTarget, api: HostApi): Promise<void> {
    const info = await api.connectionsGetServerInfo().catch(() => null)
    if (!info) return
    const known = this.learned.get(target.installationId)
    this.learned.set(target.installationId, {
      routes: mergeRoutes(known?.routes ?? [], info.routes, 'host', Date.now()),
      identityKey: known?.identityKey ?? target.identityKey ?? info.identityKey,
    })
  }

  /** The hosts work can start on: the account's first, then each introduced host the account does not list. */
  async list(request: ReachRequest): Promise<HostTarget[] | { error: string }> {
    const account = await this.accountTargets(request.account)
    const listed = new Set(account.map((host) => host.installationId))
    const introduced: HostTarget[] = request.isOwner
      ? this.introduced.list().hosts.filter((host) => !listed.has(host.installationId)).map((host) => ({
        hostId: host.installationId,
        installationId: host.installationId,
        label: host.label,
        routes: [routeForUrl(host.url)],
        identityKey: host.identityKey,
        source: 'introduced',
        connectionKey: `introduced:${host.installationId}`,
        credential: () => this.introduced.credential(host.installationId),
      }))
      : []
    // A forward is the owner's: Solus with no account reaches nobody else's machine (D7).
    const known = new Set([...account, ...introduced].map((host) => host.installationId))
    const forwarded: HostTarget[] = request.isOwner
      ? this.forwarded.list().filter((host) => !known.has(host.installationId)).map((host) => ({
        hostId: host.installationId,
        installationId: host.installationId,
        label: host.label,
        routes: [host.route],
        identityKey: host.identityKey,
        source: 'forwarded',
        connectionKey: `forwarded:${host.installationId}`,
        credential: async () => this.forwarded.credential(host.installationId),
      }))
      : []
    const hosts = [...account, ...introduced, ...forwarded]
    return hosts.length > 0 ? hosts : { error: NO_REACH }
  }

  private async accountTargets(actor: ReachActor | null): Promise<HostTarget[]> {
    const reach = actor ? this.accountReach(actor) : null
    if (!actor || !reach) return []
    const [directory, nearby] = await Promise.all([reach.hosts().catch(() => null), this.discoverNearby().catch(() => [])])
    if (!directory) {
      log.info('account_reach_unavailable', { userId: actor.userId })
      return []
    }
    const self = this.selfHostId()
    const scopeKey = actor.scope === 'personal' ? 'personal' : actor.scope.organizationId
    const now = Date.now()
    return directory.flatMap((host): HostTarget[] => {
      const found = nearby.find((server) => server.installationId === host.installationId)
      const discovered = found ? [routeForUrl(`http://${found.host}:${found.port}`)] : []
      const learned = this.learned.get(host.installationId)
      const routes = mergeRoutes(mergeRoutes(learned?.routes ?? [], host.routes, 'directory', now), discovered, 'discovery', now)
      if (host.hostId === self || routes.length === 0) return []
      const target: HostTarget = {
        hostId: host.hostId,
        installationId: host.installationId,
        label: host.label,
        managedState: host.managedState,
        routes,
        identityKey: learned?.identityKey,
        source: 'account',
        connectionKey: `account:${actor.userId}:${scopeKey}:${host.hostId}`,
        credential: () => reach.accessToken(host.hostId),
      }
      // The reach token states the person's standing there; only an organization's dial names it.
      if (actor.scope !== 'personal') target.organizationId = actor.scope.organizationId
      return [target]
    })
  }

  /** Finds one host by id, installation id, or label; the label match ignores case. */
  async find(request: ReachRequest, ref: string): Promise<HostTarget | { error: string }> {
    const hosts = await this.list(request)
    if ('error' in hosts) return hosts
    const wanted = ref.trim().toLowerCase()
    const matches = hosts.filter((host) => [host.hostId, host.installationId, host.label.trim()].some((name) => name.toLowerCase() === wanted))
    if (matches.length === 1) return matches[0]!
    const names = hosts.map((host) => `${host.label} (${host.hostId})`).join(', ') || '(none)'
    if (matches.length > 1) return { error: `More than one host is named "${ref}". Use its id. Hosts: ${names}.` }
    return { error: `You do not reach a host "${ref}" from here. Hosts you can start work on: ${names}.` }
  }

  /** The connection to `host`, opened on first use. */
  connect(host: HostTarget): RemoteHost | { error: string } {
    if (host.managedState && host.managedState !== 'ready') {
      return { error: `${host.label} is ${host.managedState}. Start it first, then try again.` }
    }
    const open = this.connections.get(host.connectionKey)
    if (open) {
      open.routing.target = host
      return open.host
    }
    const reconnected = new Set<() => void>()
    let hasConnected = false
    const [first] = dialableRoutes(host.routes, '', this.selfInstallationId())
    if (!first) return { error: `This host has no route to ${host.label}.` }
    const routing = { target: host }
    const transport = new WsTransport({
      serverUrl: first.url,
      serverId: host.hostId,
      // Every dial presents the credential again: the person's host-reach token, or
      // the introduced token after the introduced host proves its identity.
      sessionToken: '',
      // A host has no sign-in of its own to end: a dial with no credential is retried.
      // An introduced or forwarded host issued its own session token; the account's is an access token.
      grants: { acquire: () => host.credential(), isSignedOut: () => false, tokenKind: host.source === 'account' ? 'access-token' : 'session-token' },
      // Defense in depth: a dial on an `http:` route waits for the target's proof before its credential goes.
      proveRoute: (url) => {
        const route = routing.target.routes.find((candidate) => candidate.url === url) ?? { url }
        return routeNeedsProof(route) ? this.answersAsTarget(routing.target, url, AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS)) : null
      },
      dialOrganizationId: () => host.organizationId ?? null,
    })
    const supervisor = new HostSupervisor({
      // Each dial goes to the route that answers first as the target (docs/plans/host-routes.md D1).
      transport: {
        start: () => void this.dial(routing.target, transport, (outcome) => supervisor.report(outcome)),
        probe: () => transport.probe(),
        setUnreachable: (unreachable) => transport.setUnreachable(unreachable),
      },
      onReadinessChange: (readiness) => {
        log.info('remote_host_phase', { hostId: host.hostId, readiness })
        if (readiness !== 'ready') return
        if (hasConnected) for (const listener of reconnected) listener()
        hasConnected = true
        void this.learn(routing.target, remote.api)
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
        const refused = host.source === 'introduced' ? ' It refused this host\'s introduction. Connect to both hosts from one of your devices again.' : ' It refused the token from your Solus account.'
        const blocked = supervisor.refusedReason === 'auth' ? refused : ''
        return `${host.label} did not answer ${what} within ${CALL_TIMEOUT_MS / 1000} s.${blocked}`
      }),
    }
    this.connections.set(host.connectionKey, { routing, host: remote, transport, supervisor })
    return remote
  }

  /** Closes every connection to one host, as when its introduction is replaced or forgotten. */
  disconnect(installationId: string): void {
    for (const [key, open] of this.connections) {
      if (open.host.installationId !== installationId) continue
      open.supervisor.destroy()
      open.transport.destroy()
      this.connections.delete(key)
    }
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

