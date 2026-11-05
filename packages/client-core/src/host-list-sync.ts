import type { AccountHostListResponse, HostListing } from '@solus/contracts/host-list'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { HostRoute } from '@solus/contracts/host-routes'
import type { HostListCloudRequests } from './host-list-requests'
import { LOCAL_SERVER_ID, loadServers, onServerRemoving, onServerSaved, saveServers, type SavedServer } from './server-registry'

/**
 * The client's side of the host list (plans/031 D7). The list has one source at a
 * time: the host this client runs beside while the person is signed out, their
 * account document while signed in. This client's registry (`server-registry.ts`)
 * is a cache of the list beside its own tokens: a pull folds the source into it,
 * and a host this client pairs or forgets goes to the source. A token never
 * leaves the client, so a host another device paired is listed here without one
 * until this client pairs it too.
 */

/** Where the list is read and written. A read answers null when the source cannot answer now. */
export interface HostListSource {
  /** Names the source in this client's storage: one record of synced ids per source. */
  readonly key: string
  read(): Promise<HostListing[] | null>
  put(listing: HostListing): Promise<void>
  remove(id: string): Promise<void>
}

/** A host the person connected to themselves: paired, added over SSH, or forwarded. A host known only from the directory is not one. */
export function listingOf(server: SavedServer): HostListing | null {
  if (server.id === LOCAL_SERVER_ID || server.uplink?.kind === 'managed') return null
  const routes = server.routes.filter((route) => route.source !== 'directory')
  if (!server.sessionToken && routes.length === 0) return null
  const listing: HostListing = { id: server.id, label: server.label, installationId: server.installationId, routes, lastConnected: server.lastConnected }
  if (server.hasUserLabel) listing.hasUserLabel = true
  if (server.os) listing.os = server.os
  if (server.identityKey) listing.identityKey = server.identityKey
  return listing
}

function serverOf(listing: HostListing): SavedServer {
  const server: SavedServer = { id: listing.id, label: listing.label, sessionToken: '', installationId: listing.installationId, lastConnected: listing.lastConnected, routes: listing.routes }
  if (listing.hasUserLabel) server.hasUserLabel = true
  if (listing.os) server.os = listing.os
  if (listing.identityKey) server.identityKey = listing.identityKey
  return server
}

/** This client's routes, then the listing's routes at addresses it does not have. */
function joinRoutes(own: readonly HostRoute[], listed: readonly HostRoute[]): HostRoute[] {
  const known = new Set(own.map((route) => route.url))
  return [...own, ...listed.filter((route) => !known.has(route.url))]
}

export interface HostListReconcile {
  saved: SavedServer[]
  /** Hosts this client holds that the source never had: new here, to be written to it. */
  toPut: HostListing[]
  /** The ids the source and this client now agree on: the next reconcile's `synced`. */
  synced: string[]
}

/**
 * Folds the source's list into the cache. `synced` is the ids this client and the
 * source agreed on at the last reconcile: a host in it that the source no longer
 * has was removed elsewhere and leaves the cache; a host not in it is new here and
 * goes to the source. A host only the source has joins the cache without a token.
 * A host both have keeps this client's token and directory link and takes the
 * source's name and routes.
 */
export function reconcileHostList(saved: readonly SavedServer[], listings: readonly HostListing[], synced: ReadonlySet<string>): HostListReconcile {
  const byId = new Map(listings.map((listing) => [listing.id, listing]))
  const next: SavedServer[] = []
  const toPut: HostListing[] = []
  for (const server of saved) {
    const listed = byId.get(server.id)
    const own = listingOf(server)
    if (!listed) {
      if (!own) next.push(server)
      else if (synced.has(server.id)) {
        // Removed on another device. A directory link keeps the host as a directory host.
        if (server.uplink) next.push({ ...server, sessionToken: '', routes: server.routes.filter((route) => route.source === 'directory') })
      } else {
        next.push(server)
        toPut.push(own)
      }
      continue
    }
    byId.delete(server.id)
    const merged: SavedServer = { ...server, label: listed.label, routes: joinRoutes(server.routes, listed.routes), lastConnected: Math.max(server.lastConnected, listed.lastConnected) }
    if (listed.hasUserLabel) merged.hasUserLabel = true
    if (listed.os) merged.os = listed.os
    merged.identityKey = server.identityKey ?? listed.identityKey
    next.push(merged)
  }
  for (const listing of byId.values()) next.push(serverOf(listing))
  return { saved: next, toPut, synced: [...listings.map((listing) => listing.id), ...toPut.map((listing) => listing.id)] }
}

