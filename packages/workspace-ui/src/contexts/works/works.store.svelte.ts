import { ExternalCommentsStore } from './external-comments.store.svelte'
import { WorkHistoryStore } from './work-history.store.svelte'
import { WorkReviewsStore } from './work-reviews.store.svelte'
import { WorkLiveStore } from './work-live.store.svelte'
import type { AgentId, PlanComment, PlanCommentReply, Work, WorkAnnotations, WorkExportResult, WorkMeta, WorkType } from '@solus/contracts/types'
import type { NewWorkComment, WorkCommentCommand } from '@solus/contracts/comment-commands'
import { uuid } from '@solus/contracts/uuid'
import { workPreview } from '@solus/contracts/work-preview'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { hosts } from '../hosts/hosts.svelte'
import { organizationSelection } from '../connections/organization-selection.store.svelte'
import { LOCAL_ORGANIZATION_ID, visibleInWindow } from '../../lib/organization-filter'
import { SvelteMap } from 'svelte/reactivity'
import type {
  DocDestination,
  DocProviderId,
  DocProviderStatus,
  WorkExternalLink,
  WorkPublishRequest,
  WorkPublishResult,
  WorkPullResult,
} from '@solus/contracts/docs'
import { PresenceWatch } from '../../lib/presence-watch'
import { firstHeadingTitle, isPlaceholderWorkTitle } from './work-title'
import { reconcileComments } from './comment-sync'
import { OpenWork, unavailableReasonOf, type OpenWorkHost } from './open-work.svelte'

/** What the window knows about a work without its body: a gallery row, a
 *  provisional entry, a link target. The body is only ever a saved record. */
export type WorkListing = WorkMeta & { id: string }

/** The pane's hold on one open work. Release it when the pane unmounts. */
export interface OpenWorkLease {
  readonly work: OpenWork
  release(): void
}

export class WorksStore {
  readonly externalComments = new ExternalCommentsStore(workId => this.apiForWork(workId), workId => this.get(workId)?.mirroredDoc)
  readonly history = new WorkHistoryStore((workId, read, likelyServerId) => this.followMove(workId, read, likelyServerId))
  /** The works open live, shared by the panes that show them (phase 3b). */
  readonly live = new WorkLiveStore({ title: (workId) => this.get(workId)?.title || 'Untitled' })
  readonly reviews = new WorkReviewsStore(workId => this.apiForWork(workId), serverId => serverConnections.apiFor(serverId), workId => this.hostFor(workId))
  /** Every work this window knows, metadata only. */
  works = $state<Record<string, WorkListing>>({})
  /** The saved records read from their hosts, one per work: the body and its
   *  versions exactly as the owner host answered. Changed only through
   *  `acceptSaved`, which refuses an answer older than the one held. */
  saved = $state<Record<string, Work>>({})
  /** A work pending deletion from the open-work view, held while the undo toast
   *  is visible. The work is removed from disk only on commit (toast dismiss). */
  pendingWorkDelete = $state<WorkListing | null>(null)
  annotations = $state<Record<string, WorkAnnotations>>({})
  /** Set true for a work whose create_work tool call is still in flight
   *  (provisional, not yet persisted). The card renders a generating skeleton
   *  while this is true; cleared on finalize. */
  streaming = $state<Record<string, boolean>>({})
  /** Which host owns each known work. All later reads and writes use this map. */
  private hostByWorkId = new SvelteMap<string, string>()
  /** The host each saved record was read from. A record from another host is
   *  replaced, not version-compared: versions belong to one host's row. */
  private savedFrom = new Map<string, string>()
  /** True while a listWorks load is in flight, so surfaces that show works
   *  alongside slower data (the Workspace ledger) can say so. */
  listLoading = $state(false)
  private annotationLoadTokens = new Map<string, number>()
  private nextLoadToken = 0
  /** The in-flight listWorks load, shared by every caller that asks meanwhile. */
  private listLoad: Promise<void> | null = null
  /** In-flight saved-record reads for works no pane has open, keyed by work.
   *  Concurrent callers share one read instead of firing duplicate loadWork IPC. */
  private savedReads = new Map<string, Promise<Work | null>>()
  /** The works a pane has open, reference-counted: one subscription each. */
  private openWorks = new Map<string, OpenWork>()
  /** Live upstream polls, keyed by work. Reference-counted, because the same
   *  work can be open in more than one pane. */
  private upstreamWatches = new PresenceWatch()
  readonly upstreamCheckTimes = this.upstreamWatches.timings

