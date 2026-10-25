import { isSolusApiId } from '@solus/contracts/uplink'
import { SvelteMap } from 'svelte/reactivity'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { ShareLink, ShareList, ShareResource, ShareResourceKind, ShareRole, ShareSetLinkRequest, ShareSetRequest } from '@solus/contracts/sharing'
import type { User } from '@solus/contracts/user'
import type { SessionActionLeaf } from '@solus/contracts/permissions'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { savedWorkspaceFor, workspaceTarget } from '@solus/client-core/workspace-registry'
import { serversStore } from '../connections/servers.store.svelte'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { hostLinkContext, linkPresentation, sameScope, scopeOf, scopeRequestFor, withPersonRole, withoutPerson, type GuestLinkContext, type ShareScope } from '../../components/sharing/lib/share-rows'
import { provideResourceRoles } from './resource-roles'
import { accountStore } from '../account/account.store.svelte'
import { appLinkUrl } from './app-link'
import { uplinkStore } from '../connections/uplink.store.svelte'
import { organizationPeople, type OrganizationPeople } from '../../components/users/lib/organization-people'
import { CloudPublication, type PublishStatus } from './cloud-publication'

/**
 * Share lists per host (docs/plans/multiplayer-sharing.md §4). The host owns every
 * row; this store caches what it answered, re-reads on `share.changed`, and holds
 * the one share dialog every surface opens.
 *
 * The dialog opens on the list of the server that holds the resource
 * (docs/plans/host-sharing.md §2). A session stays on its host, and its link
 * names that host, signed in or not. A work or task in an organization lives on
 * its workspace service. A Local work is pushed there by Share with this
 * client's sign-in (docs/plans/cloud-sharing.md §3): the Share button is the
 * push, so opening Share starts the upload with no second confirmation, and the
 * dialog that follows manages access on the cloud copy.
 */

export interface SharePublication {
  /** The machine the resource lives on, which gives the upload its content. */
  sourceServerId: string
  organizationId: string
  organizationName: string
  status: PublishStatus
}

export interface ShareDialogTarget {
  serverId: string
  resource: ShareResource
  title: string
  /** Set while a Local work uploads: the dialog shows its upload before any share. */
  publication?: SharePublication
}

/** Who this client is to one host, as the host told it. */
export interface HostIdentity {
  accountConnectionsUrl?: string
  principal: ConnectionsServerInfo['principal']
  userId: string | null
  /** The person the host named this client as (plans/012 §1); null for a host that names no one. */
  user: User | null
}

function listKey(serverId: string, resource: ShareResource): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}



export class SharesStore {
  readonly lists = new SvelteMap<string, ShareList>()
  readonly identities = new SvelteMap<string, HostIdentity>()
  readonly directories = new SvelteMap<string, OrganizationPeople | null>()
  dialog = $state<ShareDialogTarget | null>(null)
  busy = $state(false)
  /** Puts a Local work into an organization; a moved resource's old list is dropped. */
  readonly publication = new CloudPublication((serverId, resource) => { this.lists.delete(listKey(serverId, resource)) })
  /** The origin each resource's guest link names (docs/plans/host-sharing.md §2), by list key; absent until the host answers, null when nobody off the host can reach it. */
  readonly linkOrigins = new SvelteMap<string, string | null>()
  private readonly loads = new Map<string, Promise<ShareList | null>>()
  /** Every resource whose link origin was asked, by list key, so a tunnel change asks again. */
  private readonly linkOriginsAsked = new Map<string, { serverId: string; resource: ShareResource }>()
  private stopWatching: (() => void) | null = null

