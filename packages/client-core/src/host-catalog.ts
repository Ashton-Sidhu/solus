/// <reference types="vite/client" />
/**
 * The one in-memory owner of the hosts a client knows (plans/033 §4.1). It joins
 * three answers by host id: the person's host list (`HostListSource`), the
 * account directory (its hosts and the organizations' workspace services), and
 * this device's credentials (`host-credentials.ts`). Only the credentials are
 * kept on the device; the rest is read again on each start (§3 Q2).
 *
 * Framework-free: the desktop and web hosts store and the mobile store each wrap
 * it, and `ServerConnections` reads it to dial. The join itself is `host-join.ts`.
 */

import type { HostListing } from '@solus/contracts/host-list'
import type { HostOperatingSystem, DiscoveredServer } from '@solus/contracts/types'
import type { UplinkDirectory } from '@solus/contracts/uplink'
import type { ForwardedHost } from '@solus/contracts/remote-machines'
import { routeForUrl, routesFrom, withReadRoutes, type HostRoute, type RouteSource } from '@solus/contracts/host-routes'
import type { HostListSource } from './host-list-source'
import { DEVICE_ROUTE_SOURCES, deviceRoutes, localStorageCredentials, type HostCredential, type HostCredentialStorage } from './host-credentials'
import { getActiveServerId, LOCAL_SERVER_ID, pairedAddress, setActiveServerId, type KnownHost } from './known-host'
import { workspaceFor, type KnownWorkspace } from './workspace-registry'
import { windowOrganizationSelection } from './organization-selection'
import { takeStartupDirectoryRead, uplinkAccountSource } from './uplink-account'
import type { AdvertisedHost } from './host-link'
import type { RouteHolder } from './host-route-control'
import { credentialOf, joinHosts, listingOf, type CatalogAnswers, type DirectoryAnswer, type LearnedFacts } from './host-join'

/** Where one answer is: not read yet, read, or never read because each read failed (§3 Q2). */
export type AnswerState = 'loading' | 'ready' | 'failed'

/** What the catalog needs of the account's sign-in. */
export interface HostDirectoryReader {
  /** Null when signed out or the account did not answer. */
  listDirectory(): Promise<UplinkDirectory | null>
  isSignedOut(): boolean
}

export interface HostCatalogOptions {
  credentials: HostCredentialStorage
  /** The account's directory now; null where this client has no account. */
  directory?: () => HostDirectoryReader | null
  /** A directory read that boot started already (web); taken once. */
  startupDirectory?: () => Promise<UplinkDirectory | null> | null
  now?: () => number
  /** The page's origin: an `https:` page cannot reach an `http:`-only directory host. */
  clientOrigin?: () => string
}

/** What `pair` did: the host, and why its listing did not reach the list (it is sent again at the next read). */
export interface PairOutcome {
  host: KnownHost
  listError: Error | null
}

export class HostCatalog {
  private readonly credentials = new Map<string, HostCredential>()
  private loaded: Promise<void> | null = null
  private source: HostListSource | null = null
  private stopSourceEvents: (() => void) | null = null
  /** The list's last answer for the current source; null before one. */
  private listings: Map<string, HostListing> | null = null
  /** Listings this client wrote that no read has confirmed yet; each is sent again at the next read. */
  private readonly unconfirmed = new Map<string, HostListing>()
  private listStateValue: AnswerState = 'loading'
  private listGeneration = 0
  private directory: DirectoryAnswer | null = null
  private directoryStateValue: AnswerState = 'loading'
  private directorySignedInValue: boolean | null = null
  private directoryRead: Promise<void> | null = null
  private readonly learned = new Map<string, LearnedFacts>()
  /** The host that served this web page; null elsewhere (the desktop's own host is `LOCAL_SERVER_ID`). */
  private deviceHostId: string | null = null
  /** Hosts known for this page only (`addPageHost`): never saved, never on a list. */
  private readonly pageHosts = new Map<string, KnownHost>()
  private joined: KnownHost[] = []
  private byId = new Map<string, KnownHost>()
  private managedIds: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()
  private readonly forgottenListeners = new Set<(host: KnownHost) => void>()