  /** Register a provisional work while a create_work tool call is in flight. The
   *  card shows a generating skeleton (content is not streamed in); on
   *  work_created, finalizeProvisional swaps in the persisted id. The entry
   *  carries the agent/cwd so finalize can preserve them. Returns its id. */
  addProvisional(agentProvider: AgentId, cwd: string, serverId?: string): string {
    const tempId = uuid()
    const now = new Date().toISOString()
    this.works[tempId] = {
      id: tempId,
      // The host names the organization when it persists the work; until then
      // the provisional is this window's, and Local is visible in every window.
      organizationId: LOCAL_ORGANIZATION_ID,
      title: '',
      preview: '',
      type: 'doc',
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      agentProvider,
      cwd,
    }
    this.streaming[tempId] = true
    if (serverId) this.hostByWorkId.set(tempId, serverId)
    return tempId
  }

  /** Reconcile a provisional to the persisted work: rekey temp→real id, set its
   *  title, type, and preview, and clear the streaming flag. When there is no
   *  provisional (Codex/mock emit work_created without streaming), this lists
   *  the finished work. The body is not a saved record: a reader loads it. */
  finalizeProvisional(tempId: string | null, realId: string, title: string, docType: WorkType, content: string, serverId?: string): void {
    const provisional = tempId ? this.works[tempId] : undefined
    const ownerServerId = serverId ?? (tempId ? this.hostByWorkId.get(tempId) : undefined)
    const now = new Date().toISOString()
    const listing: WorkListing = provisional ?? {
      id: realId,
      organizationId: LOCAL_ORGANIZATION_ID,
      title,
      preview: '',
      type: docType,
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      agentProvider: 'claude-code',
      cwd: '~',
    }
    if (tempId && tempId !== realId) {
      delete this.works[tempId]
      this.hostByWorkId.delete(tempId)
    }
    if (tempId) delete this.streaming[tempId]
    listing.id = realId
    listing.title = title
    listing.type = docType
    listing.preview = workPreview(docType, content)
    listing.updatedAt = now
    this.works[realId] = listing
    if (ownerServerId) this.hostByWorkId.set(realId, ownerServerId)
  }

  /** Drop a provisional whose create_work never persisted (tool errored). */
  removeProvisional(tempId: string): void {
    delete this.works[tempId]
    delete this.streaming[tempId]
    this.hostByWorkId.delete(tempId)
  }

  /** Stamp a work returned by a host-addressed create or session event. */
  rememberHost(workId: string, serverId: string): void {
    this.hostByWorkId.set(workId, serverId)
  }

  /**
   * Ask the host that has the work. A host the work left answers `MOVED`
   * (cloud-sharing.md §3a): the work lists then name its new owner, and the
   * read is asked there once. A work this client has not listed yet is looked
   * up first: one shared before hosts kept a location has no row to answer.
   * `likelyServerId` skips that lookup: a reader that knows where the work was
   * made (the session's host) asks there, and lists every host only when that
   * host does not have it.
   */
  private async followMove<T>(workId: string, read: (api: HostApi) => Promise<T>, likelyServerId?: string): Promise<T> {
    const guessedServerId = this.hostByWorkId.has(workId) ? undefined : likelyServerId
    if (!this.hostByWorkId.has(workId) && !guessedServerId) await this.loadAll()
    const askedServerId = this.hostByWorkId.get(workId) ?? guessedServerId ?? serverConnections.defaultServerId()
    try {
      return await read(guessedServerId ? serverConnections.apiFor(guessedServerId) : this.apiForWork(workId))
    } catch (error) {
      if (!isMovedError(error) && !(guessedServerId && isMissingWorkError(error))) throw error
      await this.loadAll()
      const ownerServerId = this.hostByWorkId.get(workId)
      if (!ownerServerId || ownerServerId === askedServerId) throw error
      return read(serverConnections.apiFor(ownerServerId))
    }
  }

  hostFor(workId: string): string | null {
    return this.hostByWorkId.get(workId) ?? null
  }

