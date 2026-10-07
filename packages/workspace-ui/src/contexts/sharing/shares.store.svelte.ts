import { isSolusApiId, organizationIdOfSolusApiId, solusApiId } from '@solus/contracts/uplink'
import type { WorksStore } from '../works/works.store.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { ShareLink, ShareList, ShareResource, ShareResourceKind, ShareRole, ShareSetRequest } from '@solus/contracts/sharing'
import type { User } from '@solus/contracts/user'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { loadServers, type SavedServerUplink } from '@solus/client-core/server-registry'
import { savedWorkspaceFor, workspaceTarget } from '@solus/client-core/workspace-registry'
import { organizationIdFor } from '@solus/client-core/uplink-session'
import { serversStore } from '../connections/servers.store.svelte'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { guestLinkContext, linkPresentation, sameScope, scopeOf, scopeRequestFor, withPersonRole, withoutPerson, type GuestLinkContext, type ShareScope } from '../../components/sharing/lib/share-rows'
import { publishProblemMessage } from '../../components/sharing/lib/publish-copy'
import { provideShareRoles } from './session-drive'
import { accountStore } from '../account/account.store.svelte'
import { appLinkUrl } from './app-link'
import { uplinkStore } from '../connections/uplink.store.svelte'
import { organizationPeople, type OrganizationPeople } from '../../components/users/lib/organization-people'
import { LOCAL_ORGANIZATION_ID } from '../../lib/organization-filter'

/**
 * Share lists per host (docs/plans/multiplayer-sharing.md §4). The host owns every
 * row; this store caches what it answered, re-reads on `share.changed`, and holds
 * the one share dialog every surface opens.
 *
 * The dialog opens on the list of the server that holds the resource
 * (docs/plans/organization-scope.md §4). A session stays on its host. A work or
 * task in an organization lives on its workspace service. A Local work uploads
 * there first with this client's sign-in (docs/plans/cloud-sharing.md §3): the
 * Share action is the opt-in, so opening Share starts the upload into the
 * organization this window works in, with no second confirmation.
 */

/** How putting a Local work or task into an organization ended. */
export type PublishOutcome =
  | { kind: 'committed'; cloudServerId: string }
  | { kind: 'failed'; error: string }
  /** The machine holding the resource is not connected; nothing can be sent. */
  | { kind: 'offline' }
  /** The organization refused: this account may not publish there. */
  | { kind: 'denied'; error: string }

/** Where a Local work's upload stands, as the dialog shows it. */
export type PublishStatus = { kind: 'pending' } | Exclude<PublishOutcome, { kind: 'committed' }>

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

export interface PublishRequest {
  /** The machine the resource lives on. */
  serverId: string
  resource: ShareResource
  organizationId: string
}

/** Who this client is to one host, as the host told it. */
export interface HostIdentity {
  accountConnectionsUrl?: string
  principal: ConnectionsServerInfo['principal']
  userId: string | null
  /** The person the host named this client as (plans/012 §1); null for a host that names no one. */
  user: User | null
  organizationId: string | null
}

function listKey(serverId: string, resource: ShareResource): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}

