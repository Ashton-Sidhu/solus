import type { AgentId, PlanComment, Work, WorkAnnotations, WorkMeta, WorkPrevious } from '../../../shared/types'
import { uuid } from '../../../shared/uuid'
import { workPreview } from '../../../shared/work-preview'

export class WorksStore {
  works = $state<Record<string, Work>>({})
  activeCwd = $state<string | undefined>(undefined)
  annotations = $state<Record<string, WorkAnnotations>>({})
  previousSnapshots = $state<Record<string, WorkPrevious | null>>({})
  /** Per-work counter, bumped only on agent-driven (mid-turn) updates. Open
   *  viewers watch this to decide when to live-refresh vs. surface a conflict. */
  agentRevisions = $state<Record<string, number>>({})
  /** Set true for a work whose create_work tool call is still in flight
   *  (provisional, not yet persisted). The card renders a generating skeleton
   *  while this is true; cleared on finalize. */
  streaming = $state<Record<string, boolean>>({})
  private annotationLoadTokens = new Map<string, number>()
  private previousLoadTokens = new Map<string, number>()
  private nextLoadToken = 0
  private listLoads = new Map<string | undefined, Promise<void>>()
  /** In-flight ensureContent loads, keyed by workId. Concurrent callers (a
   *  grouped-invalidation burst re-runs the hydration effect while a load is
   *  pending) share the same promise instead of firing duplicate loadWork IPC. */
  private contentLoads = new Map<string, Promise<Work | null>>()

  /** Register a provisional work while a create_work tool call is in flight. The
   *  card shows a generating skeleton (content is not streamed in); on
   *  work_created, finalizeProvisional swaps in the persisted id and content.
   *  The empty entry carries the agent/cwd so finalize can preserve them.
   *  Returns the generated provisional id. */
  addProvisional(agentProvider: AgentId, cwd: string): string {
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
    return tempId
  }

  /** Reconcile a provisional to the persisted work: rekey temp→real id, set the
   *  authoritative content/title/type, and clear the streaming flag. When there
   *  is no provisional (Codex/mock emit work_created without streaming), this
   *  simply inserts the finished work. */
  finalizeProvisional(tempId: string | null, realId: string, title: string, docType: 'doc' | 'slides' | 'diagram', content: string): void {
    const provisional = tempId ? this.works[tempId] : undefined
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
    if (tempId && tempId !== realId) delete this.works[tempId]
    if (tempId) delete this.streaming[tempId]
    base.id = realId
    base.title = title
    base.type = docType
    base.content = content
    base.preview = workPreview(docType, content)
    base.updatedAt = now
    this.works[realId] = base
  }

  /** Drop a provisional whose create_work never persisted (tool errored). */
  removeProvisional(tempId: string): void {
    delete this.works[tempId]
    delete this.streaming[tempId]
  }

  annotationComments(workId: string): PlanComment[] {
    return this.annotations[workId]?.comments ?? []
  }

  async loadAnnotations(workId: string): Promise<WorkAnnotations | null> {
    const token = ++this.nextLoadToken
    this.annotationLoadTokens.set(workId, token)
    try {
      const ann = await window.solus.loadWorkAnnotations(workId)
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

  clearAnnotationComments(workId: string): void {
    const entry = this.ensureAnnotationsEntry(workId)
    entry.comments.splice(0, entry.comments.length)
    entry.updatedAt = Date.now()
  }

  async loadPrevious(workId: string, cwd?: string, contentKey = ''): Promise<WorkPrevious | null> {
    const token = ++this.nextLoadToken
    this.previousLoadTokens.set(workId, token)
    try {
      const previous = await window.solus.loadWorkPrevious(workId, cwd)
      if (this.previousLoadTokens.get(workId) !== token) return this.previousSnapshots[workId] ?? null
      this.previousSnapshots[workId] = previous
      return previous
    } catch (err) {
      logWorkLoad('error', 'previous snapshot load failed', { workId, contentKey, error: formatError(err) })
      return this.previousSnapshots[workId] ?? null
    }
  }

  async save(workId: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>): Promise<void> {
    const updated = await window.solus.saveWork(workId, updates, this.activeCwd)
    const existing = this.works[workId]
    if (existing) {
      if (updates.title !== undefined) existing.title = updated.title
      if (updates.preview !== undefined) existing.preview = updated.preview
      if (updates.content !== undefined) existing.content = updated.content
      existing.updatedAt = updated.updatedAt
    } else {
      this.works[workId] = updated
    }
  }

  /**
   * Apply an agent-driven (mid-turn) update to a work. Stale-guards on
   * updatedAt and mutates the store entry in place (Svelte 5 rule — no spreads).
   * If the work isn't loaded yet, pulls it fresh from disk.
   */
  async applyRemoteUpdate(workId: string, title: string, docType: 'doc' | 'slides' | 'diagram', content: string, updatedAt: string): Promise<void> {
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
    const work = await window.solus.loadWork(workId, this.activeCwd)
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
        const metas = await window.solus.listWorks(targetCwd)
        if (this.activeCwd !== targetCwd) return
        const liveIds = new Set<string>()
        for (const meta of metas) {
          liveIds.add(meta.id)
          const existing = this.works[meta.id]
          if (existing) {
            applyMeta(existing, meta)
          } else {
            this.works[meta.id] = { ...meta, content: '' }
          }
        }
        for (const id of Object.keys(this.works)) {
          if (liveIds.has(id) || this.streaming[id]) continue
          delete this.works[id]
          delete this.agentRevisions[id]
          this.clearCachedSidecars(id)
        }
      } catch (err) {
        logWorkLoad('error', 'work list load failed', { cwd: targetCwd, error: formatError(err) })
      } finally {
        this.listLoads.delete(targetCwd)
      }
    })()
    this.listLoads.set(targetCwd, load)
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
      const work = await window.solus.loadWork(workId, this.activeCwd)
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
      await window.solus.deleteWork(workId, this.activeCwd)
    } catch (err) {
      if (!isMissingWorkError(err)) throw err
    } finally {
      await this.loadAll(this.activeCwd)
      delete this.streaming[workId]
      this.clearCachedSidecars(workId)
    }
  }

  async duplicate(workId: string): Promise<Work> {
    const existing = this.works[workId]
    const cwd = existing?.storage?.kind === 'project' ? existing.storage.projectRoot : (existing?.cwd ?? this.activeCwd)
    const duplicated = await window.solus.duplicateWork(workId, cwd)
    this.works[duplicated.id] = duplicated
    return duplicated
  }

  async setPinned(workId: string, pinned: boolean): Promise<void> {
    const w = this.works[workId]
    if (w) w.pinned = pinned
    await window.solus.setWorkPinned(workId, pinned, this.activeCwd)
  }

  async promoteToProject(workId: string, projectRoot: string): Promise<Work> {
    const promoted = await window.solus.promoteWorkToProject(workId, projectRoot)
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
    void window.solus.linkWorkSession(workId, sessionId, cwd)
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
}

function isMissingWorkError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Work not found:')
}

function logWorkLoad(level: 'debug' | 'info' | 'warn' | 'error', message: string, data: Record<string, unknown>): void {
  console[level](`[Solus][WorksStore] ${message}`, data)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