  constructor(private readonly options: HostCatalogOptions) {}

  /** Reads this device's credentials once. Boot awaits it before it dials; every command awaits it too. */
  load(): Promise<void> {
    this.loaded ??= this.options.credentials.read().then((stored) => {
      for (const [hostId, credential] of stored) if (!this.credentials.has(hostId)) this.credentials.set(hostId, credential)
      this.rejoin()
    }, () => {})
    return this.loaded
  }

  hosts(): readonly KnownHost[] {
    return this.joined
  }

  find(id: string): KnownHost | undefined {
    return this.byId.get(id)
  }

  /**
   * A host this device paired, from its credential alone: known before any list
   * names it. A web page served by a host dials that host first, because the
   * person's list is read there (§4.5). Null when this device holds no token for it.
   */
  pairedHost(id: string): KnownHost | null {
    const credential = this.credentials.get(id)
    if (!credential?.token) return null
    const alone: CatalogAnswers = { listings: new Map(), listState: 'failed', directory: null, credentials: new Map([[id, credential]]), learned: this.learned }
    return this.find(id) ?? joinHosts(alone, (this.options.now ?? Date.now)(), this.options.clientOrigin?.() ?? globalThis.location?.origin ?? '')[0] ?? null
  }

  /**
   * A host this client knows for this page only: the desktop's own machine, a page's
   * serving host this browser does not keep, or a guest's shared resource. It joins
   * `hosts()` like any other host but is never saved and never put on a list. A host
   * the catalog already knows by this id keeps its own entry.
   */
  addPageHost(host: KnownHost): void {
    this.pageHosts.set(host.id, host)
    this.rejoin()
  }

  /**
   * Names the host that served this web page (plans/031 D7). A host's list holds the
   * hosts the person connected to from it, not the host itself: the device host is
   * never put on a list, and §3 Q1 never deletes its credential, as no list names it.
   */
  setDeviceHost(id: string | null): void {
    if (id === this.deviceHostId) return
    this.deviceHostId = id
    if (id) this.unconfirmed.delete(id)
    this.rejoin()
  }

  /** The hosts provisioned for an organization (`uplink.kind === 'managed'`). */
  managedHostIds(): ReadonlySet<string> {
    return this.managedIds
  }

  /** The organizations' workspace services, as the directory last listed them. */
  workspaces(): readonly KnownWorkspace[] {
    return this.directory?.workspaces ?? []
  }

  /** The workspace service a `workspace:<organizationId>` id names; null when none. */
  workspaceFor(serviceId: string): KnownWorkspace | null {
    return workspaceFor(this.workspaces(), serviceId)
  }

  listState(): AnswerState {
    return this.listStateValue
  }

  directoryState(): AnswerState {
    return this.directoryStateValue
  }

  /** What the directory's last read said about the sign-in: null until one settles. */
  directorySignedIn(): boolean | null {
    return this.directorySignedInValue
  }

  /** The key of the source the list is read from now (`HostListSource.key`); null with none. */
  listSourceKey(): string | null {
    return this.source?.key ?? null
  }

  /** Every change of what `hosts()`, `workspaces()`, or a state answers. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * A host leaves this client: forgotten here, replaced by a host paired again at its
   * address, or forgotten on another device (§3 Q1). Its caches leave with it.
   */
  onForgotten(listener: (host: KnownHost) => void): () => void {
    this.forgottenListeners.add(listener)
    return () => this.forgottenListeners.delete(listener)
  }

