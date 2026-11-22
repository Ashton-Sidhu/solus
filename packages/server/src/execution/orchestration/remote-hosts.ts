import { dialHostSocket } from '@solus/client-core/host-socket'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { answersAsSavedHost, HostLink, type AdvertisedHost } from '@solus/client-core/host-link'
import { WsTransport } from '@solus/client-core/ws-transport'
import { carriesTokenInClear, chooseRoute, dialableRoutes, mergeRoutes, routesForMachine, ROUTE_CHECK_TIMEOUT_MS, routeForUrl, type HostRoute } from '@solus/contracts/host-routes'
import { routeNeedsProof } from '@solus/contracts/host-identity'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { DirectoryHost } from '@solus/contracts/uplink'
import type { HostListing } from '@solus/contracts/host-list'
import { createLogger } from '../../logger'
import type { HostPairings } from '../../host/host-pairings'
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
  /** `listed`: on the person's host list, but this host holds no credential for it. */
  source: 'account' | 'introduced' | 'forwarded' | 'paired' | 'listed'
  /** One connection per person and host: two people never share a socket to another host. */
  connectionKey: string
  /** The credential for one dial; null when none could be had. */
  credential(): Promise<string | null>
  /** A dial for an organization delegation: the organization its ticket names (ADR 0001 §6.4). */
  organizationId?: string
}