  /** Subscribe once; every host's `share.changed` refreshes the cached list. */
  watch(): void {
    if (this.stopWatching) return
    // The tunnel came up or went down: the host's link origins change with it.
    const stopRoutes = subscribeAllHosts('host.uplinkStatusChanged', (serverId) => {
      for (const asked of this.linkOriginsAsked.values()) {
        if (asked.serverId === serverId) void this.loadLinkOrigin(serverId, asked.resource)
      }
    })
    const stopShares = subscribeAllHosts('share.changed', (serverId, change) => {
      const key = listKey(serverId, change.resource)
      if (this.lists.has(key) || this.dialog && listKey(this.dialog.serverId, this.dialog.resource) === key) {
        void this.load(serverId, change.resource, { force: true })
      }
      const me = this.identities.get(serverId)?.userId
      if (me && change.removedUserIds.includes(me)) {
        if (notificationsStore.wants('share_revoked')) toasts.info(change.changedBy ? `Access removed by ${change.changedBy.displayName}` : 'Access removed')
        this.lists.delete(key)
      }
    })
    this.stopWatching = () => { stopRoutes(); stopShares() }
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

  /** Who this client is to the host. */
  async identityFor(serverId: string, refresh = false): Promise<HostIdentity> {
    const info = await serverConnections.serverInfoFor(serverId, refresh)
    const identity: HostIdentity = {
      principal: info.principal,
      accountConnectionsUrl: info.accountConnectionsUrl,
      userId: info.userId ?? null,
      user: info.user ?? null,
    }
    this.identities.set(serverId, identity)
    return identity
  }

  /**
   * The people and teams of the account's organization, once per host; null when
   * this client has no account or the account has no organization. Sharing names
   * one organization everywhere: the one the account works in, never one the
   * host or a saved directory row suggests. The one member list (plans/012 §6):
   * the account plane's directory becomes `User`s here, once, and every people
   * choice reads them. `refresh` reads it again and keeps the last answer until
   * the new one arrives.
   */
  async directoryFor(serverId: string, refresh = false): Promise<OrganizationPeople | null> {
    if (!refresh && this.directories.has(serverId)) return this.directories.get(serverId) ?? null
    const organizationId = serversStore.activeOrganizationId
    const source = uplinkAccountSource()
    const directory = organizationId && source ? await source.loadOrganizationDirectory(organizationId) : null
    const people = directory ? organizationPeople(directory) : null
    this.directories.set(serverId, people)
    return people
  }

  /**
   * The origin a guest link names (docs/plans/host-sharing.md §2). A record in an
   * organization is on the account origin its workspace service is listed under.
   * A resource on a host is where the host says: the account origin for a mirrored
   * session, else the host's own route; asked once per resource and again when the
   * host's tunnel changes state.
   */
  linkContext(serverId: string, resource: ShareResource): GuestLinkContext {
    if (isSolusApiId(serverId)) {
      const workspace = savedWorkspaceFor(serverId)
      const origin = workspace ? workspaceTarget(workspace).uplink?.directoryUrl : undefined
      return origin ? { kind: 'origin', origin } : { kind: 'checking' }
    }
    const key = listKey(serverId, resource)
    if (!this.linkOriginsAsked.has(key)) void this.loadLinkOrigin(serverId, resource)
    return hostLinkContext(this.linkOrigins.get(key))
  }

  /** The host's own answer about where a resource's link opens; a host that cannot answer offers nowhere. */
  async loadLinkOrigin(serverId: string, resource: ShareResource): Promise<string | null> {
    const key = listKey(serverId, resource)
    this.linkOriginsAsked.set(key, { serverId, resource })
    let origin: string | null = null
    try {
      origin = (await serverConnections.apiFor(serverId).shareLinkOrigin(resource)).origin
    } catch {
      // An older host without the method offers nowhere.
    }
    this.linkOrigins.set(key, origin)
    return origin
  }

  /**
   * Whether this resource can be shared from where it lives
   * (docs/plans/host-sharing.md §2). A session is shared from its host, signed
   * in or not. A work is shared from the cloud: one already there, or a Local
   * one this client can push there, which needs a signed-in organization. A task
   * is not shared: it is seen by its whole organization, and offers its link
   * (`taskLinks`).
   */
  canShareFrom(serverId: string, kind: ShareResourceKind): boolean {
    if (kind === 'task') return false
    if (kind === 'session') return true
    return isSolusApiId(serverId) || (accountStore.state.kind === 'signed-in' && !!serversStore.activeOrganizationId)
  }

  /** Opens the dialog; resolves once it is on screen or the attempt was explained. */
  open(target: ShareDialogTarget): Promise<void> {
    if (this.busy) return Promise.resolve()
    this.busy = true
    return this.openTarget(target)
      .catch((error) => { toasts.error(error instanceof Error ? error.message : 'Could not open cloud sharing') })
      .finally(() => { this.busy = false })
  }

  /**
   * The dialog opens on the list of the server that holds the resource. A session
   * opens on its host. A Local work opens in the upload state, and its upload
   * into the window's organization starts at once: Share is the push; the dialog
   * resolves on screen and the list follows the upload.
   */
  private async openTarget(target: ShareDialogTarget): Promise<void> {
    const cloudServerId = this.publication.cloudHomeOf(target.serverId, target.resource)
    if (cloudServerId) {
      await this.publication.reachCloud(cloudServerId)
      await this.openList(cloudServerId, target)
      return
    }
    if (target.resource.kind === 'session') {
      await this.openList(target.serverId, target)
      return
    }
    const organizationId = accountStore.state.kind === 'signed-in' ? serversStore.activeOrganizationId : null
    if (!organizationId) {
      toasts.error('Sign in to share this work.', { description: 'Share puts a work in your organization on Solus Cloud, where the people you choose can open it.' })
      return
    }
    this.dialog = {
      serverId: target.serverId,
      resource: target.resource,
      title: target.title,
      publication: {
        sourceServerId: target.serverId,
        organizationId,
        organizationName: serversStore.activeOrganizationName ?? 'your organization',
        status: { kind: 'pending' },
      },
    }
    void this.publishDialog(this.dialog)
  }

  /** The dialog on the list of the server that holds the resource; its people load beside it. */
  private async openList(serverId: string, target: ShareDialogTarget): Promise<void> {
    // The last answer stays on screen while a new one loads, so a person the
    // dialog already knows is never shown as a former member in between.
    void this.directoryFor(serverId, true).catch(() => {
      // No people to invite; the list still opens, and stops waiting for them.
      if (!this.directories.has(serverId)) this.directories.set(serverId, null)
    })
    if (!isSolusApiId(serverId)) {
      void this.loadLinkOrigin(serverId, target.resource)
      // Whether members can reach the host decides which scopes the dialog offers (host-sharing.md §4.3).
      void uplinkStore.refresh(serverId)
    }
    const list = await this.load(serverId, target.resource, { force: true })
    if (!list) {
      throw new Error(isSolusApiId(serverId)
        ? 'This resource has not reached Solus Cloud yet. Open its cloud copy before sharing.'
        : `This host could not open sharing for this ${target.resource.kind}.`)
    }
    this.dialog = { serverId, resource: target.resource, title: target.title }
  }

  /** The dialog's Retry after an upload that did not finish: the same destination, the same operation. */
  async publish(): Promise<void> {
    const dialog = this.dialog
    const publication = dialog?.publication
    if (!dialog || !publication || publication.status.kind === 'pending' || this.busy) return
    this.busy = true
    try {
      await this.publishDialog(dialog)
    } finally {
      this.busy = false
    }
  }

  /**
   * Upload the dialog's Local work into its organization, then continue on the
   * organization's list. A failure keeps the dialog in the upload state with a
   * Retry. Closing the dialog meanwhile leaves it closed; the upload finishes.
   */
  private async publishDialog(dialog: ShareDialogTarget): Promise<void> {
    const publication = dialog.publication
    if (!publication) return
    publication.status = { kind: 'pending' }
    try {
      const outcome = await this.publication.upload({
        serverId: publication.sourceServerId,
        resource: dialog.resource,
        organizationId: publication.organizationId,
      })
      // The dialog moved on to something else meanwhile: leave it alone.
      if (this.dialog !== dialog) return
      if (outcome.kind !== 'committed') {
        publication.status = outcome
        return
      }
      await this.openList(outcome.cloudServerId, dialog)
    } catch (error) {
      if (this.dialog === dialog) publication.status = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The link for people the resource is shared with by name, team, or
   * organization: the app's own address on the account origin, opened with each
   * person's sign-in. A session stays on its host, so its link names the host by
   * installation id: the one id every client of that host knows it by. Null when
   * this client has no account origin, or the resource is not on a workspace
   * service or a known host.
   */
  memberLinkUrl(serverId: string, resource: ShareResource): string | null {
    const account = accountStore.state
    if (account.kind !== 'signed-in') return null
    if (isSolusApiId(serverId)) return appLinkUrl(account.consoleUrl, resource, serverId)
    const host = resource.kind === 'session' ? serversStore.hostFor(serverId) : null
    return host && 'installationId' in host && host.installationId ? appLinkUrl(account.consoleUrl, resource, host.installationId) : null
  }

  close(): void {
    this.dialog = null
  }

  async setEntries(serverId: string, request: ShareSetRequest): Promise<void> {
    await this.run(serverId, request.resource, () => serverConnections.apiFor(serverId).shareSet(request))
  }

  /**
   * Who can open a resource and what they may do, as one choice: the named rows
   * and the link change in one call, so the list never lands between two scopes. A
   * scope that is already the list's, role included, is a no-op; a role change on
   * the link keeps its secret, so guests stay connected with the new role.
   */
  async setScope(serverId: string, list: ShareList, scope: ShareScope): Promise<void> {
    if (sameScope(scopeOf(list), scope)) return
    await this.setEntries(serverId, scopeRequestFor(scope, list))
  }

  /** One person's own row, added or changed; every other row and the link stay as they are. */
  async setPersonRole(serverId: string, list: ShareList, userId: string, role: ShareRole): Promise<void> {
    await this.setEntries(serverId, withPersonRole(list, userId, role))
  }

  async removePerson(serverId: string, list: ShareList, userId: string): Promise<void> {
    await this.setEntries(serverId, withoutPerson(list, userId))
  }

  /**
   * The link a person outside the organization reviews a work through: the
   * work's link, raised to `commenter` when it only lets people view. An
   * existing editor or commenter link is kept. Null when the host offers no
   * route a link could name.
   */
  async reviewLink(serverId: string, resource: ShareResource): Promise<string | null> {
    if (!isSolusApiId(serverId) && !(await this.loadLinkOrigin(serverId, resource))) return null
    const list = await this.load(serverId, resource, { force: true })
    if (!list) return null
    if (!list.link || list.link.role === 'viewer') await this.setLink(serverId, resource, 'commenter')
    const current = this.listFor(serverId, resource) ?? list
    const presentation = linkPresentation(current.link, this.linkContext(serverId, resource), true, resource)
    return presentation?.kind === 'url' ? presentation.url : null
  }

  async setLink(serverId: string, resource: ShareResource, role: ShareRole | null, regenerate = false): Promise<ShareLink | null> {
    let link: ShareLink | null = null
    await this.run(serverId, resource, async () => {
      link = await serverConnections.apiFor(serverId).shareSetLink({ resource, role, regenerate })
      // The answer is the whole change: the list is kept with its new link, not read again.
      const list = this.listFor(serverId, resource)
      return list ? { ...list, link } : null
    })
    return link
  }

  /**
   * The link's custom leaves or its lifetime, changed alone: the secret stays, so
   * its guests stay connected with what the link now gives them. `expiresInMs`
   * counts from the host's clock; null never expires.
   */
  async setLinkAccess(serverId: string, list: ShareList, change: { actions?: SessionActionLeaf[]; expiresInMs?: number | null }): Promise<void> {
    const link = list.link
    if (!link) return
    await this.run(serverId, list.resource, async () => {
      const actions = change.actions ?? link.actions
      const request: ShareSetLinkRequest = { resource: list.resource, role: link.role }
      if (link.role === 'custom' && actions) request.actions = [...actions]
      if (change.expiresInMs !== undefined) request.expiresInMs = change.expiresInMs
      const next = await serverConnections.apiFor(serverId).shareSetLink(request)
      const current = this.listFor(serverId, list.resource)
      return current ? { ...current, link: next } : null
    })
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
provideResourceRoles(sharesStore)
