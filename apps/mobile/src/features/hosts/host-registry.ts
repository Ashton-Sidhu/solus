import { z } from 'zod'
import { hostRouteSchema, type DirectoryHost, type HostRoute } from '@solus/contracts/uplink'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { SavedServerUplink } from '@solus/client-core/server-registry'
import { forwardCompatibleArray } from '@solus/client-core/forward-compat'
import { savedServerFromDirectory } from '@solus/client-core/uplink-session'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'

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
  os?: HostOperatingSystem
  lastConnected: number
  /** True when the device holds a session token from `/pair` for this host. */
  paired: boolean
  /** Present while the signed-in account's directory lists the host. */
  uplink?: SavedServerUplink
  /** The account whose directory listed the host. Cloud state is forgotten by it. */
  accountUserId?: string
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
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  lastConnected: z.number().catch(0),
  paired: z.boolean().catch(false),
  uplink: uplinkSchema.optional().catch(undefined),
  accountUserId: z.string().optional().catch(undefined),
})
const hostsSchema = forwardCompatibleArray(hostSchema)

/** Called with the id of every host that leaves the registry, so its
 *  connection, queued sends, drafts, and caches leave with it. */
export type HostRemovedListener = (hostId: string) => void

export class HostRegistry {
  private list: readonly NativeHost[] = []
  private readonly tokens = new Map<string, string>()
  private readonly removedListeners = new Set<HostRemovedListener>()
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

  /** Saves a host paired on this device. Other hosts are kept. */
  async savePaired(input: { id: string; label: string; hasUserLabel?: boolean; url: string; os?: HostOperatingSystem }, sessionToken: string): Promise<NativeHost> {
    await this.secrets.set(tokenKey(input.id), sessionToken)
    this.tokens.set(input.id, sessionToken)
    const existing = this.host(input.id)
    const direct: HostRoute = { kind: 'direct', url: input.url }
    const routes = [direct, ...(existing?.routes ?? []).filter((route) => route.url !== input.url)]
    const host: NativeHost = {
      ...existing,
      id: input.id,
      label: existing?.hasUserLabel && !input.hasUserLabel ? existing.label : input.label,
      hasUserLabel: input.hasUserLabel || existing?.hasUserLabel,
      routes,
      os: input.os ?? existing?.os,
      lastConnected: Date.now(),
      paired: true,
    }
    this.replace(host)
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

  /** Cloud sign-out: cloud-derived hosts leave; directly paired hosts stay. */
  forgetAccount(accountUserId: string): void {
    this.applyDirectory(accountUserId, '', [])
  }

  /** Forget a host: its credential, queued work, drafts, caches, and connection. */
  async forget(hostId: string): Promise<void> {
    if (!this.host(hostId)) return
    this.list = this.list.filter((host) => host.id !== hostId)
    this.write()
    this.tokens.delete(hostId)
    await this.secrets.delete(tokenKey(hostId))
    this.cleanUp(hostId)
    this.changes.notify()
  }

  private fromDirectory(entry: DirectoryHost, directoryUrl: string, accountUserId: string, existing?: NativeHost): NativeHost {
    const saved = savedServerFromDirectory(entry, directoryUrl, Date.now())
    const directRoutes = (existing?.routes ?? []).filter((route) => route.kind === 'direct' && !saved.routes?.some((listed) => listed.url === route.url))
    return {
      id: entry.installationId,
      label: existing?.hasUserLabel ? existing.label : saved.label,
      hasUserLabel: existing?.hasUserLabel,
      routes: [...directRoutes, ...(saved.routes ?? [])],
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
  const directRoutes = host.routes.filter((route) => route.kind === 'direct')
  return { ...rest, routes: directRoutes }
}
