import { isSolusApiId, organizationIdOfSolusApiId, solusApiId } from '@solus/contracts/uplink'
import type { AgentId } from '@solus/contracts/types'
import type { TurnFlagKind } from '@solus/contracts/observability-types'
import type { WorksStore } from '../works/works.store.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { Publication } from '@solus/contracts/organization-scope'
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

/**
 * Share lists per host (docs/plans/multiplayer-sharing.md §4). The host owns every
 * row; this store caches what it answered, re-reads on `share.changed`, and holds
 * the one share dialog every surface opens.
 *
 * A share lives in an organization on Solus Cloud. A resource still on a machine
 * is published there first (docs/plans/organization-scope.md §7): the Share
 * action is the opt-in, so opening Share starts the upload into the organization
 * this window works in, with no second confirmation. Once the machine reports the
 * publication `committed`, the dialog continues on the organization's workspace
 * service as it always did.
 */

/** Where a Local resource's publication stands, as the dialog shows it. */
export type PublishStatus =
  | { kind: 'pending' }
  | { kind: 'failed'; error: string }
  /** The machine holding the resource is not connected; nothing can be sent. */
  | { kind: 'offline' }
  /** The host refused: this account may not publish there. */
  | { kind: 'denied'; error: string }
  /** The machine holds it, sent, until the publisher connects again; it finishes then. */
  | { kind: 'waiting'; error: string }

export interface SharePublication {
  /** The machine the resource lives on, whose API starts the publication. */
  sourceServerId: string
  organizationId: string
  organizationName: string
  status: PublishStatus
}

export interface ShareDialogTarget {
  serverId: string
  resource: ShareResource
  title: string
  /** Set while the resource is still on a machine: the dialog shows its upload before any share. */
  publication?: SharePublication
}

export interface PublishRequest {
  /** The machine the resource lives on. */
  serverId: string
  resource: ShareResource
  organizationId: string
}

export type PublishOutcome =
  | { kind: 'committed'; cloudServerId: string }
  | { kind: 'failed'; error: string }
  | { kind: 'offline' }
  | { kind: 'denied'; error: string }
  | { kind: 'waiting'; error: string }

/** Who this client is to one host, as the host told it. */
export interface HostIdentity {
  accountConnectionsUrl?: string
  principal: ConnectionsServerInfo['principal']
  userId: string | null
  /** The person the host named this client as (plans/012 §1); null for a host that names no one. */
  user: User | null
  organizationId: string | null
}

/** How soon a publication is first re-read while no `publication.changed` arrives; each later read waits twice as long. */
const PUBLICATION_POLL_MS = 500
/** The longest wait between two re-reads. */
const PUBLICATION_POLL_MAX_MS = 10_000

function listKey(serverId: string, resource: ShareResource): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}

function isSettled(publication: Publication): boolean {
  return publication.state === 'committed' || publication.state === 'failed'
}

/** Settled, or sent and held by the machine for a reason the publisher must act on. */
function isAnswered(publication: Publication): boolean {
  return isSettled(publication) || (publication.state === 'sent' && !!publication.error)
}

export class SharesStore {
  works: WorksStore | null = null
  readonly lists = new SvelteMap<string, ShareList>()
  readonly identities = new SvelteMap<string, HostIdentity>()
  readonly directories = new SvelteMap<string, OrganizationPeople | null>()
  dialog = $state<ShareDialogTarget | null>(null)
  busy = $state(false)
  private readonly publications = new SvelteMap<string, { organizationId: string; result: Promise<PublishOutcome> }>()
  private readonly loads = new Map<string, Promise<ShareList | null>>()
  private readonly linkStatusAsked = new Set<string>()
  private stopWatching: (() => void) | null = null
  private readonly pollMs: number