/** Machine discovery for agents; no provider catalog or credential leaves this interface. */
export interface ListedRemoteHost {
  id: string
  installationId: string
  name: string
  source: HostTarget['source']
  /** `not-paired`: this host holds no credential for it; `pair_host` here gives it one. */
  status: 'online' | 'unreachable' | 'auth-required' | 'not-ready' | 'not-paired'
  managedState?: DirectoryHost['managedState']
  routes: HostRoute[]
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

/** LAN HTTP remains supported for hosts on one private network. */
export function safeHostDialRoute(route: HostRoute): boolean {
  return route.kind === 'lan' || routeForUrl(route.url).kind === 'lan' || !carriesTokenInClear(route)
}

interface Connection {
  /** The target as last listed; its routes can change while the connection lives. */
  routing: { target: HostTarget }
  host: RemoteHost
  /** The same link a client holds to a host: its dials, route choice, retries, and facts. */
  link: HostLink
}

/**
 * The connections this host keeps to a person's other hosts: one per person and
 * host, opened on first use. The hosts are the same ones a client of this host
 * lists (the account directory and the person's host list), each with how this host
 * reaches it: through the account, or, for the owner, a pairing, an introduction, or
 * a forward. A host on the list that this host holds no credential for is listed as
 * `listed`, so an agent sees it and why it cannot start work there.
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
    private readonly pairings: Pick<HostPairings, 'snapshot' | 'credential'> = { snapshot: () => ({ hosts: [], forgotten: [] }), credential: async () => null },
    /** The person's host list as this host keeps it (`host_list`), the list its clients read while signed out. */
    private readonly hostList: () => HostListing[] = () => [],
  ) {}

  private answersAsTarget(target: HostTarget, url: string, signal: AbortSignal): Promise<boolean> {
    const route = target.routes.find((candidate) => candidate.url === url) ?? { url }
    return answersAsSavedHost(this.fetchImpl, route, { installationId: target.installationId, identityKey: target.identityKey }, signal)
  }

  /** Keeps what a connected target says about itself, for the next list of targets. */
  private learn(target: HostTarget, advertised: AdvertisedHost): void {
    const known = this.learned.get(target.installationId)
    this.learned.set(target.installationId, {
      routes: mergeRoutes(known?.routes ?? [], advertised.routes, 'host', Date.now()),
      identityKey: known?.identityKey ?? target.identityKey ?? advertised.identityKey,
    })
  }

  /** The hosts work can start on: the account's first, then each introduced host the account does not list. */
  async list(request: ReachRequest, includeUnroutable = false): Promise<HostTarget[] | { error: string }> {
    const account = await this.accountTargets(request.account, includeUnroutable)
    const listed = new Set(account.map((host) => host.installationId))
    const paired: HostTarget[] = request.isOwner ? this.pairings.snapshot().hosts.map(({ listing }) => listing).filter((host) => !listed.has(host.installationId)).map((host) => ({
      hostId: host.installationId, installationId: host.installationId, label: host.label,
      routes: host.routes, identityKey: host.identityKey, source: 'paired',
      connectionKey: `paired:${host.installationId}`, credential: () => this.pairings.credential(host.installationId),
    })) : []
    for (const host of paired) listed.add(host.installationId)
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
    const known = new Set([...account, ...paired, ...introduced].map((host) => host.installationId))
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
    // Every other host on the owner's list, with no way for this host to reach it.
    for (const host of forwarded) known.add(host.installationId)
    const self = this.selfInstallationId()
    const listedOnly: HostTarget[] = request.isOwner
      ? this.hostList().filter((host) => !known.has(host.installationId) && host.installationId !== self).map((host) => ({
        hostId: host.installationId,
        installationId: host.installationId,
        label: host.label,
        routes: host.routes,
        identityKey: host.identityKey,
        source: 'listed',
        connectionKey: `listed:${host.installationId}`,
        credential: async () => null,
      }))
      : []
    const hosts = [...account, ...paired, ...introduced, ...forwarded, ...listedOnly]
    return hosts.length > 0 ? hosts : { error: NO_REACH }
  }

  /** Like T3's environment links: probe the machines, without loading their model catalogs. */
  async summaries(request: ReachRequest): Promise<ListedRemoteHost[]> {
    const hosts = await this.list(request, true)
    if ('error' in hosts) return []
    return Promise.all(hosts.map(async (target): Promise<ListedRemoteHost> => ({
      id: target.hostId, installationId: target.installationId, name: target.label,
      source: target.source, routes: target.routes, managedState: target.managedState,
      status: await withTimeout(this.probe(target), () => 'Host status check timed out.', 3_000).catch(() => 'unreachable' as const),
    })))
  }

  private async probe(target: HostTarget): Promise<ListedRemoteHost['status']> {
    if (target.source === 'listed') return 'not-paired'
    if (target.managedState && target.managedState !== 'ready') return 'not-ready'
    const routes = dialableRoutes(target.routes, '', this.selfInstallationId()).filter(safeHostDialRoute)
    const route = await chooseRoute(routes, (url, signal) => this.answersAsTarget(target, url, signal))
    if (!route) return 'unreachable'
    const token = await target.credential()
    if (!token) return 'auth-required'
    const credential = target.source === 'account'
      ? { kind: 'access-token' as const, token, organizationId: target.organizationId }
      : { kind: 'session-token' as const, token }
    const dialed = await dialHostSocket(route.url, { credential }, { timeoutMs: 3_000 })
    if (!dialed.ok) return dialed.code === 'UNAUTHORIZED' ? 'auth-required' : 'unreachable'
    dialed.socket.close()
    return 'online'
  }

  private async accountTargets(actor: ReachActor | null, includeUnroutable: boolean): Promise<HostTarget[]> {
    const reach = actor ? this.accountReach(actor) : null
    if (!actor || !reach) return []
    const [directory, nearby] = await Promise.all([reach.hosts().catch(() => null), this.discoverNearby().catch(() => [])])
    if (!directory) {
      log.info('account_reach_unavailable', { userId: actor.userId })
      return []
    }
    const self = this.selfHostId()
    const identities = new Map([...this.introduced.list().hosts, ...this.pairings.snapshot().hosts.map(({ listing }) => listing)].map((host) => [host.installationId, host.identityKey]))
    const scopeKey = actor.scope === 'personal' ? 'personal' : actor.scope.organizationId
    const now = Date.now()
    return directory.flatMap((host): HostTarget[] => {
      const found = nearby.find((server) => server.installationId === host.installationId)
      const discovered = found ? [routeForUrl(`http://${found.host}:${found.port}`, found.source === 'tailnet')] : []
      const learned = this.learned.get(host.installationId)
      const routes = routesForMachine(mergeRoutes(mergeRoutes(learned?.routes ?? [], host.routes, 'directory', now), discovered, 'discovery', now), host.kind)
      if (host.hostId === self || (!includeUnroutable && routes.length === 0)) return []
      const target: HostTarget = {
        hostId: host.hostId,
        installationId: host.installationId,
        label: host.label,
        managedState: host.managedState,
        routes,
        identityKey: learned?.identityKey ?? identities.get(host.installationId),
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
    const hosts = await this.list(request, true)
    if ('error' in hosts) return hosts
    const wanted = ref.trim().toLowerCase()
    const matches = hosts.filter((host) => [host.hostId, host.installationId, host.label.trim()].some((name) => name.toLowerCase() === wanted))
    if (matches.length === 1) return matches[0]!
    const names = hosts.map((host) => `${host.label} (${host.hostId})`).join(', ') || '(none)'
    if (matches.length > 1) return { error: `More than one host is named "${ref}". Use its id. Hosts: ${names}.` }
    return { error: `You do not reach a host "${ref}" from here. Hosts you can start work on: ${names}.` }
  }

  /** The connection to the host `ref` names for this person: `find`, then `connect`. */
  async connectTo(request: ReachRequest, ref: string): Promise<RemoteHost | { error: string }> {
    const target = await this.find(request, ref)
    return 'error' in target ? target : this.connect(target)
  }

  /** The connection to `host`, opened on first use. */
  connect(host: HostTarget): RemoteHost | { error: string } {
    if (host.source === 'listed') {
      return { error: `${host.label} is on your host list, but this host holds no credential for it. Pair it here with pair_host, then try again.` }
    }
    if (host.managedState && host.managedState !== 'ready') {
      return { error: `${host.label} is ${host.managedState}. Start it first, then try again.` }
    }
    const open = this.connections.get(host.connectionKey)
    if (open) {
      open.routing.target = host
      open.link.followRoutes()
      return open.host
    }
    const reconnected = new Set<() => void>()
    let hasConnected = false
    const routing = { target: host }
    // Only a route that does not carry the credential in clear; the link applies the rest of the dial rules.
    const routes = () => routing.target.routes.filter(safeHostDialRoute)
    const [first] = dialableRoutes(routes(), '', this.selfInstallationId())
    if (!first) return { error: `${host.label} has no secure route from this host. Use its Tailscale address or its HTTPS address.` }
    const answersAsTarget = (url: string, signal: AbortSignal) => this.answersAsTarget(routing.target, url, signal)
    const transport: WsTransport = new WsTransport({
      serverUrl: first.url,
      serverId: host.hostId,
      // Every dial presents the credential again: the person's host-reach token, or
      // the introduced token after the introduced host proves its identity.
      // A host has no sign-in of its own to end: a dial with no credential is retried.
      // An introduced or forwarded host issued its own session token; the account's is an access token.
      grants: { acquire: () => host.credential(), isSignedOut: () => false, tokenKind: host.source === 'account' ? 'access-token' : 'session-token' },
      // Defense in depth: a dial on an `http:` route waits for the target's proof before its credential goes.
      proveRoute: (url) => {
        const route = routing.target.routes.find((candidate) => candidate.url === url) ?? { url }
        return routeNeedsProof(route) ? answersAsTarget(url, AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS)) : null
      },
      // A dial the link did not check first: the socket is dropped unless it answers as the target.
      verifyConnectedHost: () => answersAsTarget(transport.serverUrl, AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS)),
      dialOrganizationId: () => host.organizationId ?? null,
    })
    const link: HostLink = new HostLink({
      hostId: host.hostId,
      transport,
      api: asHostApi(transport.buildSolusApi()),
      routes,
      answersAsHost: answersAsTarget,
      fetchImpl: this.fetchImpl,
      localHostId: this.selfInstallationId(),
      onReadinessChange: (readiness) => {
        log.info('remote_host_phase', { hostId: host.hostId, readiness })
        if (readiness !== 'ready') return
        if (hasConnected) for (const listener of reconnected) listener()
        hasConnected = true
        // Its server info says where it is reached and how it proves itself.
        void link.facts.refresh('serverInfo')
      },
      onAdvertised: (advertised) => this.learn(routing.target, advertised),
    })
    link.start()
    const remote: RemoteHost = {
      hostId: host.hostId,
      installationId: host.installationId,
      label: host.label,
      api: link.api,
      events: link.events,
      onReconnected: (listener) => {
        reconnected.add(listener)
        return () => { reconnected.delete(listener) }
      },
      call: (what, request) => withTimeout(request(), () => {
        const refused = host.source === 'introduced' ? ' It refused this host\'s introduction. Connect to both hosts from one of your devices again.' : ' It refused the token from your Solus account.'
        const blocked = link.refusedReason === 'auth' ? refused : ''
        return `${host.label} did not answer ${what} within ${CALL_TIMEOUT_MS / 1000} s.${blocked}`
      }),
    }
    this.connections.set(host.connectionKey, { routing, host: remote, link })
    return remote
  }

  /** Closes every connection to one host, as when its introduction is replaced or forgotten. */
  disconnect(installationId: string): void {
    for (const [key, open] of this.connections) {
      if (open.host.installationId !== installationId) continue
      open.link.destroy()
      this.connections.delete(key)
    }
  }

  close(): void {
    for (const { link } of this.connections.values()) link.destroy()
    this.connections.clear()
  }
}

function withTimeout<T>(work: Promise<T>, message: () => string, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