  /**
   * Reads the list from another source (signing in or out changes it; 031 D7) and
   * reads it at once. The credentials stay. Each listed host this client holds a
   * credential for goes to the new source at its first read, so a sign-in does not
   * forget the hosts paired while signed out. The same key keeps the list as it is.
   */
  useListSource(next: HostListSource | null): Promise<void> {
    if (next?.key === this.source?.key && this.source) {
      this.source = next
      return this.refreshList()
    }
    this.stopSourceEvents?.()
    this.stopSourceEvents = null
    if (this.source) this.carryPairedHosts()
    this.source = next
    this.listings = null
    this.listStateValue = 'loading'
    this.listGeneration += 1
    this.rejoin()
    if (!next) return Promise.resolve()
    // Another client of the same list changed it: read it again.
    this.stopSourceEvents = next.subscribe?.(() => void this.refreshList()) ?? null
    return this.refreshList()
  }

  /**
   * The hosts this device paired that the old source names go to the next source.
   * When no read of the old source succeeded, it is not known which ones it names,
   * so each host this device holds a token for goes: a sign-in or sign-out never
   * loses a pairing of this device to §3 Q1.
   */
  private carryPairedHosts(): void {
    if (this.listings) {
      for (const listing of this.listings.values()) {
        if (this.credentials.get(listing.id)?.token && listing.id !== this.deviceHostId) this.unconfirmed.set(listing.id, listing)
      }
      return
    }
    for (const id of this.credentials.keys()) {
      if (this.unconfirmed.has(id)) continue
      const host = this.pairedHost(id)
      const listing = host ? this.listingToSend(host) : null
      if (listing) this.unconfirmed.set(id, listing)
    }
  }

  /** Reads both answers again. */
  async refresh(): Promise<void> {
    await Promise.all([this.refreshList(), this.refreshDirectory()])
  }

  /**
   * Reads the person's list. A failed read keeps the last answer; before any answer
   * the list is `failed` (§3 Q2). A read that a newer read or another source
   * overtook is dropped.
   */
  async refreshList(): Promise<void> {
    await this.load()
    const source = this.source
    if (!source) return
    const generation = ++this.listGeneration
    const listed = await source.read()
    if (generation !== this.listGeneration || source !== this.source) return
    if (!listed) {
      if (this.listStateValue === 'loading') {
        this.listStateValue = 'failed'
        this.rejoin()
      }
      return
    }
    this.listings = new Map(listed.map((listing) => [listing.id, listing]))
    this.listStateValue = 'ready'
    // A write that the list now holds is confirmed; one it does not is sent again,
    // while this device still holds the host's credential.
    for (const [id, listing] of this.unconfirmed) {
      if (this.listings.has(id) || !this.credentials.get(id)?.token) this.unconfirmed.delete(id)
      else void this.send(listing)
    }
    this.forgetUnnamed()
    this.rejoin()
  }

  /**
   * Reads the account's directory: its hosts and the organizations' workspace
   * services. Signed out, the answer is that there are none. A failed read keeps
   * the last answer. A read in flight is shared.
   */
  refreshDirectory(): Promise<void> {
    this.directoryRead ??= this.readDirectory().finally(() => { this.directoryRead = null })
    return this.directoryRead
  }

  private async readDirectory(): Promise<void> {
    await this.load()
    const reader = this.options.directory?.() ?? null
    const directory = reader ? await (this.options.startupDirectory?.() ?? reader.listDirectory()).catch(() => null) : null
    this.directorySignedInValue = !!directory
    if (!directory && reader && !reader.isSignedOut()) {
      if (this.directoryStateValue === 'loading') this.directoryStateValue = 'failed'
      this.rejoin()
      return
    }
    this.directory = directory
      ? { directoryUrl: directory.directoryUrl, hosts: directory.hosts, workspaces: directory.workspaces.map((workspace) => ({ ...workspace, directoryUrl: directory.directoryUrl })) }
      : null
    this.directoryStateValue = 'ready'
    this.forgetUnnamed()
    this.rejoin()
  }

