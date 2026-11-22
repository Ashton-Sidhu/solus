import { mergeRoutes, routeForUrl } from '@solus/contracts/host-routes'
import type { DiscoveredServer, HostOperatingSystem } from '@solus/contracts/types'
import type { AdvertisedHost } from '@solus/client-core/host-link'
import { HostCatalog, type AnswerState, type HostDirectoryReader, type PairOutcome } from '@solus/client-core/host-catalog'
import { decodeCredentials, encodeCredentials, type HostCredential, type HostCredentialStorage } from '@solus/client-core/host-credentials'
import type { HostListSource } from '@solus/client-core/host-list-source'
import type { KnownHost } from '@solus/client-core/known-host'
import type { KnownWorkspace } from '@solus/client-core/workspace-registry'
import { withoutRoute, withRouteMoved, withUserRoute } from '@solus/client-core/host-route-control'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'

/**
 * The hosts this phone knows (plans/033 §4.3). The phone keeps only its
 * credentials: each paired host's session token in the keychain, and how this
 * phone dials the host (its own routes, their order, the identity key) in plain
 * storage. The client-core host catalog joins them with the person's host list
 * and the account directory; this store gives the catalog to the native screens.
 */

const CREDENTIALS_KEY = 'solus.mobile.hostCredentials'
/** Before plan 033 the phone kept whole hosts here. It is deleted, not read (§2 rule 5). */
const RETIRED_HOSTS_KEY = 'solus.mobile.hosts.v1'
const tokenKey = (hostId: string) => `solus.mobile.hostToken.${hostId}`

/**
 * The catalog's credential port on the phone. A token goes to its own keychain
 * item, which stays small; the other fields are not secret and go to plain storage.
 * A token is written before its record and removed after it.
 */
export function keychainCredentials(storage: KeyValueStore, secrets: SecretStore): HostCredentialStorage {
  const readRecords = (): Map<string, HostCredential> => {
    const raw = storage.getItem(CREDENTIALS_KEY)
    if (!raw) return new Map()
    const decoded = decodeCredentials(raw)
    if (decoded) return decoded
    storage.removeItem(CREDENTIALS_KEY)
    return new Map()
  }
  const writeRecords = (records: ReadonlyMap<string, HostCredential>): void => {
    if (records.size === 0) storage.removeItem(CREDENTIALS_KEY)
    else storage.setItem(CREDENTIALS_KEY, encodeCredentials(records))
  }
  return {
    read: async () => {
      storage.removeItem(RETIRED_HOSTS_KEY)
      const credentials = readRecords()
      await Promise.all([...credentials].map(async ([hostId, credential]) => {
        credential.token = (await secrets.get(tokenKey(hostId))) ?? ''
      }))
      return credentials
    },
    write: async (hostId, credential) => {
      if (credential.token) await secrets.set(tokenKey(hostId), credential.token)
      else await secrets.delete(tokenKey(hostId))
      const records = readRecords()
      records.set(hostId, { ...credential, token: '' })
      writeRecords(records)
    },
    remove: async (hostId) => {
      const records = readRecords()
      if (records.delete(hostId)) writeRecords(records)
      await secrets.delete(tokenKey(hostId))
    },
  }
}

/** Called with the id of every host that leaves, so its connection, queued sends, drafts, and caches leave with it. */
export type HostRemovedListener = (hostId: string) => void

/** What the person pairs on this phone: the host's answer to `/pair` and the address they paired it at. */
export interface PairedHostInput {
  id: string
  label: string
  hasUserLabel?: boolean
  url: string
  os?: HostOperatingSystem
  identityKey?: string
  onTailnet?: boolean
  /** The owner host's pairing this token came from, when the phone followed one (`HostCredential.ownerPairedAt`). */
  ownerPairedAt?: number
}

export class HostRegistry {
  private readonly catalog: HostCatalog
  /** Every change of the hosts or of a read's state; the native screens subscribe to it. */
  readonly changes = new Listeners()
  private readonly removedListeners = new Set<HostRemovedListener>()
  /** The ids `hosts()` answered at the last change. */
  private shownIds = new Set<string>()

  constructor(storage: KeyValueStore, secrets: SecretStore, directory: () => HostDirectoryReader | null) {
    // The phone dials from no page: every route is open to it.
    this.catalog = new HostCatalog({ credentials: keychainCredentials(storage, secrets), directory, clientOrigin: () => '' })
    // A host forgotten here, or whose credential went because no list names it (§3 Q1).
    this.catalog.onForgotten((host) => {
      this.shownIds.delete(host.id)
      this.announceRemoved(host.id)
    })
    this.catalog.onChange(() => {
      // A host can also leave without a credential: the account's list or directory no longer names it.
      const shown = new Set(this.catalog.hosts().map((host) => host.id))
      for (const hostId of this.shownIds) if (!shown.has(hostId)) this.announceRemoved(hostId)
      this.shownIds = shown
      this.changes.notify()
    })
  }

