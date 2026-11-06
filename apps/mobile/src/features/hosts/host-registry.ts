import { z } from 'zod'
import { type DirectoryHost } from '@solus/contracts/uplink'
import { hostRouteSchema, joinListedRoutes, listedRoutes, mergeRoutes, routeForUrl, withReadRoutes, type HostRoute } from '@solus/contracts/host-routes'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import type { AdvertisedHost } from '@solus/client-core/host-link'
import { withoutRoute, withRouteMoved, withUserRoute } from '@solus/client-core/host-route-control'
import type { DiscoveredServer, HostOperatingSystem } from '@solus/contracts/types'
import type { SavedServerUplink } from '@solus/client-core/server-registry'
import { forwardCompatibleArray } from '@solus/client-core/forward-compat'
import { savedServerFromDirectory } from '@solus/client-core/uplink-session'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'
import type { HostListing } from '@solus/contracts/host-list'

/**
 * The hosts this device knows (plan 017 stage 1). Metadata is kept in plain
 * storage; each paired host's session token is kept in the keychain under its
 * own key. A host from the Solus Cloud directory has no stored credential: each
 * dial mints its own short grant.
 *
 * A paired host and a cloud host can be one machine. Pairing it never removes
 * another host, and signing out of the cloud never removes a host the user
 * paired directly — it only drops what the directory said about it.
 */

export interface NativeHost {
  /** The host's installation id: the identity a dial is verified against. */
  id: string
  label: string
  /** The user typed the label; the host's advertised name then does not replace it. */
  hasUserLabel?: boolean
  routes: HostRoute[]
  /** Route URLs in the order the person chose on this device (docs/plans/host-routes.md §12). Absent is the default order. */
  routeOrder?: string[]
  /** Addresses the person removed on this device: a listing does not bring them back. */
  removedRoutes?: string[]
  /** The session token was paired over HTTPS, so it stays off routes that carry it in clear. */
  tokenPairedOverHttps?: boolean
  os?: HostOperatingSystem
  lastConnected: number
  /** True when the device holds a session token from `/pair` for this host. */
  paired: boolean
  /** Present while the signed-in account's directory lists the host. */
  uplink?: SavedServerUplink
  /** The account whose directory listed the host. Cloud state is forgotten by it. */
  accountUserId?: string
  /** The host's identity key (docs/plans/host-routes.md D3): an `http:` route is dialed only after the host proves it. */
  identityKey?: string
}

const HOSTS_KEY = 'solus.mobile.hosts.v1'
const tokenKey = (hostId: string) => `solus.mobile.host.${hostId}.token`

const uplinkSchema = z.looseObject({
  hostId: z.string().min(1),
  directoryUrl: z.string().min(1),
  organizationIds: z.array(z.string().min(1)).optional().catch(undefined),
  category: z.enum(['personal', 'self-hosted', 'managed']).optional().catch(undefined),
  ownerName: z.string().optional().catch(undefined),
  ownerUserId: z.string().optional().catch(undefined),
  kind: z.enum(['personal', 'managed']).optional().catch(undefined),
  managedState: z.enum(['provisioning', 'starting', 'ready', 'stopping', 'stopped', 'failed', 'deleting']).optional().catch(undefined),
})

const hostSchema = z.object({
  id: z.string().min(1),
  label: z.string().catch(''),
  hasUserLabel: z.boolean().optional().catch(undefined),
  routes: forwardCompatibleArray(hostRouteSchema).catch([]),
  routeOrder: z.array(z.string()).optional().catch(undefined),
  removedRoutes: z.array(z.string()).optional().catch(undefined),
  tokenPairedOverHttps: z.boolean().optional().catch(undefined),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  lastConnected: z.number().catch(0),
  paired: z.boolean().catch(false),
  uplink: uplinkSchema.optional().catch(undefined),
  accountUserId: z.string().optional().catch(undefined),
  identityKey: hostIdentityKeySchema.optional().catch(undefined),
})
const hostsSchema = forwardCompatibleArray(hostSchema)

/** Called with the id of every host that leaves the registry, so its
 *  connection, queued sends, drafts, and caches leave with it. */
export type HostRemovedListener = (hostId: string) => void

