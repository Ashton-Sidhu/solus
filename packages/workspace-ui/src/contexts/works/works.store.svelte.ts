import type { AgentId, CommentAuthor, PlanComment, PlanCommentReply, Work, WorkAnnotations, WorkMeta, WorkPrevious, WorkType } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import { workPreview } from '@solus/contracts/work-preview'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
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

export class WorksStore {
  works = $state<Record<string, Work>>({})
  activeCwd = $state<string | undefined>(undefined)
  /** A work pending deletion from the open-work view, held while the undo toast
   *  is visible. The work is removed from disk only on commit (toast dismiss). */
  pendingWorkDelete = $state<Work | null>(null)
  annotations = $state<Record<string, WorkAnnotations>>({})
  previousSnapshots = $state<Record<string, WorkPrevious | null>>({})
  /** Per-work counter, bumped only on agent-driven (mid-turn) updates. Open
   *  viewers watch this to decide when to live-refresh vs. surface a conflict. */
  agentRevisions = $state<Record<string, number>>({})
  /** Set true for a work whose create_work tool call is still in flight
   *  (provisional, not yet persisted). The card renders a generating skeleton
   *  while this is true; cleared on finalize. */
  streaming = $state<Record<string, boolean>>({})
  /** Which host owns each known work. All later reads and writes use this map. */
  private hostByWorkId = new SvelteMap<string, string>()
  /** True while a listWorks load is in flight, so surfaces that show works
   *  alongside slower data (the Workspace ledger) can say so. */
  listLoading = $state(false)
  private annotationLoadTokens = new Map<string, number>()
  private previousLoadTokens = new Map<string, number>()
  private nextLoadToken = 0
  private listLoads = new Map<string | undefined, Promise<void>>()
  /** In-flight ensureContent loads, keyed by workId. Concurrent callers (a
   *  grouped-invalidation burst re-runs the hydration effect while a load is
   *  pending) share the same promise instead of firing duplicate loadWork IPC. */
  private contentLoads = new Map<string, Promise<Work | null>>()
  /** Live upstream polls, keyed by work. Reference-counted, because the same
   *  work can be open in more than one pane. */
  private upstreamWatches = new PresenceWatch()

  /** Register a provisional work while a create_work tool call is in flight. The
   *  card shows a generating skeleton (content is not streamed in); on
   *  work_created, finalizeProvisional swaps in the persisted id and content.
   *  The empty entry carries the agent/cwd so finalize can preserve them.
   *  Returns the generated provisional id. */
  addProvisional(agentProvider: AgentId, cwd: string, serverId?: string): string {
    const tempId = uuid()
    const now = new Date().toISOString()
    this.works[tempId] = {
      id: tempId,
      title: '',
      content: '',
      preview: '',
      type: 'doc',
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      agentProvider,
      cwd,
      storage: { kind: 'local' },
    }
    this.streaming[tempId] = true
    if (serverId) this.hostByWorkId.set(tempId, serverId)
    return tempId
  }

