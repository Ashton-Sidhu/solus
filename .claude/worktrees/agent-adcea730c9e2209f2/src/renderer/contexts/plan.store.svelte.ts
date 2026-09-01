import { createContext } from 'svelte'
import type { AgentId, IpcContext, Plan, PlanComment, PlanAnnotations, PlanDescriptor, PermissionOption } from '../../shared/types'
import { planKey } from '../../shared/types'
import { MemoryCache } from '../../shared/cache'

function extractPlanTitle(planContent: string): string {
  const match = planContent.match(/^#{1,2}\s+(.+)$/m)
  if (match) return match[1].trim().slice(0, 120)
  const firstLine = planContent.split(/\r?\n/).find((l) => l.trim().length > 0)
  return (firstLine ?? '').trim().slice(0, 60) || 'Untitled plan'
}

type DiskPlanLoadOptions = {
  sessionId: string
  planToolUseId: string
  projectPath: string
  cwd: string
  title?: string
  status?: Plan['status']
  timestamp?: number
  filePath?: string
  bookmarked?: boolean
  bookmarkedAt?: number
  ctx?: IpcContext
  provider?: AgentId | null
}

export class PlanStore {
  plans = $state<Record<string, Plan>>({})
  previewPlanId = $state<string | null>(null)
  previewDescriptor = $state<PlanDescriptor | null>(null)

  private _saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  get previewPlan(): Plan | null {
    if (!this.previewPlanId) return null
    return this.plans[this.previewPlanId] ?? null
  }

  get(planId: string): Plan | undefined {
    return this.plans[planId]
  }

  plansForSession(sessionId: string): Plan[] {
    return Object.values(this.plans)
      .filter((p) => p.sessionId === sessionId)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  descriptorFor(planId: string): PlanDescriptor | null {
    const plan = this.plans[planId]
    if (!plan) return null
    return {
      planToolUseId: plan.planToolUseId,
      sessionId: plan.sessionId,
      projectPath: plan.projectPath,
      cwd: plan.cwd,
      timestamp: plan.timestamp,
      title: plan.title,
      excerpt: '',
      status: plan.status,
      commentCount: plan.comments.length,
      bookmarked: plan.bookmarked,
      bookmarkedAt: plan.bookmarkedAt,
      revisions: [],
    }
  }

  // ─── Loading ───

  upsertFromStream(opts: {
    sessionId: string
    planToolUseId: string
    projectPath: string
    cwd: string
    content: string
    filePath?: string
    questionId?: string
    options?: PermissionOption[]
    timestamp: number
  }): string {
    const id = planKey(opts.sessionId, opts.planToolUseId)
    const existing = this.plans[id]
    if (existing) {
      existing.content = opts.content
      existing.filePath = opts.filePath
      existing.questionId = opts.questionId
      existing.options = opts.options
      existing.title = extractPlanTitle(opts.content)
      return id
    }
    this.plans[id] = {
      id,
      sessionId: opts.sessionId,
      planToolUseId: opts.planToolUseId,
      projectPath: opts.projectPath,
      cwd: opts.cwd,
      timestamp: opts.timestamp,
      content: opts.content,
      filePath: opts.filePath,
      questionId: opts.questionId,
      options: opts.options,
      title: extractPlanTitle(opts.content),
      status: 'pending',
      comments: [],
      bookmarked: false,
    }
    return id
  }

  upsertFromHistory(opts: {
    sessionId: string
    planToolUseId: string
    projectPath: string
    cwd: string
    content: string
    filePath?: string
    timestamp: number
  }): string {
    const id = planKey(opts.sessionId, opts.planToolUseId)
    const existing = this.plans[id]
    if (existing) {
      existing.projectPath = opts.projectPath
      existing.cwd = opts.cwd
      existing.timestamp = opts.timestamp
      existing.content = opts.content
      existing.filePath = opts.filePath
      existing.title = extractPlanTitle(opts.content)
      return id
    }
    this.plans[id] = {
      id,
      sessionId: opts.sessionId,
      planToolUseId: opts.planToolUseId,
      projectPath: opts.projectPath,
      cwd: opts.cwd,
      timestamp: opts.timestamp,
      content: opts.content,
      filePath: opts.filePath,
      title: extractPlanTitle(opts.content),
      status: 'pending',
      comments: [],
      bookmarked: false,
    }
    return id
  }

  async loadFromDisk(opts: DiskPlanLoadOptions): Promise<string> {
    const id = planKey(opts.sessionId, opts.planToolUseId)
    const existing = this.plans[id]
    const [content, ann] = await Promise.all([
      window.solus.loadPlanContent(opts.sessionId, opts.projectPath, opts.planToolUseId, opts.ctx, opts.provider ?? undefined),
      window.solus.loadPlanAnnotations(opts.sessionId, opts.planToolUseId),
    ])

    const next = {
      sessionId: opts.sessionId,
      planToolUseId: opts.planToolUseId,
      projectPath: opts.projectPath,
      cwd: opts.cwd,
      timestamp: opts.timestamp ?? existing?.timestamp ?? Date.now(),
      content: content || '',
      filePath: opts.filePath ?? existing?.filePath,
      title: opts.title ?? existing?.title ?? extractPlanTitle(content || ''),
      status: ann?.status ?? opts.status ?? existing?.status ?? 'pending',
      comments: ann?.comments ?? existing?.comments ?? [],
      bookmarked: ann?.bookmarked ?? opts.bookmarked ?? existing?.bookmarked ?? false,
      bookmarkedAt: ann?.bookmarkedAt ?? opts.bookmarkedAt ?? existing?.bookmarkedAt,
    }

    if (existing) {
      existing.sessionId = next.sessionId
      existing.planToolUseId = next.planToolUseId
      existing.projectPath = next.projectPath
      existing.cwd = next.cwd
      existing.timestamp = next.timestamp
      existing.content = next.content
      existing.filePath = next.filePath
      existing.title = next.title
      existing.status = next.status
      existing.comments = next.comments
      existing.bookmarked = next.bookmarked
      existing.bookmarkedAt = next.bookmarkedAt
    } else {
      this.plans[id] = {
        id,
        ...next,
      }
    }

    return id
  }

  async hydrateAnnotations(planId: string): Promise<void> {
    const plan = this.plans[planId]
    if (!plan) return
    // Flush any pending save first so disk reflects the latest in-memory state
    // before we read it back. Otherwise a quick close/reopen can clobber an
    // unsaved comment with stale annotations from disk.
    const pending = this._saveTimers.get(planId)
    if (pending) {
      clearTimeout(pending)
      this._saveTimers.delete(planId)
      await this.persist(planId)
    }
    try {
      const ann = await window.solus.loadPlanAnnotations(plan.sessionId, plan.planToolUseId)
      if (!ann) return
      // A mutation scheduled a save during our read — in-memory is newer than disk.
      if (this._saveTimers.has(planId)) return
      const current = this.plans[planId]
      if (!current) return
      current.comments = ann.comments ?? []
      current.status = ann.status ?? current.status
      current.bookmarked = ann.bookmarked
    } catch {}
  }

  // ─── Mutations ───

  addComment(planId: string, comment: PlanComment): void {
    const plan = this.plans[planId]
    if (!plan) return
    plan.comments.push(comment)
    this.scheduleSave(planId)
  }

  removeComment(planId: string, commentId: string): void {
    const plan = this.plans[planId]
    if (!plan) return
    const idx = plan.comments.findIndex((c) => c.id === commentId)
    if (idx !== -1) plan.comments.splice(idx, 1)
    this.scheduleSave(planId)
  }

  updateComment(planId: string, commentId: string, newText: string): void {
    const plan = this.plans[planId]
    if (!plan) return
    const c = plan.comments.find((pc) => pc.id === commentId)
    if (c) c.comment = newText
    this.scheduleSave(planId)
  }

  updateContent(planId: string, newContent: string): void {
    const plan = this.plans[planId]
    if (plan) {
      plan.content = newContent
      plan.title = extractPlanTitle(newContent)
    }
  }

  setStatus(planId: string, status: Plan['status']): void {
    const plan = this.plans[planId]
    if (plan) plan.status = status
    this.scheduleSave(planId)
  }

  // ─── Bookmark ───

  async toggleBookmark(planId: string): Promise<void> {
    const plan = this.plans[planId]
    if (!plan) return
    const ann = await window.solus.toggleBookmarkPlan(
      plan.sessionId, plan.projectPath, plan.cwd, plan.planToolUseId, plan.title,
    )
    const current = this.plans[planId]
    if (current) current.bookmarked = ann.bookmarked
  }

  // ─── Preview (gallery) ───

  openPreview(planId: string): void {
    this.previewPlanId = planId
    void this.hydrateAnnotations(planId)
  }

  dismissPreview(): void {
    this.previewDescriptor = null
    this.previewPlanId = null
  }

  // ─── Descriptor cache (shared by PlanGallery + # autocomplete) ───

  cachedDescriptors = $state<PlanDescriptor[]>([])
  cachedDescriptorKey = $state<string | null>(null)
  descriptorCacheLoading = $state(false)
  private _descriptorCacheTTL = 60_000
  private _descriptorCache = new MemoryCache<string, PlanDescriptor[]>({ ttlMs: this._descriptorCacheTTL })
  private _descriptorLoads = new Set<string>()

  descriptorCacheKey(projectPath: string | undefined, allProjects: boolean): string {
    return `all-providers:${allProjects ? '__all__' : projectPath}`
  }

  private setDescriptorLoading(key: string, loading: boolean): void {
    if (loading) this._descriptorLoads.add(key)
    else this._descriptorLoads.delete(key)
    this.descriptorCacheLoading = this._descriptorLoads.size > 0
  }

  private resetVisibleDescriptorsForKey(key: string): void {
    if (this.cachedDescriptorKey === key) return
    this.cachedDescriptorKey = key
    this.cachedDescriptors = []
  }

  private setVisibleDescriptorsForKey(key: string, data: PlanDescriptor[]): void {
    this.cachedDescriptorKey = key
    this.cachedDescriptors = data
  }

  private descriptorKey(d: PlanDescriptor): string {
    return `${d.provider ?? 'claude-code'}:${d.sessionId}:${d.planToolUseId}`
  }

  private syncCachedDescriptor(d: PlanDescriptor): void {
    const plan = this.plans[planKey(d.sessionId, d.planToolUseId)]
    if (plan) {
      d.status = plan.status
      d.commentCount = plan.comments.length
      d.bookmarked = plan.bookmarked
      d.bookmarkedAt = plan.bookmarkedAt
    }
    for (const revision of d.revisions) {
      const revisionPlan = this.plans[planKey(d.sessionId, revision.planToolUseId)]
      if (!revisionPlan) continue
      revision.status = revisionPlan.status
      revision.commentCount = revisionPlan.comments.length
    }
  }

  syncCachedDescriptors(items: PlanDescriptor[]): PlanDescriptor[] {
    for (const item of items) this.syncCachedDescriptor(item)
    return items
  }

  private mergeWithCached(fresh: PlanDescriptor[], cached?: PlanDescriptor[]): PlanDescriptor[] {
    if (!cached?.length) return fresh
    const seen = new Set(fresh.map((d) => this.descriptorKey(d)))
    for (const cachedDescriptor of this.syncCachedDescriptors(cached)) {
      if (!seen.has(this.descriptorKey(cachedDescriptor))) fresh.push(cachedDescriptor)
    }
    fresh.sort((a, b) => b.timestamp - a.timestamp)
    return fresh
  }

  async getDescriptors(projectPath: string | undefined, allProjects: boolean, ctx?: IpcContext): Promise<PlanDescriptor[]> {
    const key = this.descriptorCacheKey(projectPath, allProjects)
    if (!allProjects) this.resetVisibleDescriptorsForKey(key)
    const cached = this._descriptorCache.getEntry(key, { allowStale: true })
    if (cached && !cached.isStale) {
      const synced = this.syncCachedDescriptors(cached.value)
      if (!allProjects) this.setVisibleDescriptorsForKey(key, synced)
      return synced
    }
    if (cached) {
      const synced = this.syncCachedDescriptors(cached.value)
      if (!allProjects) this.setVisibleDescriptorsForKey(key, synced)
    }
    this.setDescriptorLoading(key, true)
    try {
      const fresh = await this._descriptorCache.getOrLoad(key, () => (
        window.solus.listPlans(projectPath, allProjects, ctx)
      ))
      const merged = this.mergeWithCached(fresh, cached?.value)
      this._descriptorCache.set(key, merged)
      if (!allProjects && this.cachedDescriptorKey === key) this.cachedDescriptors = merged
      return merged
    } finally {
      this.setDescriptorLoading(key, false)
    }
  }

  preloadDescriptors(projectPath: string, ctx?: IpcContext): void {
    const key = this.descriptorCacheKey(projectPath, false)
    this.resetVisibleDescriptorsForKey(key)
    const cached = this._descriptorCache.getEntry(key, { allowStale: true })
    if (cached && !cached.isStale) {
      this.setVisibleDescriptorsForKey(key, this.syncCachedDescriptors(cached.value))
      return
    }
    if (cached) this.setVisibleDescriptorsForKey(key, this.syncCachedDescriptors(cached.value))
    if (this._descriptorLoads.has(key)) return
    this.setDescriptorLoading(key, true)
    this._descriptorCache.getOrLoad(key, () => (
      window.solus.listPlans(projectPath, false, ctx)
    )).then((fresh) => {
      const merged = this.mergeWithCached(fresh, cached?.value)
      this._descriptorCache.set(key, merged)
      if (this.cachedDescriptorKey === key) this.cachedDescriptors = merged
    }).catch(() => {}).finally(() => {
      this.setDescriptorLoading(key, false)
    })
  }

  invalidateDescriptorCache(): void {
    this._descriptorCache.clear()
    this.cachedDescriptors = []
    this.cachedDescriptorKey = null
  }

  // ─── Persistence ───

  scheduleSave(planId: string): void {
    const existing = this._saveTimers.get(planId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this._saveTimers.delete(planId)
      void this.persist(planId)
    }, 300)
    this._saveTimers.set(planId, timer)
  }

  // ─── Content-save (plan body to disk) ───

  async flushContentSave(planId: string): Promise<void> {
    const plan = this.plans[planId]
    if (!plan?.filePath) return
    try {
      await window.solus.writePlanFile(plan.filePath, plan.content)
    } catch {}
  }

  private async persist(planId: string): Promise<void> {
    const plan = this.plans[planId]
    if (!plan) return
    const payload: PlanAnnotations = {
      version: 1,
      sessionId: plan.sessionId,
      projectPath: plan.projectPath,
      cwd: plan.cwd,
      planToolUseId: plan.planToolUseId,
      title: plan.title,
      status: plan.status,
      comments: plan.comments,
      bookmarked: plan.bookmarked,
      updatedAt: Date.now(),
    }
    await window.solus.savePlanAnnotations($state.snapshot(payload))
  }
}

export const [getPlanStore, setPlanStore] = createContext<PlanStore>()