/** A host the person paired or forgot on this device, for the account host list (plans/031 D7). */
export type HostListingChange = { kind: 'put'; listing: HostListing } | { kind: 'remove'; hostId: string }

/** A host the person paired on this device, as the account host list holds it: never its token. */
export function listingOfHost(host: NativeHost): HostListing | null {
  if (!host.paired || host.uplink?.kind === 'managed') return null
  const listing: HostListing = { id: host.id, label: host.label, installationId: host.id, routes: listedRoutes(host.routes), lastConnected: host.lastConnected }
  if (host.hasUserLabel) listing.hasUserLabel = true
  if (host.os) listing.os = host.os
  if (host.identityKey) listing.identityKey = host.identityKey
  return listing
}

export class HostRegistry {
  private list: readonly NativeHost[] = []
  private readonly tokens = new Map<string, string>()
  private readonly removedListeners = new Set<HostRemovedListener>()
  private readonly listingListeners = new Set<(change: HostListingChange) => void>()
  private loaded: Promise<void> | null = null
  readonly changes = new Listeners()

  constructor(
    private readonly storage: KeyValueStore,
    private readonly secrets: SecretStore,
  ) {}

  /** The load barrier: nothing restores a route or dials before it settles. */
  load(): Promise<void> {
    this.loaded ??= this.readStorage()
    return this.loaded
  }

  private async readStorage(): Promise<void> {
    let hosts: NativeHost[] = []
    try {
      const raw = this.storage.getItem(HOSTS_KEY)
      const decoded = raw ? hostsSchema.safeParse(JSON.parse(raw)) : null
      if (decoded?.success) hosts = decoded.data
      else if (raw) this.storage.removeItem(HOSTS_KEY)
    } catch {
      this.storage.removeItem(HOSTS_KEY)
    }
    const kept: NativeHost[] = []
    for (const host of hosts) {
      if (!host.paired) { kept.push(host); continue }
      const token = await this.secrets.get(tokenKey(host.id))
      // A paired host whose token is gone (a restored backup, a cleared keychain)
      // stays only if the directory can still reach it.
      if (token) {
        this.tokens.set(host.id, token)
        kept.push(host)
      } else if (host.uplink) {
        kept.push({ ...host, paired: false })
      }
    }
    this.list = kept
    if (kept.length !== hosts.length || kept.some((host, index) => host !== hosts[index])) this.write()
    this.changes.notify()
  }

  hosts = (): readonly NativeHost[] => this.list

  host(hostId: string): NativeHost | undefined {
    return this.list.find((host) => host.id === hostId)
  }

  /** The session token for a paired host; empty for a host dialed with a grant. */
  credential(hostId: string): string {
    return this.tokens.get(hostId) ?? ''
  }

  onHostRemoved(listener: HostRemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => { this.removedListeners.delete(listener) }
  }

  /** Hears each host the person pairs or forgets here, for the account host list. */
  onListingChange(listener: (change: HostListingChange) => void): () => void {
    this.listingListeners.add(listener)
    return () => { this.listingListeners.delete(listener) }
  }

  /**
   * Folds the account host list into this device's hosts (plans/031 D7), as
   * `reconcileHostList` does on desktop and web. `synced` is the ids the device and
   * the list agreed on before: a paired host in it that the list no longer has was
   * forgotten on another device; one not in it is new here and goes to the list. A
   * host only the list has joins without a token, held for the account: signing out
   * removes it again. Answers what to write to the list and the agreed ids.
   */
  async applyHostList(accountUserId: string, listings: readonly HostListing[], synced: ReadonlySet<string>): Promise<{ toPut: HostListing[]; synced: string[] }> {
    const byId = new Map(listings.map((listing) => [listing.id, listing]))
    const next: NativeHost[] = []
    const toPut: HostListing[] = []
    const forgotten: string[] = []
    for (const host of this.list) {
      const listed = byId.get(host.id)
      if (listed) {
        byId.delete(host.id)
        next.push({ ...host, label: listed.label, hasUserLabel: listed.hasUserLabel ?? host.hasUserLabel, routes: joinListedRoutes(host.routes, listed.routes, host.removedRoutes), os: listed.os ?? host.os, identityKey: host.identityKey ?? listed.identityKey })
        continue
      }
      const own = listingOfHost(host)
      if (own && synced.has(host.id)) {
        if (host.uplink) next.push({ ...host, paired: false })
        forgotten.push(host.id)
        continue
      }
      if (own) toPut.push(own)
      next.push(host)
    }
    for (const listing of byId.values()) {
      next.push({ id: listing.id, label: listing.label, hasUserLabel: listing.hasUserLabel, routes: listing.routes, os: listing.os, lastConnected: listing.lastConnected, paired: false, accountUserId, identityKey: listing.identityKey })
    }
    this.list = next
    this.write()
    for (const hostId of forgotten) {
      this.tokens.delete(hostId)
      await this.secrets.delete(tokenKey(hostId))
      if (!this.host(hostId)) this.cleanUp(hostId)
    }
    this.changes.notify()
    return { toPut, synced: [...listings.map((listing) => listing.id), ...toPut.map((listing) => listing.id)] }
  }

