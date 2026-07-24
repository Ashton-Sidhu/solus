import type { SessionPreviewResult } from '../../../src/shared/session-history'
import type {
  Automation,
  AutomationAction,
  AutomationCreator,
  AutomationRun,
  AutomationTrigger,
  FilePreviewResult,
  IpcContext,
  PinnedSession,
  PlanAnnotations,
  PlanDescriptor,
  PrReviewContext,
  ProjectFilesResult,
  Work,
  WorkAnnotations,
  WorkPrevious,
  WorktreeEntry,
  WriteFileResult,
} from '../../../src/shared/types'
import type { DraftReview, ReviewComment, ReviewThread } from '../../../src/shared/providers'
import type { ReviewContext, ReviewState } from '../../../src/shared/review'
import type { Task, TaskCommentData, TaskSessionLink } from '../../../src/shared/task-types'
import type { ChangedFileStat, DiffRequest, TurnSnapshot } from '../../../src/shared/git-types'
import { DEMO_PROJECT, type DemoFixtures } from './fixtures/types'

const FIXTURE_EPOCH = Date.parse('2026-01-15T15:00:00.000Z')

type WorkPatch = Partial<Pick<Work, 'title' | 'preview' | 'content'>>
type AutomationPatch = {
  name?: string
  enabled?: boolean
  favorite?: boolean
  action?: Partial<AutomationAction>
  trigger?: AutomationTrigger
}

export class DemoStore {
  readonly fixtures: DemoFixtures
  private readonly pinnedSessions = new Map<string, PinnedSession>()
  private readonly reviewStates = new Map<string, ReviewState>()
  private workCounter = 0
  private taskCounter = 0
  private commentCounter = 0
  private automationCounter = 0
  private runCounter = 0
  private timestampCounter = 0
  private submittedReview: DraftReview | null = null

  constructor(fixtures: DemoFixtures) {
    this.fixtures = structuredClone(fixtures)
  }

  private nextTimestamp(): number {
    this.timestampCounter += 1
    return FIXTURE_EPOCH + this.timestampCounter * 1_000
  }

  private nextIso(): string {
    return new Date(this.nextTimestamp()).toISOString()
  }

  startInfo() {
    return this.fixtures.startInfo
  }

  gitStatus() {
    return this.fixtures.gitStatus
  }

  listSessions() {
    return this.fixtures.sessions.map(({ meta }) => meta)
  }

  searchSessions(request: { query: string; projectPath?: string; limit?: number }) {
    const query = request.query.trim().toLowerCase()
    const matches = this.fixtures.sessions
      .filter(({ meta }) => !request.projectPath || meta.cwd === request.projectPath || meta.projectPath === request.projectPath)
      .filter(({ meta }) => !query || `${meta.firstMessage ?? ''} ${meta.slug ?? ''}`.toLowerCase().includes(query))
      .map(({ meta }) => ({
        session: meta,
        snippet: meta.firstMessage ?? meta.slug ?? meta.sessionId,
        ts: Date.parse(meta.lastTimestamp),
      }))
    return request.limit === undefined ? matches : matches.slice(0, request.limit)
  }

  loadSession(sessionId: string, limit?: number) {
    const messages = this.fixtures.sessions.find((session) => session.meta.sessionId === sessionId)?.messages ?? []
    return limit === undefined ? messages : messages.slice(-limit)
  }

  loadSessionPreview(sessionId: string): SessionPreviewResult {
    const messages = this.loadSession(sessionId)
    const head = messages.slice(0, 2)
    const tail = messages.slice(Math.max(head.length, messages.length - 2))
    return { head, tail, totalMessages: messages.length }
  }

  getSessionInfo(sessionId: string) {
    return this.fixtures.sessions.find((session) => session.meta.sessionId === sessionId)?.meta ?? null
  }

  listPinnedSessions(): PinnedSession[] {
    return [...this.pinnedSessions.values()].sort((a, b) => b.pinnedAt - a.pinnedAt)
  }

