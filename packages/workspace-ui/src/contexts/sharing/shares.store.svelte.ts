import { workspaceHostId } from '@solus/contracts/uplink'
import type { WorksStore } from '../works/works.store.svelte'
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
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { grantsFor, guestLinkContext, linkRoleFor, sameScope, scopeOf, withPersonRole, withoutPerson, type GuestLinkContext, type ShareScope } from '../../components/sharing/lib/share-rows'
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
  accountConnectionsUrl?: string
  principal: ConnectionsServerInfo['principal']
  userId: string | null
  organizationId: string | null
}

function listKey(serverId: string, resource: ShareResource): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}

class SharesStore {
  works: WorksStore | null = null
  readonly lists = new SvelteMap<string, ShareList>()
  readonly identities = new SvelteMap<string, HostIdentity>()
  readonly directories = new SvelteMap<string, OrganizationDirectory | null>()
  dialog = $state<ShareDialogTarget | null>(null)
  busy = $state(false)
  private readonly loads = new Map<string, Promise<ShareList | null>>()
  private readonly linkStatusAsked = new Set<string>()
  private stopWatching: (() => void) | null = null

  /** Subscribe once; every host's `share.changed` refreshes the cached list. */
  watch(): void {
    if (this.stopWatching) return
    this.stopWatching = subscribeAllHosts('share.changed', (serverId, change) => {
      const key = listKey(serverId, change.resource)
      if (this.lists.has(key) || this.dialog && listKey(this.dialog.serverId, this.dialog.resource) === key) {
        void this.load(serverId, change.resource, { force: true })
      }
      // A task's share reaches its sessions and works: their cached lists say so and must follow.
      if (change.resource.kind === 'task') {
        for (const cachedKey of this.lists.keys()) {
          if (cachedKey.startsWith(`${serverId}|`) && !cachedKey.startsWith(`${serverId}|task|`)) {
            const [, kind, id] = cachedKey.split('|')
            if (kind === 'session' || kind === 'work') void this.load(serverId, { kind, id: id! }, { force: true })
          }
        }
      }
      const me = this.identities.get(serverId)?.userId
      if (me && change.removedUserIds.includes(me)) {
        if (notificationsStore.wants('share_revoked')) toasts.info(`Access removed by ${change.changedBy.displayName}`)
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
  async identityFor(serverId: string, refresh = false): Promise<HostIdentity> {
    const cached = this.identities.get(serverId)
    if (cached && !refresh) return cached
    const info = await serverConnections.apiFor(serverId).connectionsGetServerInfo()
    const identity: HostIdentity = {
      principal: info.principal,
      accountConnectionsUrl: info.accountConnectionsUrl,
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

  /**
   * Whether a share made on this host can reach anyone. A guest link needs the
   * cloud to mint the grant and route the tunnel, and the directory needs an
   * organization the cloud named, so an unlinked host can share with nobody:
   * every Share entry point hides behind this. Asks the host once; until it
   * answers, the answer is no.
   */
  canShareFrom(serverId: string): boolean {
    if (!this.linkStatusAsked.has(serverId)) {
      this.linkStatusAsked.add(serverId)
      void uplinkStore.refresh(serverId)
    }
    return this.linkContext(serverId).kind === 'linked'
  }

  open(target: ShareDialogTarget): void {
    if (this.busy) return
    this.busy = true
    void this.openCloud(target).catch((error) => toasts.error(error instanceof Error ? error.message : 'Could not open cloud sharing')).finally(() => { this.busy = false })
  }

  private async openCloud(target: ShareDialogTarget): Promise<void> {
    await serversStore.refreshDirectory()
    const saved = loadServers().find((server) => server.id === target.serverId)
    let cloudServerId = target.serverId
    if (saved?.uplink?.kind !== 'cloud') {
      const identity = await this.identityFor(target.serverId)
      if (!identity.organizationId) throw new Error('Sign in and connect this host to an organization before sharing.')
      cloudServerId = workspaceHostId(identity.organizationId)
      if (target.resource.kind === 'work') {
        if (!this.works) throw new Error('The workspace is still loading.')
        this.works.rememberHost(target.resource.id, target.serverId)
        await this.works.moveToCloud(target.resource.id, cloudServerId)
      }
    }
    const list = await this.load(cloudServerId, target.resource, { force: true })
    if (!list) throw new Error('This resource has not reached Solus cloud yet. Open its cloud copy before sharing.')
    this.dialog = { ...target, serverId: cloudServerId }
    await this.reloadDirectory(cloudServerId)
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

  /**
   * Who can open a resource and what they may do, as one choice: the named rows
   * and the link change together so the list never lands between two scopes. A
   * scope that is already the list's, role included, is a no-op; a role change on
   * the link keeps its secret, so guests stay connected with the new role.
   */
  async setScope(serverId: string, list: ShareList, scope: ShareScope): Promise<void> {
    if (sameScope(scopeOf(list), scope)) return
    const organizationId = this.identities.get(serverId)?.organizationId ?? null
    await this.setGrants(serverId, grantsFor(scope, list, organizationId))
    const linkRole = linkRoleFor(scope)
    if (linkRole !== (list.link?.role ?? null)) await this.setLink(serverId, list.resource, linkRole)
  }

  /** One person's own row, added or changed; every other row and the link stay as they are. */
  async setPersonRole(serverId: string, list: ShareList, userId: string, role: ShareRole): Promise<void> {
    await this.setGrants(serverId, withPersonRole(list, userId, role))
  }

  async removePerson(serverId: string, list: ShareList, userId: string): Promise<void> {
    await this.setGrants(serverId, withoutPerson(list, userId))
  }

  async setLink(serverId: string, resource: ShareResource, role: ShareRole | null, regenerate = false): Promise<ShareLink | null> {
    let link: ShareLink | null = null
    await this.run(serverId, resource, async () => {
      link = await serverConnections.apiFor(serverId).shareSetLink({ resource, role, regenerate })
      return null
    })
    return link
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
