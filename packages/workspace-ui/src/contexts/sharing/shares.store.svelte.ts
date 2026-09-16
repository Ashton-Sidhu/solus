import { SvelteMap } from 'svelte/reactivity'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { OrganizationDirectory } from '@solus/contracts/uplink'
import type { ShareLink, ShareList, ShareResource, ShareRole, ShareSetRequest } from '@solus/contracts/sharing'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { loadServers, type SavedServerUplink } from '@solus/client-core/server-registry'
import { organizationIdFor } from '@solus/client-core/uplink-session'
import { serversStore } from '../connections/servers.store.svelte'
import { toasts } from '../../lib/toasts'
import { guestLinkContext, type GuestLinkContext } from '../../components/sharing/lib/share-rows'
import { uplinkStore } from '../connections/uplink.store.svelte'

/**
 * Share lists per host (docs/plans/multiplayer-sharing.md §4). The host owns every
 * row; this store caches what it answered, re-reads on `share.changed`, and holds
 * the one share dialog every surface opens.
 */

export interface ShareDialogTarget {
  serverId: string
  resource: ShareResource
  title: string
}

/** Who this client is to one host, as the host told it. */
export interface HostIdentity {
  principal: ConnectionsServerInfo['principal']
  userId: string | null
  organizationId: string | null
}

function listKey(serverId: string, resource: ShareResource): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}

class SharesStore {
  readonly lists = new SvelteMap<string, ShareList>()
  readonly identities = new SvelteMap<string, HostIdentity>()
  readonly directories = new SvelteMap<string, OrganizationDirectory | null>()
  dialog = $state<ShareDialogTarget | null>(null)
  busy = $state(false)
  private readonly loads = new Map<string, Promise<ShareList | null>>()
  private stopWatching: (() => void) | null = null

  /** Subscribe once; every host's `share.changed` refreshes the cached list. */
  watch(): void {
    if (this.stopWatching) return
    this.stopWatching = subscribeAllHosts('share.changed', (serverId, change) => {
      const key = listKey(serverId, change.resource)
      if (this.lists.has(key) || this.dialog && listKey(this.dialog.serverId, this.dialog.resource) === key) {
        void this.load(serverId, change.resource, { force: true })
      }
      const me = this.identities.get(serverId)?.userId
      if (me && change.removedUserIds.includes(me)) {
        toasts.info(`Access removed by ${change.changedBy.displayName}`)
        this.lists.delete(key)
      }
    })
  }

  listFor(serverId: string, resource: ShareResource): ShareList | undefined {
    return this.lists.get(listKey(serverId, resource))
  }

  async load(serverId: string, resource: ShareResource, options: { force?: boolean } = {}): Promise<ShareList | null> {
    this.watch()
    const key = listKey(serverId, resource)
    if (!options.force) {
      const cached = this.lists.get(key)
      if (cached) return cached
      const inFlight = this.loads.get(key)
      if (inFlight) return inFlight
    }
    const load = serverConnections.apiFor(serverId).shareGet({ resource })
      .then((list) => {
        this.lists.set(key, list)
        return list
      })
      .catch(() => {
        // Not shared with this client, or an older host: the badge stays quiet.
        this.lists.delete(key)
        return null
      })
      .finally(() => { this.loads.delete(key) })
    this.loads.set(key, load)
    return load
  }

  /**
   * What the account's directory last said about this host. The desktop's own host
   * is `local` and never in the registry under that id, so the row is also found by
   * installation id, which the directory merge keys on.
   */
  private savedUplinkFor(serverId: string): SavedServerUplink | undefined {
    const saved = loadServers()
    const byId = saved.find((server) => server.id === serverId)
    if (byId) return byId.uplink
    const host = serversStore.hostFor(serverId)
    const installationId = host && 'installationId' in host ? host.installationId : undefined
    return installationId ? saved.find((server) => server.installationId === installationId)?.uplink : undefined
  }

  /**
   * Who this client is to the host. The host names the organization only for a
   * member it admitted through one; the owner is `local-owner` or `remote-owner`
   * and the host never learns which organization it is shared with, so the
   * directory row the account merged into the registry fills that in.
   */
  async identityFor(serverId: string): Promise<HostIdentity> {
    const cached = this.identities.get(serverId)
    if (cached) return cached
    const info = await serverConnections.apiFor(serverId).connectionsGetServerInfo()
    const identity: HostIdentity = {
      principal: info.principal,
      userId: info.userId ?? null,
      organizationId: organizationIdFor(info.organizationId, this.savedUplinkFor(serverId)),
    }
    this.identities.set(serverId, identity)
    return identity
  }

  /** The organization's people and teams, once per host; null when this client has no account or the host has no organization. */
  async directoryFor(serverId: string): Promise<OrganizationDirectory | null> {
    if (this.directories.has(serverId)) return this.directories.get(serverId) ?? null
    const identity = await this.identityFor(serverId)
    const source = uplinkAccountSource()
    const directory = identity.organizationId && source ? await source.loadOrganizationDirectory(identity.organizationId) : null
    this.directories.set(serverId, directory)
    return directory
  }

  /**
   * The guest link needs the host id and the account origin the host is listed
   * under. The host itself is the authority (`uplinkStatus`): the desktop's own
   * host is never in the saved-server registry, and a directory row only reaches
   * the registry once an account has merged it in. The saved row is the fallback
   * for an older host that cannot answer.
   */
  linkContext(serverId: string): GuestLinkContext {
    const saved = loadServers().find((server) => server.id === serverId)
    return guestLinkContext(uplinkStore.statusFor(serverId), saved?.uplink)
  }

  open(target: ShareDialogTarget): void {
    this.dialog = target
    void this.load(target.serverId, target.resource, { force: true })
    void this.reloadDirectory(target.serverId)
    void uplinkStore.refresh(target.serverId)
  }

  /**
   * A host shared with a team on the website a moment ago must show its people
   * now: re-read the account's directory, then forget what this host's identity
   * and organization directory said before.
   */
  private async reloadDirectory(serverId: string): Promise<void> {
    await serversStore.refreshDirectory()
    this.identities.delete(serverId)
    this.directories.delete(serverId)
    await this.directoryFor(serverId)
  }

  close(): void {
    this.dialog = null
  }

  async setGrants(serverId: string, request: ShareSetRequest): Promise<void> {
    await this.run(serverId, request.resource, () => serverConnections.apiFor(serverId).shareSet(request))
  }

  async setLink(serverId: string, resource: ShareResource, role: ShareRole | null, regenerate = false): Promise<ShareLink | null> {
    let link: ShareLink | null = null
    await this.run(serverId, resource, async () => {
      link = await serverConnections.apiFor(serverId).shareSetLink({ resource, role, regenerate })
      return null
    })
    return link
  }

  async transfer(serverId: string, resource: ShareResource, toUserId: string): Promise<void> {
    await this.run(serverId, resource, () => serverConnections.apiFor(serverId).shareTransfer({ resource, toUserId }))
  }

  private async run(serverId: string, resource: ShareResource, change: () => Promise<ShareList | null>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const list = await change()
      if (list) this.lists.set(listKey(serverId, resource), list)
      else await this.load(serverId, resource, { force: true })
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'Could not change sharing')
    } finally {
      this.busy = false
    }
  }
}

export const sharesStore = new SharesStore()