  togglePinnedSession(session: PinnedSession): PinnedSession[] {
    if (this.pinnedSessions.has(session.sessionId)) this.pinnedSessions.delete(session.sessionId)
    else this.pinnedSessions.set(session.sessionId, session)
    return this.listPinnedSessions()
  }

  listPlans(): PlanDescriptor[] {
    return this.fixtures.plans.map(({ descriptor }) => descriptor)
  }

  private findPlan(sessionId: string, planToolUseId: string) {
    return this.fixtures.plans.find((plan) =>
      plan.descriptor.sessionId === sessionId && plan.descriptor.planToolUseId === planToolUseId)
  }

  loadPlanContent(sessionId: string, planToolUseId: string): string | null {
    return this.findPlan(sessionId, planToolUseId)?.content ?? null
  }

  loadPlanAnnotations(sessionId: string, planToolUseId: string): PlanAnnotations | null {
    return this.findPlan(sessionId, planToolUseId)?.annotations ?? null
  }

  savePlanAnnotations(annotations: PlanAnnotations): boolean {
    const plan = this.findPlan(annotations.sessionId, annotations.planToolUseId)
    if (!plan) return false
    plan.annotations = annotations
    plan.descriptor.title = annotations.title
    plan.descriptor.status = annotations.status
    plan.descriptor.commentCount = annotations.comments.length
    plan.descriptor.bookmarked = annotations.bookmarked
    plan.descriptor.bookmarkedAt = annotations.bookmarkedAt
    return true
  }

  toggleBookmarkPlan(
    sessionId: string,
    projectPath: string,
    cwd: string,
    planToolUseId: string,
    title: string,
  ): PlanAnnotations {
    const plan = this.findPlan(sessionId, planToolUseId)
    if (!plan) throw new Error(`Plan not found: ${sessionId}/${planToolUseId}`)
    const bookmarked = !plan.annotations.bookmarked
    const updatedAt = this.nextTimestamp()
    plan.annotations = {
      ...plan.annotations,
      projectPath,
      cwd,
      title,
      bookmarked,
      ...(bookmarked ? { bookmarkedAt: updatedAt } : { bookmarkedAt: undefined }),
      updatedAt,
    }
    plan.descriptor.title = title
    plan.descriptor.bookmarked = bookmarked
    plan.descriptor.bookmarkedAt = plan.annotations.bookmarkedAt
    return plan.annotations
  }

  writePlanFile(filePath: string, content: string): boolean {
    const plan = this.fixtures.plans.find(({ descriptor }) => descriptor.planFilePath === filePath)
    if (!plan) return false
    plan.content = content
    plan.descriptor.excerpt = content.replace(/\s+/g, ' ').slice(0, 180)
    return true
  }

  private findWorkEntry(id: string) {
    return this.fixtures.works.find(({ meta }) => meta.id === id)
  }