  /** The load barrier: the credentials are read before any host is dialed. */
  load(): Promise<void> {
    return this.catalog.load()
  }

  hosts = (): readonly KnownHost[] => this.catalog.hosts()

  host(hostId: string): KnownHost | undefined {
    return this.catalog.find(hostId)
  }

  /** The session token for a paired host; empty for a host dialed with a grant. */
  credential(hostId: string): string {
    return this.catalog.find(hostId)?.sessionToken ?? ''
  }

  /** The person's host list: `loading` before its first read, `failed` while no read succeeded (§3 Q2). */
  listState = (): AnswerState => this.catalog.listState()

  /** The account directory, in the same states. Signed out it is `ready` with no hosts. */
  directoryState = (): AnswerState => this.catalog.directoryState()

  /** The organizations' workspace services, as the directory last listed them. */
  workspaces(): readonly KnownWorkspace[] {
    return this.catalog.workspaces()
  }

  /** Signing in or out changes where the list is read (plans/031 D7). The credentials stay. */
  useListSource(source: HostListSource | null): Promise<void> {
    return this.catalog.useListSource(source)
  }

  refreshList(): Promise<void> {
    return this.catalog.refreshList()
  }

  refreshDirectory(): Promise<void> {
    return this.catalog.refreshDirectory()
  }

  onHostRemoved(listener: HostRemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => { this.removedListeners.delete(listener) }
  }

  /**
   * Keeps a host paired on this phone: its credential first, then its listing on
   * the person's list. A listing the list refused is sent again at the next read;
   * `listError` says why.
   */
  savePaired(input: PairedHostInput, sessionToken: string): Promise<PairOutcome> {
    const now = Date.now()
    const host: KnownHost = {
      id: input.id,
      label: input.label,
      sessionToken,
      installationId: input.id,
      routes: mergeRoutes([], [routeForUrl(input.url, input.onTailnet)], 'pairing', now),
      lastConnected: now,
    }
    if (input.hasUserLabel) host.hasUserLabel = true
    if (input.os) host.os = input.os
    if (input.identityKey) host.identityKey = input.identityKey
    if (input.url.startsWith('https:')) host.tokenPairedOverHttps = true
    if (input.ownerPairedAt !== undefined) host.ownerPairedAt = input.ownerPairedAt
    return this.catalog.pair(host)
  }

  /** The host's `/auth/refresh` renewed `previous` as `sessionToken`. */
  updateCredential(hostId: string, previous: string, sessionToken: string): Promise<void> {
    return this.catalog.renewToken(hostId, previous, sessionToken)
  }

  /** This phone connected to the host now; `os` is what its `/health` said. */
  touch(hostId: string, os?: HostOperatingSystem): void {
    this.catalog.touchLastConnected(hostId)
    if (os) this.catalog.stampOperatingSystem(hostId, os)
  }

  /** A scan of this phone's network: each known host it found gets the address it answered at. */
  applyNearby(discovered: readonly DiscoveredServer[]): void {
    this.catalog.applyDiscovered(discovered)
  }

  /** What a connected host says about itself (docs/plans/host-routes.md D2). */
  applyAdvertised(hostId: string, advertised: AdvertisedHost): void {
    this.catalog.applyAdvertised(hostId, advertised)
  }

  /** A route the person added and this phone checked (`checkRouteToAdd`). It stays on this phone. */
  async addRoute(hostId: string, url: string): Promise<void> {
    await this.catalog.changeRoutes(hostId, (holder) => withUserRoute(holder, url, Date.now()))
  }

  /** One place earlier (-1) or later (1) in this phone's order. */
  async moveRoute(hostId: string, url: string, step: -1 | 1): Promise<void> {
    await this.catalog.changeRoutes(hostId, (holder) => withRouteMoved(holder, url, step))
  }

  /** A route the person removed. A pairing route is in the host's listing, so the listing changes with it. */
  async removeRoute(hostId: string, url: string): Promise<void> {
    await this.catalog.changeRoutes(hostId, (holder) => withoutRoute(holder, url))
  }

  /**
   * Forgets a host: its listing leaves the person's list, then its credential leaves
   * this phone (§4.1), and its connection, queued work, drafts, and caches with it.
   * Throws, and forgets nothing, when the list does not answer.
   */
  forget(hostId: string): Promise<void> {
    return this.catalog.forget(hostId)
  }

  private announceRemoved(hostId: string): void {
    for (const listener of Array.from(this.removedListeners)) listener(hostId)
  }
}