  /**
   * Pairs a host: writes this device's credential, then puts the listing to the
   * person's list (§4.1). A host paired again at the same address after a reinstall
   * replaces the old one. A listing that does not reach the list is kept here and
   * sent again at the next read; `listError` says why.
   */
  async pair(paired: KnownHost): Promise<PairOutcome> {
    await this.load()
    const address = pairedAddress(paired)
    const replaced = address
      ? this.joined.find((host) => host.id !== paired.id && !!this.credentials.get(host.id)?.token && pairedAddress(host) === address)
      : undefined
    if (replaced) await this.forget(replaced.id).catch(() => this.dropCredential(replaced))
    const credential = credentialOf(paired)
    await this.options.credentials.write(paired.id, credential)
    this.credentials.set(paired.id, credential)
    this.learned.delete(paired.id)
    const listing = this.listingToSend(paired)
    if (listing) this.unconfirmed.set(listing.id, listing)
    this.rejoin()
    const listError = listing ? await this.send(listing) : null
    return { host: this.find(paired.id) ?? paired, listError }
  }

  /**
   * Forgets a host on this client: removes its listing from the person's list, then
   * deletes this device's credential (§4.1). A list that does not answer deletes
   * nothing, and the call throws. A host the directory lists stays listed there:
   * the caller ends that registration first.
   */
  async forget(id: string): Promise<void> {
    await this.load()
    const host = this.find(id)
    if (!this.source && (this.credentials.get(id)?.token || this.listings?.has(id))) {
      throw new Error('The host list is not read yet; forget the host again in a moment.')
    }
    const mayBeListed = this.listStateValue !== 'ready' || !!this.listings?.has(id) || this.unconfirmed.has(id)
    if (mayBeListed) await this.source?.remove(id)
    this.unconfirmed.delete(id)
    this.listings?.delete(id)
    this.learned.delete(id)
    if (host) this.announceForgotten(host)
    if (this.credentials.delete(id)) await this.options.credentials.remove(id)
    if (getActiveServerId() === id) setActiveServerId(LOCAL_SERVER_ID)
    this.rejoin()
  }

  /** This device's session token for the host; empty when it holds none. A transport reads it at each dial. */
  sessionTokenOf(id: string): string {
    return this.credentials.get(id)?.token || this.pageHosts.get(id)?.sessionToken || ''
  }

  /** The host renewed `previous` as `token`. A pairing that replaced `previous` meanwhile keeps its own token. */
  async renewToken(id: string, previous: string, token: string): Promise<void> {
    await this.load()
    const pageHost = this.pageHosts.get(id)
    if (pageHost && !this.credentials.has(id)) {
      if (pageHost.sessionToken === previous) this.addPageHost({ ...pageHost, sessionToken: token })
      return
    }
    const credential = this.credentials.get(id)
    if (!credential || credential.token !== previous || credential.token === token) return
    await this.writeCredential(id, { ...credential, token })
    this.rejoin()
  }

  /** This client connected to the host now. */
  touchLastConnected(id: string): void {
    if (!this.find(id)) return
    this.learn(id, { lastConnected: (this.options.now ?? Date.now)() })
    this.rejoin()
    this.sendListingOf(id)
  }

  /** What `/health` said the host runs on. */
  stampOperatingSystem(id: string, os: HostOperatingSystem): void {
    const host = this.find(id)
    if (!host || host.os === os) return
    const pageHost = this.pageHosts.get(id)
    if (pageHost && !this.credentials.has(id)) {
      this.addPageHost({ ...pageHost, os })
      return
    }
    this.learn(id, { os })
    this.rejoin()
    this.sendListingOf(id)
  }

  /**
   * Keeps what a connected host says about itself (docs/plans/host-routes.md D2): its
   * routes replace its earlier `host` routes, and its identity key is kept when this
   * client has none yet. The connection that carried it already passed the identity
   * check. Null when nothing changed.
   */
  applyAdvertised(id: string, advertised: AdvertisedHost): KnownHost | null {
    const host = this.find(id)
    if (!host) return null
    const routes = withReadRoutes(host.routes, advertised.routes, 'host', (this.options.now ?? Date.now)())
    const identityKey = host.identityKey ?? advertised.identityKey
    if (!routes && identityKey === host.identityKey) return null
    if (routes) this.keepRoutes(host, routes, 'host')
    if (identityKey !== host.identityKey) {
      const credential = this.credentials.get(id)
      if (credential) void this.writeCredential(id, { ...credential, identityKey })
      else this.learn(id, { identityKey })
    }
    this.rejoin()
    this.sendListingOf(id)
    return this.find(id) ?? null
  }