  /** The known works this window shows: Local ones, and the selected organization's (organization-scope §2). */
  get visibleWorks(): WorkListing[] {
    const activeOrganizationId = organizationSelection.activeOrganizationId
    return Object.values(this.works).filter((work) => visibleInWindow(work.organizationId, activeOrganizationId))
  }

  /**
   * A publication of the work into an organization was committed (organization-scope
   * §7): its home is now that organization's workspace service, under the same id,
   * so every link to it still resolves — there. The host already holds the copy;
   * this store only follows it. Cached sidecars were the machine's and are re-read.
   * An open work releases the machine and subscribes on the service; its panes
   * keep their drafts.
   */
  markPublished(workId: string, organizationId: string, cloudServerId: string): void {
    const previousServerId = this.hostByWorkId.get(workId)
    this.hostByWorkId.set(workId, cloudServerId)
    this.clearCachedSidecars(workId)
    const listing = this.works[workId]
    if (listing) listing.organizationId = organizationId
    const held = this.saved[workId]
    if (held) held.organizationId = organizationId
    const open = this.openWorks.get(workId)
    if (open && previousServerId !== cloudServerId) open.bind(this.openWorkHost(cloudServerId))
  }

  /** A work this client just created or copied on `serverId`: listed and saved at once. */
  acceptCreated(work: Work, serverId: string): void {
    this.hostByWorkId.set(work.id, serverId)
    this.acceptSaved(work, serverId)
  }

  /**
   * The one way a host's answer becomes the saved record. An answer from a host
   * that no longer owns the work is ignored; one from the owner replaces the
   * held record only when it is newer (a higher content version, or the same
   * body with a later record version), so an equal or late answer is harmless.
   * The record is updated in place and every pane with the work open is told.
   */
  acceptSaved(work: Work, serverId: string): void {
    const owner = this.hostByWorkId.get(work.id)
    if (owner && owner !== serverId) return
    if (!owner) this.hostByWorkId.set(work.id, serverId)
    const held = this.saved[work.id]
    if (held && this.savedFrom.get(work.id) === serverId && !isNewerRecord(work, held)) return
    if (held) applyRecord(held, work)
    else this.saved[work.id] = work
    this.savedFrom.set(work.id, serverId)
    const listing = this.works[work.id]
    if (listing) applyMeta(listing, work)
    else this.works[work.id] = listingOf(work)
    this.openWorks.get(work.id)?.notify(this.saved[work.id], serverId)
  }

  savedWork(workId: string): Work | undefined {
    return this.saved[workId]
  }

  /**
   * Hold a work open: subscribe on its owner host before the first read, and
   * keep the saved record current until the last pane releases it. A
   * provisional work is not read until it is persisted under its real id.
   */
  openWork(workId: string, serverIdHint?: string): OpenWorkLease {
    if (serverIdHint && !this.hostByWorkId.has(workId)) this.hostByWorkId.set(workId, serverIdHint)
    let open = this.openWorks.get(workId)
    if (!open) {
      open = new OpenWork(workId, {
        saved: (id, serverId) => (this.savedFrom.get(id) === serverId ? this.saved[id] : undefined),
        accept: (work, serverId) => this.acceptSaved(work, serverId),
      })
      this.openWorks.set(workId, open)
      const serverId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
      if (!serverId) {
        open.status = 'error'
        open.error = 'No Solus host is connected.'
      } else if (!this.streaming[workId]) {
        open.bind(this.openWorkHost(serverId))
      }
    }
    const held = open
    held.refs++
    let released = false
    return {
      work: held,
      release: () => {
        if (released) return
        released = true
        held.refs--
        if (held.refs > 0 || this.openWorks.get(workId) !== held) return
        held.stop()
        this.openWorks.delete(workId)
      },
    }
  }

  private openWorkHost(serverId: string): OpenWorkHost {
    const resolved = serverConnections.resolveId(serverId)
    return {
      serverId,
      api: serverConnections.apiFor(serverId),
      subscribe: (type, listener) => serverConnections.eventsFor(serverId).subscribe(type, (payload) => listener(payload)),
      onPhaseChange: (listener) => serverConnections.onPhaseChange((changedServerId, phase) => {
        if (changedServerId === resolved) listener(phase)
      }),
      phase: () => serverConnections.phaseFor(serverId),
    }
  }