  private announceListing(change: HostListingChange): void {
    for (const listener of Array.from(this.listingListeners)) listener(change)
  }

  /** Saves a host paired on this device. Other hosts are kept. */
  async savePaired(input: { id: string; label: string; hasUserLabel?: boolean; url: string; os?: HostOperatingSystem; identityKey?: string }, sessionToken: string): Promise<NativeHost> {
    await this.secrets.set(tokenKey(input.id), sessionToken)
    this.tokens.set(input.id, sessionToken)
    const existing = this.host(input.id)
    const routes = mergeRoutes(existing?.routes ?? [], [routeForUrl(input.url)], 'pairing', Date.now())
    const host: NativeHost = {
      ...existing,
      id: input.id,
      label: existing?.hasUserLabel && !input.hasUserLabel ? existing.label : input.label,
      hasUserLabel: input.hasUserLabel || existing?.hasUserLabel,
      routes,
      os: input.os ?? existing?.os,
      identityKey: input.identityKey ?? existing?.identityKey,
      tokenPairedOverHttps: input.url.startsWith('https:') || undefined,
      lastConnected: Date.now(),
      paired: true,
    }
    this.replace(host)
    const listing = listingOfHost(host)
    if (listing) this.announceListing({ kind: 'put', listing })
    return host
  }

  /** A refreshed session token from the host's `/auth/refresh`. */
  async updateCredential(hostId: string, sessionToken: string): Promise<void> {
    if (!this.host(hostId)?.paired) return
    this.tokens.set(hostId, sessionToken)
    await this.secrets.set(tokenKey(hostId), sessionToken)
  }

  touch(hostId: string, facts: { os?: HostOperatingSystem; reportedName?: string } = {}): void {
    const host = this.host(hostId)
    if (!host) return
    const label = !host.hasUserLabel && facts.reportedName ? facts.reportedName : host.label
    this.replace({ ...host, lastConnected: Date.now(), os: facts.os ?? host.os, label })
  }

  /**
   * Replaces what one account's directory says. Hosts it no longer lists lose
   * their cloud metadata; a host known only from the directory leaves.
   */
  applyDirectory(accountUserId: string, directoryUrl: string, listed: readonly DirectoryHost[]): void {
    const byId = new Map(listed.map((host) => [host.installationId, host]))
    const next: NativeHost[] = []
    const removed: string[] = []
    for (const host of this.list) {
      const entry = byId.get(host.id)
      if (entry) {
        byId.delete(host.id)
        next.push(this.fromDirectory(entry, directoryUrl, accountUserId, host))
      } else if (host.accountUserId === accountUserId || (host.uplink && host.accountUserId === undefined)) {
        if (host.paired) next.push(withoutCloud(host))
        else removed.push(host.id)
      } else {
        next.push(host)
      }
    }
    for (const entry of byId.values()) next.push(this.fromDirectory(entry, directoryUrl, accountUserId))
    this.list = next
    this.write()
    for (const hostId of removed) this.cleanUp(hostId)
    this.changes.notify()
  }