  /**
   * Keeps the forwarded routes the same as the forwards this machine's own host
   * holds (D7). A forward's port can change when it opens again, and a host that is
   * no longer forwarded loses its forwarded route. Only the machine that holds the
   * forwards calls this. False when nothing changed.
   */
  applyForwarded(forwarded: readonly ForwardedHost[]): boolean {
    const byInstallation = new Map(forwarded.map((host) => [host.installationId, host.route]))
    return this.applyRead('ssh', (host) => {
      const route = byInstallation.get(host.installationId)
      return route ? [route] : []
    })
  }

  /**
   * A scan of this client's networks (docs/plans/host-routes.md D1): each host the
   * scan found gets the address it answered at as a `discovery` route. A host the
   * scan did not find keeps its earlier discovery route until it expires, so a laptop
   * that comes back to the network dials the host there again. False when nothing changed.
   */
  applyDiscovered(discovered: readonly DiscoveredServer[]): boolean {
    const found = new Map(discovered.map((server) => [server.installationId, server]))
    return this.applyRead('discovery', (host) => {
      const nearby = found.get(host.installationId)
      return nearby ? [routeForUrl(`http://${nearby.host}:${nearby.port}`, nearby.source === 'tailnet')] : null
    })
  }

  /**
   * A person changed a host's routes (`host-route-control.ts`). This device's routes
   * and their order go to its credential; a host this device holds no token for
   * keeps them as a credential with no token. Null when the host is not known.
   */
  async changeRoutes(id: string, change: (holder: RouteHolder) => RouteHolder): Promise<KnownHost | null> {
    await this.load()
    const host = this.find(id)
    if (!host) return null
    const changed = change({ routes: host.routes, routeOrder: host.routeOrder, tokenPairedOverHttps: host.tokenPairedOverHttps, uplink: host.uplink })
    const credential = this.credentials.get(id) ?? { token: '', routes: [] }
    const next: HostCredential = { ...credential, routes: deviceRoutes(changed.routes) }
    if (changed.routeOrder) next.routeOrder = changed.routeOrder
    else delete next.routeOrder
    await this.writeCredential(id, next)
    this.rejoin()
    // A pairing route is in the host's listing, so the listing changes with it.
    this.sendListingOf(id)
    return this.find(id) ?? null
  }

  private applyRead(source: RouteSource, incoming: (host: KnownHost) => HostRoute[] | null): boolean {
    const now = (this.options.now ?? Date.now)()
    let changed = false
    for (const host of this.joined) {
      const read = incoming(host)
      const routes = read ? withReadRoutes(host.routes, read, source, now) : null
      if (!routes) continue
      changed = true
      this.keepRoutes(host, routes, source)
    }
    if (!changed) return false
    this.rejoin()
    return true
  }

  /** Keeps one source's routes: in the credential when it is this device's and the device holds one, else for this run only. */
  private keepRoutes(host: KnownHost, routes: readonly HostRoute[], source: RouteSource): void {
    const credential = this.credentials.get(host.id)
    if (credential && DEVICE_ROUTE_SOURCES.has(source)) {
      void this.writeCredential(host.id, { ...credential, routes: deviceRoutes(routes) })
      return
    }
    const learned = this.learned.get(host.id)
    this.learn(host.id, { routes: { ...learned?.routes, [source]: routesFrom(routes, source) } })
  }

  private learn(id: string, facts: LearnedFacts): void {
    this.learned.set(id, { ...this.learned.get(id), ...facts })
  }

  private async writeCredential(id: string, credential: HostCredential): Promise<void> {
    this.credentials.set(id, credential)
    await this.options.credentials.write(id, credential).catch(() => {})
  }

  /** Sends the listing of a host this client paired again when what the list holds of it changed. */
  private sendListingOf(id: string): void {
    const host = this.find(id)
    const listing = host ? this.listingToSend(host) : null
    if (!listing || !this.credentials.get(id)?.token) return
    this.unconfirmed.set(id, listing)
    void this.send(listing)
  }