export class SharesStore {
  works: WorksStore | null = null
  readonly lists = new SvelteMap<string, ShareList>()
  readonly identities = new SvelteMap<string, HostIdentity>()
  readonly directories = new SvelteMap<string, OrganizationPeople | null>()
  dialog = $state<ShareDialogTarget | null>(null)
  busy = $state(false)
  /** One upload per resource at a time: a second Share or Copy link joins the first. */
  private readonly uploads = new Map<string, { organizationId: string; result: Promise<PublishOutcome> }>()
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
      const me = this.identities.get(serverId)?.userId
      if (me && change.removedUserIds.includes(me)) {
        if (notificationsStore.wants('share_revoked')) toasts.info(change.changedBy ? `Access removed by ${change.changedBy.displayName}` : 'Access removed')
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
   * member it admitted through one; a workspace service is one organization's by
   * its id; the owner of a machine is `local-owner` or `remote-owner` and the host
   * never learns which organizations it is shared with, so the directory row the
   * account merged into the registry fills that in, for the window's organization.
   */
  async identityFor(serverId: string, refresh = false): Promise<HostIdentity> {
    const info = await serverConnections.serverInfoFor(serverId, refresh)
    const identity: HostIdentity = {
      principal: info.principal,
      accountConnectionsUrl: info.accountConnectionsUrl,
      userId: info.userId ?? null,
      user: info.user ?? null,
      organizationId: info.organizationId
        ?? organizationIdOfSolusApiId(serverId)
        ?? organizationIdFor(null, this.savedUplinkFor(serverId), serversStore.activeOrganizationId),
    }
    this.identities.set(serverId, identity)
    return identity
  }

  /**
   * The organization's people and teams, once per host; null when this client has
   * no account or the host has no organization. The one member list (plans/012 §6):
   * the account plane's directory becomes `User`s here, once, and every people
   * choice reads them. `refresh` reads it again and keeps the last answer until
   * the new one arrives.
   */
  async directoryFor(serverId: string, refresh = false): Promise<OrganizationPeople | null> {
    if (!refresh && this.directories.has(serverId)) return this.directories.get(serverId) ?? null
    const identity = await this.identityFor(serverId)
    const source = uplinkAccountSource()
    const directory = identity.organizationId && source ? await source.loadOrganizationDirectory(identity.organizationId) : null
    const people = directory ? organizationPeople(directory) : null
    this.directories.set(serverId, people)
    return people
  }

  /**
   * The guest link needs the host id and the account origin the host is listed
   * under. The host itself is the authority (`uplinkStatus`): the desktop's own
   * host is never in the saved-server registry, and a directory row only reaches
   * the registry once an account has merged it in. The saved row is the fallback
   * for an older host that cannot answer. A workspace service has no link record
   * of its own: its directory entry is what proves it can share.
   */
  linkContext(serverId: string): GuestLinkContext {
    const saved = loadServers().find((server) => server.id === serverId)?.uplink
    const workspace = savedWorkspaceFor(serverId)
    return guestLinkContext(uplinkStore.statusFor(serverId), saved ?? (workspace ? workspaceTarget(workspace).uplink : undefined))
  }

  /**
   * Whether this resource can be shared from where it lives. A work becomes a
   * cloud copy with this client's sign-in (docs/plans/cloud-sharing.md), so it
   * needs an organization, not a linked host. A session stays on its host, and
   * its link opens there, so it needs the host linked. A task is not shared: it
   * is seen by its whole organization, and offers its link (`copyTaskLink`).
   */
  canShareFrom(serverId: string, kind: ShareResourceKind): boolean {
    if (kind === 'task') return false
    if (kind === 'session') return this.isHostLinked(serverId)
    return isSolusApiId(serverId) || !!serversStore.activeOrganizationId
  }

  /**
   * Whether the host is linked to Solus cloud, or is a workspace service. Asks
   * the host once; until it answers, the answer is no.
   */
  isHostLinked(serverId: string): boolean {
    if (!this.linkStatusAsked.has(serverId)) {
      this.linkStatusAsked.add(serverId)
      void uplinkStore.refresh(serverId)
    }
    return this.linkContext(serverId).kind === 'linked'
  }

  /** Opens the dialog; resolves once it is on screen or the attempt was explained. */
  open(target: ShareDialogTarget): Promise<void> {
    if (accountStore.state.kind !== 'signed-in' || this.busy) return Promise.resolve()
    this.busy = true
    return this.openTarget(target)
      .catch((error) => { toasts.error(error instanceof Error ? error.message : 'Could not open cloud sharing') })
      .finally(() => { this.busy = false })
  }

  /**
   * The dialog opens on the list of the server that holds the resource. A Local
   * work opens in the upload state, and its upload into the window's
   * organization starts at once: Share is the opt-in. The dialog resolves on
   * screen; the list follows the upload.
   */
  private async openTarget(target: ShareDialogTarget): Promise<void> {
    const cloudServerId = this.cloudHomeOf(target)
    if (cloudServerId) {
      await this.reachCloud(cloudServerId)
      await this.openList(cloudServerId, target)
      return
    }
    // A session stays on its host for now: Share opens the host's own list and uploads nothing.
    if (target.resource.kind === 'session') {
      await this.openList(target.serverId, target)
      return
    }
    const organizationId = serversStore.activeOrganizationId
    if (!organizationId) {
      toasts.error('Select an organization before sharing.', {
        description: 'Shares live in an organization on Solus Cloud. Sign in and join one, then share.',
      })
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

  /** The workspace service that holds the resource: the server it is on, or the organization a work moved to; null while it is Local. */
  private cloudHomeOf(target: ShareDialogTarget): string | null {
    if (isSolusApiId(target.serverId)) return target.serverId
    if (target.resource.kind !== 'work') return null
    const organizationId = this.works?.works[target.resource.id]?.organizationId
    return organizationId && organizationId !== LOCAL_ORGANIZATION_ID ? solusApiId(organizationId) : null
  }

  /** The dialog on the list of the server that holds the resource; its people load beside it. */
  private async openList(serverId: string, target: ShareDialogTarget): Promise<void> {
    // The last answer stays on screen while a new one loads, so a person the
    // dialog already knows is never shown as a former member in between.
    void this.directoryFor(serverId, true).catch(() => {
      // No people to invite; the list still opens, and stops waiting for them.
      if (!this.directories.has(serverId)) this.directories.set(serverId, null)
    })
    const list = await this.load(serverId, target.resource, { force: true })
    if (!list) {
      throw new Error(isSolusApiId(serverId)
        ? 'This resource has not reached Solus Cloud yet. Open its cloud copy before sharing.'
        : 'This host could not open sharing for this session.')
    }
    this.dialog = { serverId, resource: target.resource, title: target.title }
  }

  /** The organization's workspace service is reached through the account's directory; read it only when this client does not know the service yet. */
  private async reachCloud(cloudServerId: string): Promise<void> {
    if (!savedWorkspaceFor(cloudServerId)) await serversStore.refreshDirectory()
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
      const outcome = await this.upload({
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

  /** Whether a task on this host can have a link: it is in an organization, or can be put in one. */
  canCopyTaskLink(serverId: string): boolean {
    return accountStore.state.kind === 'signed-in' && (isSolusApiId(serverId) || !!serversStore.activeOrganizationId)
  }

  /**
   * A task is not shared on its own: everyone in its organization sees it. Copy
   * link puts a Local task in the window's organization first, with its comments
   * and its linked Local works (docs/plans/cloud-sharing.md §4), then copies the
   * address that opens it on the account origin.
   */
  async copyTaskLink(serverId: string, taskId: string): Promise<void> {
    const account = accountStore.state
    const accountOrigin = account.kind === 'signed-in' ? account.consoleUrl : null
    if (!accountOrigin) {
      toasts.error('Sign in to Solus Cloud to copy a link to this task.')
      return
    }
    let cloudServerId = serverId
    if (!isSolusApiId(serverId)) {
      const organizationId = serversStore.activeOrganizationId
      const organizationName = serversStore.activeOrganizationName ?? 'your organization'
      if (!organizationId) {
        toasts.error('Select an organization before copying a link.', {
          description: 'A task link opens the task in your organization on Solus Cloud.',
        })
        return
      }
      const outcome = await this.upload({ serverId, resource: { kind: 'task', id: taskId }, organizationId })
      if (outcome.kind !== 'committed') {
        toasts.error(`Couldn't put this task in ${organizationName}`, { description: publishProblemMessage(outcome, 'task', organizationName) ?? undefined })
        return
      }
      cloudServerId = outcome.cloudServerId
    }
    try {
      await navigator.clipboard.writeText(appLinkUrl(accountOrigin, { kind: 'task', id: taskId }, cloudServerId))
      toasts.success('Link copied', { description: 'Anyone in your organization can open this task.' })
    } catch {
      toasts.error("Couldn't copy the link")
    }
  }

  /**
   * The link for people the resource is shared with by name, team, or
   * organization: the app's own address on the account origin, opened with each
   * person's sign-in. Null when this client has no account origin or the
   * resource is not on a workspace service.
   */
  memberLinkUrl(serverId: string, resource: ShareResource): string | null {
    const account = accountStore.state
    if (account.kind !== 'signed-in' || !isSolusApiId(serverId)) return null
    return appLinkUrl(account.consoleUrl, resource, serverId)
  }

  /** Put one Local work or task into one organization; a second request for the same resource joins the first. */
  private upload(request: PublishRequest): Promise<PublishOutcome> {
    const key = listKey(request.serverId, request.resource)
    const running = this.uploads.get(key)
    if (running) {
      return running.organizationId === request.organizationId
        ? running.result
        : Promise.resolve({ kind: 'failed', error: 'This resource is already being published to another organization.' })
    }
    const result = this.runUpload(request).finally(() => { this.uploads.delete(key) })
    this.uploads.set(key, { organizationId: request.organizationId, result })
    return result
  }

  private async runUpload(request: PublishRequest): Promise<PublishOutcome> {
    const { serverId, resource, organizationId } = request
    if (resource.kind === 'session') return { kind: 'failed', error: 'A session stays on its host.' }
    if (serverConnections.statusFor(serverId) !== 'connected') return { kind: 'offline' }
    try {
      return resource.kind === 'work'
        ? await this.uploadWork(serverId, resource.id, organizationId)
        : await this.uploadTask(serverId, resource.id, organizationId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && rpcErrorCode(error) === 'FORBIDDEN') return { kind: 'denied', error: message }
      return { kind: 'failed', error: message }
    }
  }

  /**
   * A Local work leaves its machine as a cloud copy (docs/plans/cloud-sharing.md §3):
   * read from the machine, uploaded to the Solus API with this client's sign-in
   * under the same id, then marked moved on the machine, which keeps its
   * content. Every step is safe to repeat: the same work uploaded again
   * answers as before, so a Share that stopped halfway finishes the next time.
   */
  private async uploadWork(serverId: string, workId: string, organizationId: string): Promise<PublishOutcome> {
    const host = serverConnections.apiFor(serverId)
    const transfer = await host.workExportForCloud(workId)
    const cloudServerId = solusApiId(organizationId)
    await this.reachCloud(cloudServerId)
    await serverConnections.apiFor(cloudServerId).workUpload(transfer)
    await host.workMarkMoved(workId, transfer.fingerprint, organizationId)
    this.works?.markPublished(workId, organizationId, cloudServerId)
    this.lists.delete(listKey(serverId, { kind: 'work', id: workId }))
    return { kind: 'committed', cloudServerId }
  }

  /**
   * A Local task leaves its machine the same way, with its linked Local works
   * (docs/plans/cloud-sharing.md §4): the works go first, so the cloud task never
   * links to a work the cloud does not have. Linked sessions stay where they are.
   */
  private async uploadTask(serverId: string, taskId: string, organizationId: string): Promise<PublishOutcome> {
    const host = serverConnections.apiFor(serverId)
    const { task, works } = await host.taskExportForCloud(taskId)
    const cloudServerId = solusApiId(organizationId)
    await this.reachCloud(cloudServerId)
    const cloud = serverConnections.apiFor(cloudServerId)
    for (const work of works) await cloud.workUpload(work)
    await cloud.taskUpload(task)
    await host.taskMarkMoved(taskId, task.fingerprint, works.map((work) => ({ workId: work.work.id, fingerprint: work.fingerprint })), organizationId)
    for (const work of works) {
      this.works?.markPublished(work.work.id, organizationId, cloudServerId)
      this.lists.delete(listKey(serverId, { kind: 'work', id: work.work.id }))
    }
    this.lists.delete(listKey(serverId, { kind: 'task', id: taskId }))
    return { kind: 'committed', cloudServerId }
  }

  close(): void {
    this.dialog = null
  }

  async setGrants(serverId: string, request: ShareSetRequest): Promise<void> {
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
    const organizationId = this.identities.get(serverId)?.organizationId ?? null
    await this.setGrants(serverId, scopeRequestFor(scope, list, organizationId))
  }

  /** One person's own row, added or changed; every other row and the link stay as they are. */
  async setPersonRole(serverId: string, list: ShareList, userId: string, role: ShareRole): Promise<void> {
    await this.setGrants(serverId, withPersonRole(list, userId, role))
  }

  async removePerson(serverId: string, list: ShareList, userId: string): Promise<void> {
    await this.setGrants(serverId, withoutPerson(list, userId))
  }

  /**
   * The link a person outside the organization reviews a work through: the
   * work's link, raised to `commenter` when it only lets people view. An
   * existing editor or commenter link is kept. Null when this host cannot
   * make a link anyone else can open (a Local work on a machine); the Share
   * dialog is where that work is published first.
   */
  async reviewLink(serverId: string, resource: ShareResource): Promise<string | null> {
    if (!this.isHostLinked(serverId)) return null
    const list = await this.load(serverId, resource, { force: true })
    if (!list) return null
    if (!list.link || list.link.role === 'viewer') await this.setLink(serverId, resource, 'commenter')
    const current = this.listFor(serverId, resource) ?? list
    const presentation = linkPresentation(current.link, this.linkContext(serverId), true, resource)
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
provideShareRoles(sharesStore)