  /** Reconcile a provisional to the persisted work: rekey temp→real id, set the
   *  authoritative content/title/type, and clear the streaming flag. When there
   *  is no provisional (Codex/mock emit work_created without streaming), this
   *  simply inserts the finished work. */
  finalizeProvisional(tempId: string | null, realId: string, title: string, docType: WorkType, content: string, serverId?: string): void {
    const provisional = tempId ? this.works[tempId] : undefined
    const ownerServerId = serverId ?? (tempId ? this.hostByWorkId.get(tempId) : undefined)
    const now = new Date().toISOString()
    const base: Work = provisional ?? {
      id: realId,
      title,
      content,
      preview: '',
      type: docType,
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      agentProvider: 'claude-code',
      cwd: '~',
      storage: { kind: 'local' },
    }
    if (tempId && tempId !== realId) {
      delete this.works[tempId]
      this.hostByWorkId.delete(tempId)
    }
    if (tempId) delete this.streaming[tempId]
    base.id = realId
    base.title = title
    base.type = docType
    base.content = content
    base.preview = workPreview(docType, content)
    base.updatedAt = now
    this.works[realId] = base
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

  hostFor(workId: string): string | null {
    return this.hostByWorkId.get(workId) ?? null
  }

  /** Legacy work ids can arrive from old transcript links before any list read
   *  places them. The default host preserves that single-host cold path only. */
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
      const entry = this.ensureAnnotationsEntry(workId)
      entry.updatedAt = ann?.updatedAt ?? Date.now()
      entry.comments.splice(0, entry.comments.length, ...(ann?.comments ?? []))
      return entry
    } catch (err) {
      logWorkLoad('error', 'annotation load failed', { workId, error: formatError(err) })
      return this.annotations[workId] ?? null
    }
  }

  async saveAnnotations(workId: string): Promise<void> {
    const entry = this.ensureAnnotationsEntry(workId)
    entry.updatedAt = Date.now()
    await this.apiForWork(workId).saveWorkAnnotations($state.snapshot(entry))
  }

  addAnnotationComment(workId: string, comment: PlanComment): void {
    const entry = this.ensureAnnotationsEntry(workId)
    entry.comments.push(comment)
    entry.updatedAt = Date.now()
  }

  editAnnotationComment(workId: string, commentId: string, text: string): void {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    comment.comment = text
    this.annotations[workId].updatedAt = Date.now()
  }

  deleteAnnotationComment(workId: string, commentId: string): void {
    const comments = this.annotations[workId]?.comments
    if (!comments) return
    const index = comments.findIndex((x) => x.id === commentId)
    if (index === -1) return
    comments.splice(index, 1)
    this.annotations[workId].updatedAt = Date.now()
  }

  addAnnotationReply(workId: string, commentId: string, reply: PlanCommentReply): void {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    // Mutate in place — the replies array is inside a $state proxy, so pushing
    // notifies the one card rather than invalidating every thread in the rail.
    if (comment.replies) comment.replies.push(reply)
    else comment.replies = [reply]
    this.annotations[workId].updatedAt = Date.now()
  }

  setAnnotationResolved(workId: string, commentId: string, by: CommentAuthor | null): void {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    if (by) {
      comment.resolvedAt = Date.now()
      comment.resolvedBy = by
    } else {
      delete comment.resolvedAt
      delete comment.resolvedBy
    }
    this.annotations[workId].updatedAt = Date.now()
  }

  markAnnotationRead(workId: string, commentId: string): void {
    const comment = this.annotations[workId]?.comments.find((x) => x.id === commentId)
    if (!comment) return
    comment.readAt = Date.now()
    this.annotations[workId].updatedAt = Date.now()
  }

  clearAnnotationComments(workId: string): void {
    const entry = this.ensureAnnotationsEntry(workId)
    entry.comments.splice(0, entry.comments.length)
    entry.updatedAt = Date.now()
  }

  async loadPrevious(workId: string, cwd?: string, contentKey = ''): Promise<WorkPrevious | null> {
    const token = ++this.nextLoadToken
    this.previousLoadTokens.set(workId, token)
    try {
      const previous = await this.apiForWork(workId).loadWorkPrevious(workId, cwd)
      if (this.previousLoadTokens.get(workId) !== token) return this.previousSnapshots[workId] ?? null
      this.previousSnapshots[workId] = previous
      return previous
    } catch (err) {
      logWorkLoad('error', 'previous snapshot load failed', { workId, contentKey, error: formatError(err) })
      return this.previousSnapshots[workId] ?? null
    }
  }

  async save(workId: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>): Promise<void> {
    const work = this.works[workId]
    const write = this.withDerivedTitle(work, updates)
    const updated = await this.apiForWork(workId).saveWork(workId, write, this.activeCwd)
    const existing = this.works[workId]
    if (existing) {
      if (write.title !== undefined) existing.title = updated.title
      if (write.preview !== undefined) existing.preview = updated.preview
      if (write.content !== undefined) existing.content = updated.content
      existing.updatedAt = updated.updatedAt
    } else {
      this.works[workId] = updated
    }
  }

  /** A still-unnamed document takes its name from the first heading the user
   *  writes. Only for documents: diagram content is JSON, and a work the user
   *  or the agent has already named keeps that name. */
  private withDerivedTitle(
    work: Work | undefined,
    updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  ): Partial<Pick<Work, 'title' | 'preview' | 'content'>> {
    if (updates.title !== undefined || updates.content === undefined) return updates
    if (!work || work.type === 'diagram' || !isPlaceholderWorkTitle(work.title)) return updates
    const heading = firstHeadingTitle(updates.content)
    return heading ? { ...updates, title: heading } : updates
  }

  /**
   * Apply an agent-driven (mid-turn) update to a work. Stale-guards on
   * updatedAt and mutates the store entry in place (Svelte 5 rule — no spreads).
   * If the work isn't loaded yet, pulls it fresh from disk.
   */
  async applyRemoteUpdate(workId: string, title: string, docType: WorkType, content: string, updatedAt: string, serverId?: string): Promise<void> {
    if (serverId) this.hostByWorkId.set(workId, serverId)
    const existing = this.works[workId]
    if (existing) {
      if (existing.updatedAt && updatedAt && updatedAt < existing.updatedAt) return
      existing.title = title
      existing.content = content
      existing.preview = workPreview(docType, content)
      existing.updatedAt = updatedAt
      this.agentRevisions[workId] = (this.agentRevisions[workId] ?? 0) + 1
      return
    }
    const work = await this.apiForWork(workId).loadWork(workId, this.activeCwd)
    if (work) {
      this.works[workId] = work
      this.agentRevisions[workId] = (this.agentRevisions[workId] ?? 0) + 1
    }
  }

  loadAll(cwd?: string): Promise<void> {
    const targetCwd = cwd ?? this.activeCwd
    const pending = this.listLoads.get(targetCwd)
    if (pending) return pending
    this.activeCwd = targetCwd
    const load = (async () => {
      try {
        const serverIds = serverConnections.connectedServerIds().filter(
          (serverId) => serverConnections.phaseFor(serverId) === 'connected',
        )
        const results = await Promise.all(serverIds.map(async (serverId) => {
          try {
            return { serverId, metas: await serverConnections.apiFor(serverId).listWorks(targetCwd) }
          } catch (error) {
            logWorkLoad('error', 'work list host load failed', { serverId, cwd: targetCwd, error: formatError(error) })
            return { serverId, error }
          }
        }))
        if (this.activeCwd !== targetCwd) return
        for (const result of results) {
          if (!result.metas) continue
          const liveIds = new Set<string>()
          for (const meta of result.metas) {
            liveIds.add(meta.id)
            this.hostByWorkId.set(meta.id, result.serverId)
            const existing = this.works[meta.id]
            if (existing) {
              applyMeta(existing, meta)
            } else {
              this.works[meta.id] = { ...meta, content: '' }
            }
          }
          // Only an owner host that answered can confirm a deletion. A failed
          // host contributes nothing and cannot evict another host's works.
          for (const id of Object.keys(this.works)) {
            if (this.hostByWorkId.get(id) !== result.serverId || liveIds.has(id) || this.streaming[id]) continue
            delete this.works[id]
            delete this.agentRevisions[id]
            this.hostByWorkId.delete(id)
            this.clearCachedSidecars(id)
          }
        }
      } catch (err) {
        logWorkLoad('error', 'work list load failed', { cwd: targetCwd, error: formatError(err) })
      } finally {
        this.listLoads.delete(targetCwd)
        this.listLoading = this.listLoads.size > 0
      }
    })()
    this.listLoads.set(targetCwd, load)
    this.listLoading = true
    return load
  }

  async ensureContent(workId: string, source = 'unknown', cwd?: string): Promise<Work | null> {
    if (cwd) this.activeCwd = cwd
    const existing = this.works[workId]
    if (existing?.content) return existing
    const pending = this.contentLoads.get(workId)
    if (pending) return pending
    const load = this.loadContentFromDisk(workId, source, existing)
    this.contentLoads.set(workId, load)
    try {
      return await load
    } finally {
      this.contentLoads.delete(workId)
    }
  }

  private async loadContentFromDisk(workId: string, source: string, existing: Work | undefined): Promise<Work | null> {
    logWorkLoad('info', 'loading content from disk', {
      workId,
      source,
      hasManifestEntry: !!existing,
      title: existing?.title,
      updatedAt: existing?.updatedAt,
    })
    try {
      const work = await this.apiForWork(workId).loadWork(workId, this.activeCwd)
      if (work) {
        this.works[workId] = work
        logWorkLoad('info', 'loaded content from disk', {
          workId,
          source,
          title: work.title,
          type: work.type,
          contentLength: work.content.length,
          updatedAt: work.updatedAt,
        })
        return work
      }
      logWorkLoad('warn', 'disk load returned no work', {
        workId,
        source,
        hadManifestEntry: !!existing,
        title: existing?.title,
      })
    } catch (err) {
      logWorkLoad('error', 'disk load failed', {
        workId,
        source,
        hadManifestEntry: !!existing,
        title: existing?.title,
        error: formatError(err),
      })
    }
    return existing ?? null
  }

  async remove(workId: string): Promise<void> {
    try {
      await this.apiForWork(workId).deleteWork(workId, this.activeCwd)
    } catch (err) {
      if (!isMissingWorkError(err)) throw err
    } finally {
      await this.loadAll(this.activeCwd)
      delete this.works[workId]
      delete this.streaming[workId]
      this.hostByWorkId.delete(workId)
      this.clearCachedSidecars(workId)
    }
  }

  /** Open the undo window: the work hides from the gallery (callers filter on
   *  pendingWorkDelete) but stays on disk until commit. Callers must already have
   *  shown their undo affordance — showing one commits the affordance it replaces,
   *  which would wipe the pending delete recorded here. */
  beginWorkDelete(work: Work): void {
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
    const existing = this.works[workId]
    const cwd = existing?.storage?.kind === 'project' ? existing.storage.projectRoot : (existing?.cwd ?? this.activeCwd)
    const api = this.apiForWork(workId)
    // The same choice `apiForWork` just made, so the copy is remembered on the
    // host that holds the original.
    const ownerServerId = this.hostByWorkId.get(workId) ?? serverConnections.defaultServerId()
    const duplicated = await api.duplicateWork(workId, cwd)
    this.works[duplicated.id] = duplicated
    if (ownerServerId) this.hostByWorkId.set(duplicated.id, ownerServerId)
    return duplicated
  }

  async setPinned(workId: string, pinned: boolean): Promise<void> {
    const w = this.works[workId]
    if (w) w.pinned = pinned
    await this.apiForWork(workId).setWorkPinned(workId, pinned, this.activeCwd)
  }

  async promoteToProject(workId: string, projectRoot: string): Promise<Work> {
    const promoted = await this.apiForWork(workId).promoteWorkToProject(workId, projectRoot)
    const existing = this.works[workId]
    if (existing) {
      applyMeta(existing, promoted)
      existing.content = promoted.content
    } else {
      this.works[workId] = promoted
    }
    this.activeCwd = projectRoot
    return promoted
  }

  linkSession(cwd: string, workId: string, sessionId: string): void {
    this.linkSessionLocal(workId, sessionId)
    void this.apiForWork(workId).linkWorkSession(workId, sessionId, cwd)
  }

  async revert(workId: string, cwd?: string): Promise<Work | null> {
    const reverted = await this.apiForWork(workId).revertWork(workId, cwd)
    if (!reverted) return null
    const existing = this.works[workId]
    if (existing) {
      existing.content = reverted.content
      existing.preview = reverted.preview
      existing.updatedAt = reverted.updatedAt
    } else {
      this.works[workId] = reverted
    }
    return reverted
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

  get(workId: string): Work | undefined {
    return this.works[workId]
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
    if (this.activeCwd) opts.cwd = this.activeCwd
    if (options.destination) opts.destination = options.destination
    if (options.diagramAssets?.length) opts.diagramAssets = options.diagramAssets
    if (options.force) opts.force = true

    const result = await this.apiForWork(workId).publishWork(workId, opts)
    if (result.link) this.applyLink(workId, result.link)
    return result
  }

  async pullUpstream(workId: string): Promise<WorkPullResult> {
    const result = await this.apiForWork(workId).pullWorkUpstream(workId, this.activeCwd)
    if (!result.ok) return result
    const existing = this.works[workId]
    if (existing) {
      existing.title = result.title
      existing.content = result.content
      existing.preview = workPreview(existing.type, result.content)
      existing.mirroredDoc = result.link
    }
    // The pulled content replaced the local one, so the snapshot the revert
    // action offers has changed.
    void this.loadPrevious(workId, this.activeCwd)
    return result
  }

  /** Version metadata only, and only while the work is on screen. */
  async refreshUpstream(workId: string): Promise<void> {
    try {
      const link = await this.apiForWork(workId).refreshWorkUpstream(workId, this.activeCwd)
      if (link) this.applyLink(workId, link)
    } catch (err) {
      logWorkLoad('warn', 'upstream refresh failed', { workId, error: formatError(err) })
    }
  }

  /** Stops tracking the upstream doc. The page itself is never touched. */
  async unlinkUpstream(workId: string): Promise<void> {
    await this.apiForWork(workId).unlinkWorkUpstream(workId, this.activeCwd)
    const existing = this.works[workId]
    if (existing) existing.mirroredDoc = undefined
  }

  async importFromUrl(url: string, serverId?: string): Promise<Work> {
    const targetServerId = serverId ?? serverConnections.defaultServerId()
    if (!targetServerId) throw new Error('Primary Solus connection has not been registered')
    const work = await serverConnections.apiFor(targetServerId).importDocFromUrl(url, this.activeCwd)
    this.works[work.id] = work
    this.hostByWorkId.set(work.id, targetServerId)
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

  private applyLink(workId: string, link: WorkExternalLink): void {
    const existing = this.works[workId]
    if (existing) existing.mirroredDoc = link
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
    delete this.previousSnapshots[workId]
    this.annotationLoadTokens.delete(workId)
    this.previousLoadTokens.delete(workId)
  }
}

function applyMeta(work: Work, meta: WorkMeta & { id: string }): void {
  work.id = meta.id
  work.title = meta.title
  work.preview = meta.preview
  work.type = meta.type
  work.createdAt = meta.createdAt
  work.updatedAt = meta.updatedAt
  work.sessionId = meta.sessionId
  work.sessionIds = meta.sessionIds
  work.agentProvider = meta.agentProvider
  work.cwd = meta.cwd
  work.storage = meta.storage ?? { kind: 'local' }
  work.pinned = meta.pinned
  work.mirroredDoc = meta.mirroredDoc
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

function formatError(err: Parameters<typeof String>[0]): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