  /** A scan of this device's network found saved hosts: each gets the address it answered at (`withReadRoutes`). */
  applyNearby(discovered: readonly DiscoveredServer[]): void {
    const nearby = new Map(discovered.map((server) => [server.installationId, server]))
    const now = Date.now()
    let changed = false
    const next = this.list.map((host) => {
      const found = nearby.get(host.id)
      const routes = found ? withReadRoutes(host.routes, [routeForUrl(`http://${found.host}:${found.port}`, found.source === 'tailnet')], 'discovery', now) : null
      if (!routes) return host
      changed = true
      return { ...host, routes }
    })
    if (!changed) return
    this.list = next
    this.write()
    this.changes.notify()
  }

  /**
   * What a connected host says about itself (docs/plans/host-routes.md D2): its routes
   * replace its earlier `host` routes, and its identity key is kept when this device
   * has none yet. The connection that carried it already passed the identity check.
   */
  applyAdvertised(hostId: string, advertised: AdvertisedHost): void {
    const host = this.host(hostId)
    if (!host) return
    const routes = withReadRoutes(host.routes, advertised.routes, 'host', Date.now())
    const identityKey = host.identityKey ?? advertised.identityKey
    if (!routes && identityKey === host.identityKey) return
    this.replace({ ...host, routes: routes ?? host.routes, identityKey })
  }

  /** A route the person added and this device checked (`checkRouteToAdd`). It stays on this device. */
  addRoute(hostId: string, url: string): void {
    const host = this.host(hostId)
    if (host) this.replace(withUserRoute(host, url, Date.now()))
  }

  /** One place earlier (-1) or later (1) in this device's order. */
  moveRoute(hostId: string, url: string, step: -1 | 1): void {
    const host = this.host(hostId)
    if (host) this.replace(withRouteMoved(host, url, step))
  }

  /** A route the person removed. A pairing route is in the host's listing, so the listing changes with it. */
  removeRoute(hostId: string, url: string): void {
    const host = this.host(hostId)
    if (!host) return
    const changed = withoutRoute(host, url)
    this.replace(changed)
    const listing = listingOfHost(changed)
    if (listing) this.announceListing({ kind: 'put', listing })
  }

  /** Cloud sign-out: cloud-derived hosts leave; directly paired hosts stay. */
  forgetAccount(accountUserId: string): void {
    this.applyDirectory(accountUserId, '', [])
  }

  /** Forget a host: its credential, queued work, drafts, caches, and connection. */
  async forget(hostId: string): Promise<void> {
    const host = this.host(hostId)
    if (!host) return
    if (listingOfHost(host)) this.announceListing({ kind: 'remove', hostId })
    this.list = this.list.filter((candidate) => candidate.id !== hostId)
    this.write()
    this.tokens.delete(hostId)
    await this.secrets.delete(tokenKey(hostId))
    this.cleanUp(hostId)
    this.changes.notify()
  }

  private fromDirectory(entry: DirectoryHost, directoryUrl: string, accountUserId: string, existing?: NativeHost): NativeHost {
    const saved = savedServerFromDirectory(entry, directoryUrl, Date.now())
    return {
      ...existing,
      id: entry.installationId,
      label: existing?.hasUserLabel ? existing.label : saved.label,
      hasUserLabel: existing?.hasUserLabel,
      routes: mergeRoutes(existing?.routes ?? [], entry.routes, 'directory', saved.lastConnected),
      os: saved.os ?? existing?.os,
      lastConnected: existing?.lastConnected ?? 0,
      paired: existing?.paired ?? false,
      uplink: saved.uplink,
      accountUserId,
    }
  }

  private replace(host: NativeHost): void {
    const index = this.list.findIndex((candidate) => candidate.id === host.id)
    this.list = index >= 0
      ? this.list.map((candidate, at) => (at === index ? host : candidate))
      : [...this.list, host]
    this.write()
    this.changes.notify()
  }

  private cleanUp(hostId: string): void {
    for (const listener of Array.from(this.removedListeners)) listener(hostId)
  }

  private write(): void {
    this.storage.setItem(HOSTS_KEY, JSON.stringify(this.list))
  }
}

function withoutCloud(host: NativeHost): NativeHost {
  const { uplink: _uplink, accountUserId: _account, ...rest } = host
  return { ...rest, routes: mergeRoutes(host.routes, [], 'directory', Date.now()) }
}