  /** A work link in a document, a transcript card, or a task names only the
   *  work id. Until a list read or a host-addressed event places the work, the
   *  default host is asked. */
  private apiForWork(workId: string): HostApi {
    const serverId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  annotationComments(workId: string): PlanComment[] {
    return this.annotations[workId]?.comments ?? []
  }

  async loadAnnotations(workId: string, serverId?: string): Promise<WorkAnnotations | null> {
    if (serverId) this.hostByWorkId.set(workId, serverId)
    const token = ++this.nextLoadToken
    this.annotationLoadTokens.set(workId, token)
    try {
      const ann = await this.apiForWork(workId).loadWorkAnnotations(workId)
      if (this.annotationLoadTokens.get(workId) !== token) return this.annotations[workId] ?? null
      return this.acceptAnnotations(workId, ann)
    } catch (err) {
      logWorkLoad('error', 'annotation load failed', { workId, error: formatError(err) })
      return this.annotations[workId] ?? null
    }
  }

  /**
   * Re-read a work's threads whenever anyone changes them — another person on a
   * shared work, or an agent (docs/plans/multiplayer-comments.md). Returns the
   * unsubscribe; a surface holds it for as long as the work is open.
   */
  watchAnnotations(workId: string, onLoaded?: () => void): () => void {
    return serverConnections.eventsForApi(this.apiForWork(workId)).subscribe('annotations.changed', (change) => {
      if (change.kind !== 'work' || change.targetId !== workId) return
      void this.loadAnnotations(workId).then(() => onLoaded?.())
    })
  }

  /**
   * Every change to a thread is one command to the host, which stamps who made
   * it. The change is shown at once and the host's answer reconciled over it; a
   * refused command re-reads, so the rail never keeps a change the host did not.
   */
  private async applyComment(workId: string, command: WorkCommentCommand): Promise<void> {
    try {
      this.acceptAnnotations(workId, await this.apiForWork(workId).applyWorkComment(workId, command))
    } catch (err) {
      logWorkLoad('error', 'comment command failed', { workId, kind: command.kind, error: formatError(err) })
      await this.loadAnnotations(workId)
    }
  }

  private acceptAnnotations(workId: string, ann: WorkAnnotations | null): WorkAnnotations {
    const entry = this.ensureAnnotationsEntry(workId)
    entry.updatedAt = ann?.updatedAt ?? Date.now()
    reconcileComments(entry.comments, ann?.comments ?? [])
    return entry
  }

  async addAnnotationComment(workId: string, comment: PlanComment): Promise<void> {
    const entry = this.ensureAnnotationsEntry(workId)
    // Unstamped until the host answers: the reader's own, as the rail reads it.
    entry.comments.push({ createdAt: Date.now(), ...comment })
    entry.updatedAt = Date.now()
    await this.applyComment(workId, { kind: 'add', comment: newWorkComment(comment) })
  }

  async editAnnotationComment(workId: string, commentId: string, text: string): Promise<void> {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    comment.comment = text
    await this.applyComment(workId, { kind: 'edit', commentId, text })
  }

  async deleteAnnotationComment(workId: string, commentId: string): Promise<void> {
    const comments = this.annotations[workId]?.comments
    if (!comments) return
    const index = comments.findIndex((x) => x.id === commentId)
    if (index === -1) return
    comments.splice(index, 1)
    await this.applyComment(workId, { kind: 'delete', commentId })
  }

  async addAnnotationReply(workId: string, commentId: string, reply: PlanCommentReply): Promise<void> {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    // Mutate in place — the replies array is inside a $state proxy, so pushing
    // notifies the one card rather than invalidating every thread in the rail.
    if (comment.replies) comment.replies.push(reply)
    else comment.replies = [reply]
    await this.applyComment(workId, { kind: 'reply', commentId, reply: { id: reply.id, text: reply.text } })
  }

  async setAnnotationResolved(workId: string, commentId: string, resolved: boolean): Promise<void> {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    if (resolved) {
      // The host stamps who resolved it; the reader's copy says only when.
      comment.resolvedAt = Date.now()
    } else {
      delete comment.resolvedAt
      delete comment.resolvedBy
    }
    await this.applyComment(workId, { kind: 'resolve', commentId, resolved })
  }

  /** Every open thread settles at once: a round of feedback handed to an agent. */
  async resolveOpenAnnotationComments(workId: string): Promise<void> {
    const now = Date.now()
    for (const comment of this.annotationComments(workId)) {
      if (comment.resolvedAt !== undefined) continue
      comment.resolvedAt = now
    }
    await this.applyComment(workId, { kind: 'resolve-open' })
  }

  async markAnnotationRead(workId: string, commentId: string): Promise<void> {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    comment.readAt = Date.now()
    try {
      this.acceptAnnotations(workId, await this.apiForWork(workId).markWorkCommentRead(workId, commentId))
    } catch (err) {
      logWorkLoad('error', 'comment read mark failed', { workId, error: formatError(err) })
    }
  }

  /**
   * Write through the owner host. `base` is the saved record the writer's
   * draft is based on — never the newest one this store holds, which the
   * writer may not have seen. The answer becomes the saved record. A write
   * refused because the work is gone marks an open work unavailable.
   */
  async save(workId: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>, base: Pick<Work, 'updatedAt' | 'contentVersion'>): Promise<Work> {
    const write = this.withDerivedTitle(this.works[workId], updates)
    const serverId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    try {
      const updated = await serverConnections.apiFor(serverId).saveWork(workId, write, base)
      this.acceptSaved(updated, serverId)
      return updated
    } catch (error) {
      const reason = isMissingWorkError(error) ? 'deleted' : unavailableReasonOf(error)
      if (reason) this.openWorks.get(workId)?.markUnavailable(reason)
      throw error
    }
  }

  /** A still-unnamed document takes its name from the first heading the user
   *  writes. Only for documents: diagram content is JSON, and a work the user
   *  or the agent has already named keeps that name. */
  private withDerivedTitle(
    work: WorkListing | undefined,
    updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  ): Partial<Pick<Work, 'title' | 'preview' | 'content'>> {
    if (updates.title !== undefined || updates.content === undefined) return updates
    if (!work || work.type === 'diagram' || !isPlaceholderWorkTitle(work.title)) return updates
    const heading = firstHeadingTitle(updates.content)
    return heading ? { ...updates, title: heading } : updates
  }

  /**
   * A session reported an agent's update to a work. It names no content
   * version, so its body never becomes the saved record: the listing takes the
   * title and preview. An open work already hears the same write as
   * `works.changed` from its owner host and reads it once; any other held
   * saved record is read again by id.
   */
  applyRemoteUpdate(workId: string, title: string, content: string, updatedAt: string, serverId?: string): void {
    if (serverId) this.hostByWorkId.set(workId, serverId)
    const listing = this.works[workId]
    if (!listing) {
      void this.readSaved(workId, 'agent-update')
      return
    }
    if (Date.parse(updatedAt) < Date.parse(listing.updatedAt)) return
    // A cloud-owned save cannot read the row it updates, so it reports `doc`
    // and an empty title. An update never changes a work's type.
    if (title) listing.title = title
    listing.preview = workPreview(listing.type, content)
    listing.updatedAt = updatedAt
    const held = this.saved[workId]
    if (!held || this.openWorks.has(workId) || Date.parse(updatedAt) <= Date.parse(held.updatedAt)) return
    void this.readSaved(workId, 'agent-update')
  }

  loadAll(): Promise<void> {
    if (this.listLoad) return this.listLoad
    const load = (async () => {
      try {
        // Every connected host that serves the collaboration plane: a runner
        // without it (docs/plans/cloud-service-model.md) holds no works.
        const serverIds = serverConnections.connectedServerIds().filter(
          (serverId) => serverConnections.phaseFor(serverId) === 'connected' && hosts.hasCollaboration(serverId),
        )
        const results = await Promise.all(serverIds.map(async (serverId) => {
          try {
            return { serverId, metas: await serverConnections.apiFor(serverId).listWorks() }
          } catch (error) {
            logWorkLoad('error', 'work list host load failed', { serverId, error: formatError(error) })
            return { serverId, error }
          }
        }))
        for (const result of results) {
          if (!result.metas) continue
          void this.reviews.loadHost(result.serverId)
          const liveIds = new Set<string>()
          for (const meta of result.metas) {
            liveIds.add(meta.id)
            this.hostByWorkId.set(meta.id, result.serverId)
            const listing = this.works[meta.id]
            if (!listing) this.works[meta.id] = listingOf(meta)
            else if (Date.parse(meta.updatedAt) >= Date.parse(listing.updatedAt)) applyMeta(listing, meta)
            // A held body older than the listing is no longer the saved one.
            const held = this.saved[meta.id]
            if (held && Date.parse(meta.updatedAt) > Date.parse(held.updatedAt)) this.refreshSaved(meta.id)
          }
          // Only an owner host that answered can confirm a deletion. A failed
          // host contributes nothing and cannot evict another host's works.
          // An open work is asked again: its panes show it as unavailable.
          for (const id of Object.keys(this.works)) {
            if (this.hostByWorkId.get(id) !== result.serverId || liveIds.has(id) || this.streaming[id]) continue
            const open = this.openWorks.get(id)
            if (open) {
              void open.refresh()
              continue
            }
            this.forget(id)
          }
        }
      } catch (err) {
        logWorkLoad('error', 'work list load failed', { error: formatError(err) })
      } finally {
        this.listLoad = null
        this.listLoading = false
      }
    })()
    this.listLoad = load
    this.listLoading = true
    return load
  }

  /** The saved record, read from its host when none is held. A provisional
   *  work has none yet. */
  ensureContent(workId: string, source = 'unknown'): Promise<Work | null> {
    const held = this.saved[workId]
    if (held) return Promise.resolve(held)
    if (this.streaming[workId]) return Promise.resolve(null)
    return this.readSaved(workId, source)
  }

  /** Bring a held record up to date: an open work re-reads under its own
   *  subscription; any other is read again once. */
  private refreshSaved(workId: string): void {
    const open = this.openWorks.get(workId)
    if (open) void open.refresh()
    else void this.readSaved(workId, 'stale-listing')
  }

  private readSaved(workId: string, source: string): Promise<Work | null> {
    const pending = this.savedReads.get(workId)
    if (pending) return pending
    const read = this.loadSavedFromHost(workId, source).finally(() => this.savedReads.delete(workId))
    this.savedReads.set(workId, read)
    return read
  }

  private async loadSavedFromHost(workId: string, source: string): Promise<Work | null> {
    if (!(this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId())) return null
    try {
      const work = await this.followMove(workId, (api) => api.loadWork(workId))
      const serverId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
      if (work && serverId) {
        this.acceptSaved(work, serverId)
        return this.saved[workId] ?? null
      }
      logWorkLoad('warn', 'host read returned no work', { workId, source, hadListing: !!this.works[workId] })
    } catch (err) {
      logWorkLoad('error', 'host read failed', { workId, source, hadListing: !!this.works[workId], error: formatError(err) })
    }
    return null
  }

  async remove(workId: string): Promise<void> {
    try {
      await this.apiForWork(workId).deleteWork(workId)
    } catch (err) {
      if (!isMissingWorkError(err)) throw err
    } finally {
      await this.loadAll()
      this.openWorks.get(workId)?.markUnavailable('deleted')
      this.forget(workId)
    }
  }

  /** Open the undo window: the work hides from the gallery (callers filter on
   *  pendingWorkDelete) but stays on disk until commit. Callers must already have
   *  shown their undo affordance — showing one commits the affordance it replaces,
   *  which would wipe the pending delete recorded here. */
  beginWorkDelete(work: WorkListing): void {
    this.pendingWorkDelete = work
  }

  /** Undo window closed — permanently delete the work from disk. */
  commitWorkDelete(): void {
    const work = this.pendingWorkDelete
    this.pendingWorkDelete = null
    if (work) void this.remove(work.id)
  }

  /** Undo — keep the work; clearing the pending state un-hides it. */
  undoWorkDelete(): void {
    this.pendingWorkDelete = null
  }

  async duplicate(workId: string): Promise<Work> {
    const api = this.apiForWork(workId)
    // The same choice `apiForWork` just made, so the copy is remembered on the
    // host that holds the original.
    const ownerServerId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
    const duplicated = await api.duplicateWork(workId)
    if (ownerServerId) this.acceptCreated(duplicated, ownerServerId)
    return duplicated
  }

  async setPinned(workId: string, pinned: boolean): Promise<void> {
    const listing = this.works[workId]
    if (listing) listing.pinned = pinned
    await this.apiForWork(workId).setWorkPinned(workId, pinned)
  }

  /** The work's host writes the stored content to `path` on its own filesystem
   *  and answers the resolved path. The work row is untouched: the file is a copy. */
  exportToPath(workId: string, path: string): Promise<WorkExportResult> {
    return this.apiForWork(workId).worksExport({ workId, path })
  }

  linkSession(workId: string, sessionId: string): void {
    this.linkSessionLocal(workId, sessionId)
    void this.apiForWork(workId).linkWorkSession(workId, sessionId)
  }

  /** Make one checkpoint current again, over the body the reader compared
   *  against. The host adds a `restore` checkpoint; nothing is deleted. */
  async restoreRevision(workId: string, revisionId: number, expectedContentVersion: number): Promise<Work> {
    const serverId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    const restored = await serverConnections.apiFor(serverId).restoreWorkRevision(workId, revisionId, expectedContentVersion)
    this.acceptSaved(restored, serverId)
    void this.history.load(workId)
    return restored
  }

  /** Local-only sync for links the main process already persisted (work_created events). */
  linkSessionLocal(workId: string, sessionId: string): void {
    const work = this.works[workId]
    if (!work) return
    const sessionIds = work.sessionIds ?? (work.sessionId ? [work.sessionId] : [])
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    work.sessionIds = sessionIds
    if (!work.sessionId) work.sessionId = sessionId
  }

  get(workId: string): WorkListing | undefined {
    return this.works[workId]
  }

  /** Every trace of a work the host no longer has. */
  private forget(workId: string): void {
    delete this.works[workId]
    delete this.saved[workId]
    delete this.streaming[workId]
    this.savedFrom.delete(workId)
    this.hostByWorkId.delete(workId)
    this.clearCachedSidecars(workId)
    this.reviews.forget(workId)
  }
  // ─── Upstream doc mirror ───

  /** Which document providers this host can reach right now. */
  async loadDocProviders(serverId?: string): Promise<DocProviderStatus[]> {
    const api = serverId ? serverConnections.apiFor(serverId) : this.primaryApi()
    try {
      return await api.docProviderStatuses()
    } catch (err) {
      logWorkLoad('error', 'doc provider status load failed', { error: formatError(err) })
      return []
    }
  }

  /** Spaces or folders a first publish can target. Read live because provider
   * destinations can change while the workspace stays mounted. */
  async loadDocDestinations(provider: DocProviderId, serverId?: string): Promise<DocDestination[]> {
    const api = serverId ? serverConnections.apiFor(serverId) : this.primaryApi()
    return api.docDestinations(provider)
  }

  /**
   * Publish, or update the linked doc in place. A conflict comes back as a
   * result, not an exception: the caller has to offer pull-first or overwrite,
   * and swallowing it as an error would hide that choice.
   */
  async publish(workId: string, options: { destination?: DocDestination; diagramAssets?: WorkPublishRequest['diagramAssets']; force?: boolean } = {}): Promise<WorkPublishResult> {
    const opts: WorkPublishRequest = {}
    if (options.destination) opts.destination = options.destination
    if (options.diagramAssets?.length) opts.diagramAssets = options.diagramAssets
    if (options.force) opts.force = true

    const result = await this.apiForWork(workId).publishWork(workId, opts)
    if (result.link) this.applyLink(workId, result.link)
    return result
  }


  async pullUpstream(workId: string): Promise<WorkPullResult> {
    const result = await this.apiForWork(workId).pullWorkUpstream(workId)
    if (!result.ok) return result
    const listing = this.works[workId]
    if (listing) {
      listing.title = result.title
      listing.preview = workPreview(listing.type, result.content)
      listing.mirroredDoc = result.link
    }
    // The pull wrote a new body on the host; the saved record is read again.
    if (this.saved[workId]) this.refreshSaved(workId)
    return result
  }

  /** Version metadata only, and only while the work is on screen. */
  async refreshUpstream(workId: string): Promise<void> {
    try {
      const link = await this.apiForWork(workId).refreshWorkUpstream(workId)
      if (link) this.applyLink(workId, link)
    } catch (err) {
      logWorkLoad('warn', 'upstream refresh failed', { workId, error: formatError(err) })
    }
  }

  /** Stops tracking the upstream doc. The page itself is never touched. */
  async unlinkUpstream(workId: string): Promise<void> {
    await this.apiForWork(workId).unlinkWorkUpstream(workId)
    this.applyLink(workId, undefined)
  }

  /** `cwd` is the imported work's origin, recorded on its row. */
  async importFromUrl(url: string, cwd?: string, serverId?: string): Promise<Work> {
    const targetServerId = serverId ?? serverConnections.defaultServerId()
    if (!targetServerId) throw new Error('Primary Solus connection has not been registered')
    const work = await serverConnections.apiFor(targetServerId).importDocFromUrl(url, cwd)
    this.acceptCreated(work, targetServerId)
    return work
  }

  /**
   * Presence-scoped staleness polling: while a linked work is open, ask the
   * provider every five minutes whether the upstream doc moved, so the chip can
   * say so before a publish is refused. Nothing polls in the background — a
   * fleet-wide poll would spend a rate limit on documents nobody is looking at.
   */
  watchUpstream(workId: string): () => void {
    return this.upstreamWatches.watch(workId, () => this.refreshUpstream(workId))
  }

  private applyLink(workId: string, link: WorkExternalLink | undefined): void {
    const listing = this.works[workId]
    if (listing) listing.mirroredDoc = link
    const held = this.saved[workId]
    if (held) held.mirroredDoc = link
  }

  private primaryApi(): HostApi {
    const serverId = serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  private ensureAnnotationsEntry(workId: string): WorkAnnotations {
    let entry = this.annotations[workId]
    if (!entry) {
      entry = { version: 1, workId, comments: [], updatedAt: 0 }
      this.annotations[workId] = entry
    }
    return entry
  }

  private clearCachedSidecars(workId: string): void {
    delete this.annotations[workId]
    this.annotationLoadTokens.delete(workId)
    this.history.forget(workId)
  }
}

/** A newer answer: a later body, or the same body with a later record version. */
function isNewerRecord(next: Work, held: Work): boolean {
  if (next.contentVersion !== held.contentVersion) return next.contentVersion > held.contentVersion
  return Date.parse(next.updatedAt) > Date.parse(held.updatedAt)
}

function listingOf(work: WorkListing): WorkListing {
  const listing: WorkListing = {
    id: work.id,
    organizationId: work.organizationId,
    title: work.title,
    preview: work.preview,
    type: work.type,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    agentProvider: work.agentProvider,
    cwd: work.cwd,
  }
  applyMeta(listing, work)
  return listing
}

function applyMeta(work: WorkListing, meta: WorkListing): void {
  work.id = meta.id
  work.organizationId = meta.organizationId
  work.title = meta.title
  work.preview = meta.preview
  work.type = meta.type
  work.createdAt = meta.createdAt
  work.updatedAt = meta.updatedAt
  work.sessionId = meta.sessionId
  work.sessionIds = meta.sessionIds
  work.agentProvider = meta.agentProvider
  work.cwd = meta.cwd
  work.pinned = meta.pinned
  work.mirroredDoc = meta.mirroredDoc
}

function applyRecord(work: Work, next: Work): void {
  applyMeta(work, next)
  work.content = next.content
  work.contentVersion = next.contentVersion
  work.contentHash = next.contentHash
  work.contentAuthor = next.contentAuthor
}

/** The host's answer for a work Share moved to an organization, over either transport. */
function isMovedError(error: Parameters<typeof String>[0]): boolean {
  if (error instanceof WorkspaceRequestError) return error.code === 'MOVED'
  return error instanceof Error && rpcErrorCode(error) === 'MOVED'
}

function isMissingWorkError(err: Parameters<typeof String>[0]): boolean {
  return err instanceof Error && err.message.includes('Work not found:')
}

function logWorkLoad<Data extends object>(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data: Data,
): void {
  console[level](`[Solus][WorksStore] ${message}`, data)
}

/** What the client may say about a new thread: where it is and what it says. Who
 *  wrote it and when are the host's to stamp. */
function newWorkComment(comment: PlanComment): NewWorkComment {
  const next: NewWorkComment = { id: comment.id, selectedText: comment.selectedText, comment: comment.comment }
  if (comment.textOffset !== undefined) next.textOffset = comment.textOffset
  if (comment.nodeId) next.nodeId = comment.nodeId
  if (comment.edgeId) next.edgeId = comment.edgeId
  if (comment.pin) next.pin = comment.pin
  if (comment.externalThreadId) next.externalThreadId = comment.externalThreadId
  return next
}

function formatError(err: Parameters<typeof String>[0]): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