  constructor(options: { pollMs?: number } = {}) {
    this.pollMs = options.pollMs ?? PUBLICATION_POLL_MS
  }

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
   * choice reads them.
   */
  async directoryFor(serverId: string): Promise<OrganizationPeople | null> {
    if (this.directories.has(serverId)) return this.directories.get(serverId) ?? null
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
   * needs an organization, not a linked host. A session runs on its host, which
   * sends its later turns, so it needs the host linked. A task is not shared: it
   * is seen by its whole organization, and offers its link (`copyTaskLink`).
   */
  canShareFrom(serverId: string, kind: ShareResourceKind): boolean {
    if (kind === 'task') return false
    if (kind === 'session') return this.isHostLinked(serverId)
    return isSolusApiId(serverId) || this.canPublishWork(serverId)
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

  /**
   * An Insights report (docs/plans/cloud-sharing.md §4): the report becomes a
   * Local work on the computer the readings came from, and Share uploads it like
   * any work. Each Share captures a new report, labelled with when it was taken.
   */
  async shareReport(serverId: string, report: { title: string; content: string; agentProvider: AgentId; mark: { kind: TurnFlagKind; note: string } | null }): Promise<void> {
    if (accountStore.state.kind !== 'signed-in' || this.busy) return
    try {
      const api = serverConnections.apiFor(serverId)
      const work = await api.createWork(report.title, 'insights-report', report.content, undefined, undefined, report.agentProvider)
      // Set before the dialog uploads the work, so the copy carries it.
      if (report.mark) await api.applyWorkComment(work.id, { kind: 'mark', mark: report.mark })
      await this.open({ serverId, resource: { kind: 'work', id: work.id }, title: report.title })
    } catch (error) {
      toasts.error('Could not share this report', { description: error instanceof Error ? error.message : undefined })
    }
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
   * A resource on the workspace service, or one a machine already published,
   * opens on its organization's share list. A Local resource opens in the
   * publish state and its upload into the window's organization starts at once
   * (§7): Share is the opt-in. The dialog resolves on screen; the list follows
   * the receipt.
   */
  private async openTarget(target: ShareDialogTarget): Promise<void> {
    if (isSolusApiId(target.serverId)) {
      await this.openCloud(target.serverId, target)
      return
    }
    const committed = await this.committedPublication(target.serverId, target.resource)
    if (committed) {
      const cloudServerId = solusApiId(committed.organizationId)
      if (target.resource.kind === 'work') this.works?.markPublished(target.resource.id, committed.organizationId, cloudServerId)
      await this.openCloud(cloudServerId, target)
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

  /** The dialog on a resource that lives on the workspace service: it opens on its list; its people load beside it. */
  private async openCloud(cloudServerId: string, target: ShareDialogTarget): Promise<void> {
    await this.reachCloud(cloudServerId)
    this.identities.delete(cloudServerId)
    this.directories.delete(cloudServerId)
    void this.directoryFor(cloudServerId).catch(() => {
      // No people to invite; the list still opens.
    })
    const list = await this.load(cloudServerId, target.resource, { force: true })
    if (!list) throw new Error('This resource has not reached Solus Cloud yet. Open its cloud copy before sharing.')
    this.dialog = { serverId: cloudServerId, resource: target.resource, title: target.title }
  }

  /** The organization's workspace service is reached through the account's directory; read it only when this client does not know the service yet. */
  private async reachCloud(cloudServerId: string): Promise<void> {
    if (!savedWorkspaceFor(cloudServerId)) await serversStore.refreshDirectory()
  }

  /** A publication of this resource the machine already committed, if any; an older host that cannot say has none. */
  private async committedPublication(serverId: string, resource: ShareResource): Promise<Publication | null> {
    try {
      const publications = await serverConnections.apiFor(serverId).publicationList(resource)
      return publications.find((publication) => publication.state === 'committed') ?? null
    } catch {
      return null
    }
  }

  /** The dialog's Retry after a publication that did not commit: the same destination, the same operation. */
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
   * Publish the dialog's Local resource into its organization, wait for the
   * receipt, then continue on the organization's list. A failure keeps the
   * dialog in the publish state with a Retry. Closing the dialog meanwhile
   * leaves it closed; the publication itself still finishes on the machine.
   */
  private async publishDialog(dialog: ShareDialogTarget): Promise<void> {
    const publication = dialog.publication
    if (!publication) return
    publication.status = { kind: 'pending' }
    try {
      const outcome = await this.publishResource({
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
      await this.openCloud(outcome.cloudServerId, dialog)
    } catch (error) {
      if (this.dialog === dialog) publication.status = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Publishes one Local resource into one organization (organization-scope §7):
   * the machine reserves the destination, sends the resource and what it needs,
   * and reports `committed` once the Solus API has it. The client follows the
   * receipt — `publication.changed`, or a re-read that backs off when the
   * event does not arrive — and then treats the organization's workspace service
   * as the record's home. A publication the machine holds until the publisher
   * connects again answers `waiting` with the machine's reason; it finishes on
   * its own once they do. Nothing is sent from a machine that is not connected.
   */
  canPublishWork(serverId: string | null | undefined): boolean {
    return !!serverId && !!serversStore.activeOrganizationId && !isSolusApiId(serverId)
  }

  isPublishing(serverId: string, resource: ShareResource): boolean {
    return this.publications.has(listKey(serverId, resource))
  }

  /** Shared command for the work header and workspace menu. One action, one notification. */
  async publishWork(serverId: string, workId: string): Promise<void> {
    const organizationId = serversStore.activeOrganizationId
    const organizationName = serversStore.activeOrganizationName ?? 'your organization'
    const resource = { kind: 'work', id: workId } as const
    if (!organizationId || !this.canPublishWork(serverId) || this.isPublishing(serverId, resource)) return
    const outcome = await this.publishResource({ serverId, resource, organizationId })
    if (outcome.kind === 'committed') toasts.success(`Published to ${organizationName}`)
    else if (outcome.kind === 'waiting') toasts.info(`Publishing to ${organizationName} continues after you reconnect`, { description: outcome.error })
    else toasts.error(`Couldn't publish this work to ${organizationName}`, { description: publishProblemMessage(outcome, 'work', organizationName) ?? undefined })
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
      const outcome = await this.publishResource({ serverId, resource: { kind: 'task', id: taskId }, organizationId })
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

  publishResource(request: PublishRequest): Promise<PublishOutcome> {
    const key = listKey(request.serverId, request.resource)
    const pending = this.publications.get(key)
    if (pending) {
      return pending.organizationId === request.organizationId
        ? pending.result
        : Promise.resolve({ kind: 'failed', error: 'This resource is already being published to another organization.' })
    }
    const result = this.runPublication(request).finally(() => { this.publications.delete(key) })
    this.publications.set(key, { organizationId: request.organizationId, result })
    return result
  }

  private async runPublication(request: PublishRequest): Promise<PublishOutcome> {
    const { serverId, resource, organizationId } = request
    if (serverConnections.statusFor(serverId) !== 'connected') return { kind: 'offline' }
    try {
      if (resource.kind === 'work') return await this.uploadWork(serverId, resource.id, organizationId)
      if (resource.kind === 'task') return await this.uploadTask(serverId, resource.id, organizationId)
      const api = serverConnections.apiFor(serverId)
      const started = await api.publicationStart({ resource, organizationId })
      const settled = await this.awaitAnswer(serverId, started)
      if (settled.state === 'sent') return { kind: 'waiting', error: settled.error ?? 'Publishing did not finish.' }
      if (settled.state !== 'committed') return { kind: 'failed', error: settled.error ?? 'Publishing did not finish.' }
      const cloudServerId = solusApiId(organizationId)
      // The machine's share list, if one was cached, described a Local resource that is gone from there.
      this.lists.delete(listKey(serverId, resource))
      return { kind: 'committed', cloudServerId }
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

  /**
   * The publication once the machine calls it `committed` or `failed`, or holds it
   * `sent` with a reason the publisher must act on. The event is the answer; the
   * re-read is the fallback for a missed event, and backs off so a long upload
   * costs a few requests, not two a second.
   */
  private awaitAnswer(serverId: string, publication: Publication): Promise<Publication> {
    if (isAnswered(publication)) return Promise.resolve(publication)
    return new Promise((resolve) => {
      const api = serverConnections.apiFor(serverId)
      let done = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let delayMs = this.pollMs
      const finish = (answered: Publication) => {
        if (done) return
        done = true
        unsubscribe()
        if (timer) clearTimeout(timer)
        resolve(answered)
      }
      const unsubscribe = serverConnections.eventsFor(serverId).subscribe('publication.changed', (changed) => {
        if (changed.id === publication.id && isAnswered(changed)) finish(changed)
      })
      const reread = () => {
        void api.publicationList(publication.resource)
          .then((publications) => {
            const current = publications.find((candidate) => candidate.id === publication.id)
            if (current && isAnswered(current)) finish(current)
          })
          .catch(() => {
            // The next read asks again; the event may still arrive first.
          })
          .finally(() => {
            if (done) return
            delayMs = Math.min(delayMs * 2, PUBLICATION_POLL_MAX_MS)
            timer = setTimeout(reread, delayMs)
          })
      }
      timer = setTimeout(reread, delayMs)
    })
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