  listWorks() {
    return this.fixtures.works
      .map(({ meta }) => meta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  loadWork(id: string): Work | null {
    const entry = this.findWorkEntry(id)
    return entry ? { ...entry.meta, content: entry.content } : null
  }

  saveWork(id: string, patch: WorkPatch): Work {
    const entry = this.findWorkEntry(id)
    if (!entry) throw new Error(`Work not found: ${id}`)
    if (patch.title !== undefined) entry.meta.title = patch.title
    if (patch.preview !== undefined) entry.meta.preview = patch.preview
    if (patch.content !== undefined) entry.content = patch.content
    entry.meta.updatedAt = this.nextIso()
    return { ...entry.meta, content: entry.content }
  }

  createWork(
    title: string,
    type: Work['type'],
    content: string | undefined,
    preview: string | undefined,
    sessionId: string | undefined,
    agentProvider: Work['agentProvider'],
    cwd: string | undefined,
    requestedId: string | undefined,
  ): Work {
    const id = requestedId ?? `demo-work-${++this.workCounter}`
    const createdAt = this.nextIso()
    const work: Work = {
      id,
      title,
      type,
      content: content ?? '',
      preview: preview ?? '',
      createdAt,
      updatedAt: createdAt,
      sessionId,
      sessionIds: sessionId ? [sessionId] : [],
      agentProvider,
      cwd: cwd ?? DEMO_PROJECT,
      storage: { kind: 'local' },
    }
    const { content: storedContent, ...meta } = work
    this.fixtures.works.push({ meta, content: storedContent })
    return work
  }

  duplicateWork(id: string): Work {
    const source = this.loadWork(id)
    if (!source) throw new Error(`Work not found: ${id}`)
    return this.createWork(
      `${source.title} copy`,
      source.type,
      source.content,
      source.preview,
      undefined,
      source.agentProvider,
      source.cwd,
      undefined,
    )
  }

  deleteWork(id: string): void {
    const index = this.fixtures.works.findIndex(({ meta }) => meta.id === id)
    if (index !== -1) this.fixtures.works.splice(index, 1)
  }

  setWorkPinned(id: string, pinned: boolean): void {
    const entry = this.findWorkEntry(id)
    if (!entry) return
    if (pinned) entry.meta.pinned = true
    else delete entry.meta.pinned
  }

  loadWorkAnnotations(id: string): WorkAnnotations | null {
    return this.findWorkEntry(id)?.annotations ?? null
  }

  saveWorkAnnotations(annotations: WorkAnnotations): void {
    const entry = this.findWorkEntry(annotations.workId)
    if (entry) entry.annotations = annotations
  }

  loadWorkPrevious(id: string): WorkPrevious | null {
    return this.findWorkEntry(id)?.previous ?? null
  }

  prList() {
    return this.fixtures.pr.list
  }

  prOverview() {
    return this.fixtures.pr.overview
  }

  prThreads(): ReviewThread[] {
    return this.fixtures.pr.threads
  }

  prChangedFiles(): ChangedFileStat[] {
    return this.fixtures.pr.changedFiles
  }

  prGuide() {
    return this.fixtures.pr.guide
  }

  replyToPrThread(threadId: string, body: string): ReviewComment {
    const thread = this.fixtures.pr.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Review thread not found: ${threadId}`)
    const comment: ReviewComment = {
      id: `demo-review-comment-${++this.commentCounter}`,
      author: 'you',
      body,
      createdAt: this.nextIso(),
    }
    thread.comments.push(comment)
    return comment
  }

  setPrThreadResolved(threadId: string, isResolved: boolean): void {
    const thread = this.fixtures.pr.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Review thread not found: ${threadId}`)
    thread.isResolved = isResolved
  }

  submitPrReview(review: DraftReview): void {
    this.submittedReview = review
  }

  readReviewState(key: string): ReviewState | null {
    return this.reviewStates.get(key) ?? null
  }

  writeReviewState(state: ReviewState): boolean {
    this.reviewStates.set(state.key, state)
    return true
  }

  reviewContext(ctx: IpcContext): ReviewContext {
    const detail = this.fixtures.pr.overview.detail
    const pr = ctx.session.prReview
    return {
      key: this.fixtures.pr.guide.key,
      branch: pr?.branch ?? detail.headRef,
      targetBranch: pr?.baseRef ?? detail.baseRef,
      baseSha: pr?.baseSha ?? detail.baseSha,
      headSha: pr?.headSha ?? detail.headSha,
      repoRoot: DEMO_PROJECT,
      prUrl: `https://github.com/${pr?.owner ?? 'acme'}/${pr?.repo ?? 'acme'}/pull/${pr?.number ?? detail.number}`,
    }
  }

  prReviewContext(number: number): PrReviewContext {
    const detail = this.fixtures.pr.overview.detail
    return {
      host: 'github.com',
      owner: 'acme',
      repo: 'acme',
      number,
      title: detail.title,
      baseRef: detail.baseRef,
      headSha: detail.headSha,
      baseSha: detail.baseSha,
      headRepo: detail.headRepo,
      worktreePath: DEMO_PROJECT,
      branch: detail.headRef,
    }
  }

  private commentsForTask(id: string): TaskCommentData[] {
    return this.fixtures.tasks.comments[id] ??= []
  }

  private hydrateTask(task: Task): Task {
    const raw = task.raw && typeof task.raw === 'object' ? task.raw as Record<string, unknown> : {}
    return { ...task, raw: { ...raw, comments: this.commentsForTask(task.id) } }
  }

  listTasks() {
    return { ...this.fixtures.tasks.list, tasks: this.fixtures.tasks.list.tasks.map((task) => this.hydrateTask(task)) }
  }

  getTask(id: string): Task {
    const task = this.fixtures.tasks.details[id] ?? this.fixtures.tasks.list.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return this.hydrateTask(task)
  }

  private storeTask(task: Task): Task {
    this.fixtures.tasks.details[task.id] = task
    const index = this.fixtures.tasks.list.tasks.findIndex((candidate) => candidate.id === task.id)
    if (index === -1) this.fixtures.tasks.list.tasks.unshift(task)
    else this.fixtures.tasks.list.tasks[index] = task
    return this.hydrateTask(task)
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const current = this.getTask(id)
    return this.storeTask({ ...current, ...patch, id, updatedAt: this.nextIso() })
  }

  createTask(input: Partial<Task>): Task {
    const id = `demo-task-${++this.taskCounter}`
    const task: Task = {
      providerId: 'local',
      kind: input.kind ?? 'task',
      title: input.title ?? 'Untitled task',
      body: input.body ?? '',
      status: input.status ?? 'open',
      url: null,
      labels: input.labels ?? [],
      canEditPlanningFields: true,
      updatedAt: this.nextIso(),
      raw: {},
      ...input,
      id,
    }
    this.fixtures.tasks.comments[id] = []
    return this.storeTask(task)
  }

  commentTask(id: string, body: string): Task {
    this.getTask(id)
    this.commentsForTask(id).push({
      id: `demo-task-comment-${++this.commentCounter}`,
      author: { login: 'you' },
      body,
      createdAt: this.nextIso(),
    })
    return this.updateTask(id, {})
  }

  deleteTask(id: string): boolean {
    const index = this.fixtures.tasks.list.tasks.findIndex((task) => task.id === id)
    if (index === -1) return false
    this.fixtures.tasks.list.tasks.splice(index, 1)
    delete this.fixtures.tasks.details[id]
    delete this.fixtures.tasks.comments[id]
    delete this.fixtures.tasks.sessions[id]
    return true
  }

  taskSessions(): Record<string, TaskSessionLink[]> {
    return this.fixtures.tasks.sessions
  }

  linkTaskSession(taskId: string, sessionId: string): void {
    const links = this.fixtures.tasks.sessions[taskId] ??= []
    if (!links.some((link) => link.sessionId === sessionId)) {
      links.push({ sessionId, linkedAt: this.nextTimestamp() })
    }
  }

  listAutomations(): Automation[] {
    return this.fixtures.automations.list
  }

  readAutomation(id: string): Automation | null {
    return this.fixtures.automations.list.find((automation) => automation.id === id) ?? null
  }

  updateAutomation(id: string, patch: AutomationPatch): Automation | null {
    const automation = this.readAutomation(id)
    if (!automation) return null
    if (patch.name !== undefined) automation.name = patch.name
    if (patch.enabled !== undefined) automation.enabled = patch.enabled
    if (patch.favorite !== undefined) automation.favorite = patch.favorite
    if (patch.action) automation.action = { ...automation.action, ...patch.action }
    if (patch.trigger !== undefined) automation.trigger = patch.trigger
    automation.updatedAt = this.nextIso()
    return automation
  }

  createAutomation(
    name: string,
    action: AutomationAction,
    createdBy: AutomationCreator,
    enabled = true,
    trigger: AutomationTrigger = { type: 'manual' },
  ): Automation {
    const timestamp = this.nextIso()
    const automation: Automation = {
      id: `demo-automation-${++this.automationCounter}`,
      name,
      action,
      createdBy,
      enabled,
      trigger,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.fixtures.automations.list.unshift(automation)
    this.fixtures.automations.runs[automation.id] = []
    return automation
  }

  deleteAutomation(id: string): boolean {
    const index = this.fixtures.automations.list.findIndex((automation) => automation.id === id)
    if (index === -1) return false
    this.fixtures.automations.list.splice(index, 1)
    delete this.fixtures.automations.runs[id]
    return true
  }

  listAutomationRuns(id: string): AutomationRun[] {
    return this.fixtures.automations.runs[id] ?? []
  }

  readAutomationRun(automationId: string, runId: string): AutomationRun | null {
    return this.listAutomationRuns(automationId).find((run) => run.id === runId) ?? null
  }

  startAutomationRun(id: string): { automation: Automation; run: AutomationRun } | null {
    const automation = this.readAutomation(id)
    if (!automation?.enabled) return null
    const run: AutomationRun = {
      id: `demo-automation-run-${++this.runCounter}`,
      automationId: id,
      startedAt: this.nextIso(),
      status: 'running',
    }
    ;(this.fixtures.automations.runs[id] ??= []).unshift(run)
    automation.lastRunId = run.id
    automation.lastRunStatus = run.status
    automation.lastRunAt = run.startedAt
    return { automation, run }
  }

  finishAutomationRun(automationId: string, runId: string): { automation: Automation; run: AutomationRun } | null {
    const automation = this.readAutomation(automationId)
    const run = this.readAutomationRun(automationId, runId)
    if (!automation || !run) return null
    run.status = 'succeeded'
    run.finishedAt = this.nextIso()
    run.output = 'Demo automation completed successfully.'
    automation.lastRunStatus = run.status
    return { automation, run }
  }

  diff(ctx: IpcContext, request: DiffRequest): { patch: string } {
    if (request.scope.kind === 'pr') {
      const selected = request.livePaths?.length
        ? request.livePaths.map((path) => this.fixtures.pr.filePatches[path]).filter((patch): patch is string => !!patch)
        : Object.values(this.fixtures.pr.filePatches)
      return { patch: selected.join('\n') }
    }
    return { patch: this.diffFixture(ctx)?.patch ?? '' }
  }

  diffStats(ctx: IpcContext, request: DiffRequest): ChangedFileStat[] {
    const stats = request.scope.kind === 'pr' ? this.fixtures.pr.changedFiles : this.diffFixture(ctx)?.stats ?? []
    return request.livePaths?.length ? stats.filter((stat) => request.livePaths?.includes(stat.path)) : stats
  }

  turnSnapshots(ctx: IpcContext): TurnSnapshot[] {
    return this.diffFixture(ctx)?.turnSnapshots ?? []
  }

  worktrees(): WorktreeEntry[] {
    return [{ path: DEMO_PROJECT, branch: this.fixtures.gitStatus.branch ?? 'main', lastModified: FIXTURE_EPOCH }]
  }

  listProjectFiles(): ProjectFilesResult {
    return {
      ok: true,
      root: this.fixtures.files.root,
      files: this.fixtures.files.files,
      truncated: false,
      source: 'index',
    }
  }

  readProjectFile(path: string): FilePreviewResult {
    const contents = this.fixtures.files.contents[path]
    if (contents === undefined) return { ok: false, path, error: `File not found: ${path}` }
    return { ok: true, path, displayPath: path, contents, size: contents.length }
  }

  writeFile(path: string, contents: string): WriteFileResult {
    this.fixtures.files.contents[path] = contents
    if (!this.fixtures.files.files.includes(path)) this.fixtures.files.files.push(path)
    return { ok: true, path, displayPath: path, size: contents.length }
  }

  private diffFixture(ctx: IpcContext) {
    return this.fixtures.diffs[ctx.session.tabId]
  }
}