  /** The listing this client puts on the list for a host; null for the device host, which is never on a list. */
  private listingToSend(host: KnownHost): HostListing | null {
    return host.id === this.deviceHostId ? null : listingOf(host)
  }

  /** Puts a listing to the list; null when it landed. It stays unconfirmed until a read holds it. */
  private async send(listing: HostListing): Promise<Error | null> {
    const source = this.source
    if (!source) return new Error('The host list is not read yet; the host goes on it at the next read.')
    try {
      await source.put(listing)
      if (source === this.source) this.listings?.set(listing.id, listing)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * §3 Q1: once the list and the directory both answered, a credential for a host
   * that neither names was forgotten elsewhere (or the list was wiped), so it is
   * deleted here too. Only a successful read calls this: a failed read deletes nothing.
   * The device host is exempt: no list names it (`setDeviceHost`).
   */
  private forgetUnnamed(): void {
    if (this.listStateValue !== 'ready' || this.directoryStateValue !== 'ready' || !this.listings) return
    const named = new Set([...this.listings.keys(), ...this.unconfirmed.keys()])
    for (const host of this.directory?.hosts ?? []) named.add(host.installationId)
    if (this.deviceHostId) named.add(this.deviceHostId)
    for (const id of this.credentials.keys()) {
      if (named.has(id)) continue
      const host = this.find(id) ?? { id, label: id, sessionToken: '', installationId: id, lastConnected: 0, routes: [] }
      this.dropCredential(host)
    }
  }

  private dropCredential(host: KnownHost): void {
    this.announceForgotten(host)
    this.credentials.delete(host.id)
    this.learned.delete(host.id)
    void this.options.credentials.remove(host.id).catch(() => {})
  }

  private announceForgotten(host: KnownHost): void {
    for (const listener of this.forgottenListeners) listener(host)
  }

  private rejoin(): void {
    const listings = new Map(this.listings ?? [])
    for (const [id, listing] of this.unconfirmed) listings.set(id, listing)
    this.joined = joinHosts({
      listings,
      listState: this.listStateValue,
      directory: this.directory,
      credentials: this.credentials,
      learned: this.learned,
      deviceHostId: this.deviceHostId,
    }, (this.options.now ?? Date.now)(), this.options.clientOrigin?.() ?? globalThis.location?.origin ?? '')
    // The desktop's own machine is one host: a listing of it from another device joins its page entry.
    const localInstallationIds = new Set([...this.pageHosts.values()].filter((host) => host.local).map((host) => host.installationId))
    const known = this.joined.filter((host) => !localInstallationIds.has(host.installationId))
    const knownIds = new Set(known.map((host) => host.id))
    this.joined = [...[...this.pageHosts.values()].filter((host) => !knownIds.has(host.id)), ...known]
    this.byId = new Map(this.joined.map((host) => [host.id, host]))
    this.managedIds = new Set(this.joined.filter((host) => host.uplink?.kind === 'managed').map((host) => host.id))
    for (const listener of this.listeners) listener()
  }
}

/**
 * One catalog per page, as `serverConnections` is one registry per page: a
 * re-evaluated module would otherwise hold a second, empty catalog. Desktop and
 * web keep their credentials in `localStorage`; mobile builds its own catalog with
 * its keychain.
 */
export const hostCatalog: HostCatalog = import.meta.hot
  ? (import.meta.hot.data.hostCatalog ??= browserHostCatalog())
  : browserHostCatalog()

function browserHostCatalog(): HostCatalog {
  return new HostCatalog({
    credentials: localStorageCredentials(),
    directory: () => uplinkAccountSource(),
    startupDirectory: takeStartupDirectoryRead,
  })
}

/** The organization this window works in, read from the catalog's workspaces; null with none. */
export function activeOrganizationId(): string | null {
  return windowOrganizationSelection.reconcile(hostCatalog.workspaces())
}