// ─── Sources ───

/** The host this client runs beside, while the person is signed out. */
export function hostListHostSource(serverId: string, api: Pick<SolusAPI, 'hostListRead' | 'hostListPut' | 'hostListRemove'>): HostListSource {
  return {
    key: `host:${serverId}`,
    read: () => api.hostListRead().catch(() => null),
    put: (listing) => api.hostListPut(listing),
    remove: (id) => api.hostListRemove(id),
  }
}

/** A write that keeps meeting a newer revision gives up after this many reads. */
const ACCOUNT_WRITE_ATTEMPTS = 3

/**
 * The person's account document, while they are signed in. A write names only the
 * host it changes, so a revision that moved between the read and the write is read
 * again and the write sent once more: two devices that change different hosts
 * never conflict.
 */
export function hostListAccountSource(accountKey: string, requests: HostListCloudRequests): HostListSource {
  let current: AccountHostListResponse | null = null
  const write = async (set: Record<string, HostListing>, reset: string[]): Promise<void> => {
    for (let attempt = 1; attempt <= ACCOUNT_WRITE_ATTEMPTS; attempt += 1) {
      if (!current) {
        const read = await requests.accountHostListGet()
        if (read.kind !== 'ok') return
        current = read.hosts
      }
      const result = await requests.accountHostListPatch({ generation: current.generation, expectedRevision: current.revision, set, reset })
      if (result.kind === 'ok') {
        current = result.hosts
        return
      }
      if (result.kind !== 'conflict') return
      current = result.current
    }
  }
  return {
    key: `account:${accountKey}`,
    read: async () => {
      const result = await requests.accountHostListGet()
      if (result.kind !== 'ok') return null
      current = result.hosts
      return Object.values(result.hosts.hosts)
    },
    put: (listing) => write({ [listing.id]: listing }, []),
    remove: (id) => write({}, [id]),
  }
}

// ─── Sync ───

const SYNCED_KEY = 'solus.hostList.synced:'

function loadSynced(sourceKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(SYNCED_KEY + sourceKey)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSynced(sourceKey: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(SYNCED_KEY + sourceKey, JSON.stringify([...new Set(ids)]))
  } catch {
    // A full or blocked store costs one more push at the next pull.
  }
}

/**
 * Follows one source: `pull` folds it into the registry, and a host this client
 * saves or forgets is written to it. `use` changes the source when the person signs
 * in or out; the next pull reads the new one.
 */
export class HostListSync {
  private source: HostListSource | null = null
  private pulling: Promise<boolean> | null = null

  constructor() {
    onServerSaved((server) => {
      const listing = listingOf(server)
      const source = this.source
      if (!listing || !source) return
      void source.put(listing).then(() => this.markSynced(source.key, listing.id), () => {})
    })
    onServerRemoving((server) => {
      const source = this.source
      if (!source || !listingOf(server)) return
      void source.remove(server.id).then(() => this.unmarkSynced(source.key, server.id), () => {})
    })
  }

  use(source: HostListSource | null): void {
    this.source = source
  }

  /** Reads the source and folds it into the registry. True when the registry changed. */
  pull(): Promise<boolean> {
    this.pulling ??= this.pullNow().finally(() => { this.pulling = null })
    return this.pulling
  }

  private async pullNow(): Promise<boolean> {
    const source = this.source
    if (!source) return false
    const listings = await source.read()
    if (!listings || source !== this.source) return false
    const before = loadServers()
    const result = reconcileHostList(before, listings, loadSynced(source.key))
    saveServers(result.saved)
    saveSynced(source.key, result.synced)
    await Promise.all(result.toPut.map((listing) => source.put(listing).catch(() => {})))
    return JSON.stringify(before) !== JSON.stringify(result.saved)
  }

  private markSynced(sourceKey: string, id: string): void {
    const synced = loadSynced(sourceKey)
    synced.add(id)
    saveSynced(sourceKey, synced)
  }

  private unmarkSynced(sourceKey: string, id: string): void {
    const synced = loadSynced(sourceKey)
    synced.delete(id)
    saveSynced(sourceKey, synced)
  }
}
