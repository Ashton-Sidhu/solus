import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@client-core/server-connections'
import type {
  Task,
  TaskCreateInput,
  TaskDetails,
  TaskLinkInput,
  TaskLinkKind,
  TaskProviderStatus,
  TaskSessionLink,
  TaskStatus,
  TaskUpdatePatch,
} from '../../../shared/task-types'
import { upstreamTaskDetails } from './upstream-task-details'

const INVALIDATION_DEBOUNCE_MS = 100

/** Global, local-first task state shared by every renderer surface. Local tasks
 * live in `tasks`; upstream tickets (GitHub issues) are kept per-project in
 * `upstreamTasksByProject` and routed to the `tasks*Upstream` RPCs by their
 * `providerId`. */
export class TasksStore {
  tasks = $state<Task[]>([])
  loading = $state(false)
  loaded = $state(false)
  error = $state<string | null>(null)
  refreshedAt = $state<number | null>(null)

  byProject: Map<string, Task[]> = $derived.by(() => {
    const grouped = new Map<string, Task[]>()
    for (const task of this.tasks) {
      if (!task.projectKey) continue
      const tasks = grouped.get(task.projectKey)
      if (tasks) tasks.push(task)
      else grouped.set(task.projectKey, [task])
    }
    return grouped
  })

  byParent: Map<string, Task[]> = $derived.by(() => {
    const grouped = new Map<string, Task[]>()
    for (const task of this.tasks) {
      if (!task.parentId) continue
      const tasks = grouped.get(task.parentId)
      if (tasks) tasks.push(task)
      else grouped.set(task.parentId, [task])
    }
    return grouped
  })

  inbox: Task[] = $derived(this.tasks.filter((task) => !task.projectKey && task.status !== 'dropped'))
  upNext: Task[] = $derived(
    this.tasks.filter((task) => task.status === 'todo' || task.status === 'in_progress' || task.status === 'in_review'),
  )

  sessionsByTask = new SvelteMap<string, TaskSessionLink[]>()
  /** Comments, links and activity for tasks a detail surface has opened. */
  detailsByTask = new SvelteMap<string, TaskDetails>()
  providerStatusByCwd = new SvelteMap<string, TaskProviderStatus>()
  upstreamTasksByProject = new SvelteMap<string, Task[]>()
  upstreamErrorByProject = new SvelteMap<string, string>()
  upstreamFromCacheByProject = new SvelteMap<string, boolean>()
  upstreamRefreshedAtByProject = new SvelteMap<string, number>()
  upstreamTruncatedByProject = new SvelteMap<string, boolean>()
  upstreamLoadingByProject = new SvelteMap<string, boolean>()

  private taskIdBySessionId = new SvelteMap<string, string>()
  private loadPromise: Promise<void> | null = null
  private providerStatusLoadsByCwd = new Map<string, Promise<TaskProviderStatus>>()
  private upstreamLoadsByProject = new Map<string, Promise<void>>()
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    serverConnections.eventsFor().subscribe('tasks.invalidated', () => {
      if (this.invalidationTimer) clearTimeout(this.invalidationTimer)
      this.invalidationTimer = setTimeout(() => {
        this.invalidationTimer = null
        void this.load()
        // The broadcast carries no payload, so an open detail surface re-reads
        // its own task: another actor (an agent linking a doc mid-session) does
        // not otherwise reach it.
        for (const taskId of this.detailsByTask.keys()) void this.loadDetails(taskId)
      }, INVALIDATION_DEBOUNCE_MS)
    })
    queueMicrotask(() => void this.ensureLoaded())
  }

  tasksForProject(projectKey: string | null | undefined): Task[] {
    if (!projectKey) return []
    return [
      ...(this.byProject.get(projectKey) ?? []),
      ...(this.upstreamTasksByProject.get(projectKey) ?? []),
    ]
  }

  taskForId(id: string, projectKey?: string): Task | null {
    return this.taskById(id, projectKey) ?? null
  }

  taskForSession(sessionId: string | null | undefined): Task | null {
    if (!sessionId) return null
    const taskId = this.taskIdBySessionId.get(sessionId)
    return taskId ? (this.tasks.find((task) => task.id === taskId) ?? null) : null
  }

  providerStatus(cwd: string | null | undefined): TaskProviderStatus | null {
    return cwd ? (this.providerStatusByCwd.get(cwd) ?? null) : null
  }

  loadProviderStatus(cwd: string, opts?: { checkAccess?: boolean }): Promise<TaskProviderStatus> {
    const pending = this.providerStatusLoadsByCwd.get(cwd)
    if (pending) return pending
    const load = (async () => {
      try {
        const status = await window.solus.tasksProviderStatus(cwd, opts)
        this.providerStatusByCwd.set(cwd, status)
        return status
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.error = message
        const status: TaskProviderStatus = {
          provider: this.providerStatus(cwd)?.provider ?? 'local',
          ok: false,
          reason: 'github_access_failed',
          message,
        }
        this.providerStatusByCwd.set(cwd, status)
        return status
      } finally {
        this.providerStatusLoadsByCwd.delete(cwd)
      }
    })()
    this.providerStatusLoadsByCwd.set(cwd, load)
    return load
  }

  /** `loaded` means "the first attempt finished", which is what the spinners
   *  read — but a failed attempt must not stand in for a successful one here,
   *  or one bad snapshot latches every task surface empty for the rest of the
   *  session: no sidebar tree, no subtasks, no rail card. Retry while the last
   *  attempt is still the failed one. */
  ensureLoaded(): Promise<void> {
    if (this.loaded && !this.error) return Promise.resolve()
    return this.loadPromise ?? this.load()
  }

  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loading = true
    this.error = null
    const load = (async () => {
      try {
        const snapshot = await window.solus.tasksSidebarSnapshot()
        this.tasks.splice(0, this.tasks.length, ...snapshot.tasks)
        this.replaceLinks(snapshot.sessionsByTask)
        this.loaded = true
        this.refreshedAt = Date.now()
      } catch (err) {
        // Every task surface reads this one snapshot, so a silent failure
        // presents as "the sidebar lost my tasks" or "the card vanished"
        // rather than as a failed read. Say so.
        console.error('tasks sidebar snapshot load failed', err)
        this.error = err instanceof Error ? err.message : String(err)
        this.loaded = true
      } finally {
        this.loading = false
        this.loadPromise = null
      }
    })()
    this.loadPromise = load
    return load
  }

  /** Fetch a project's upstream tickets — the cached snapshot by default, a
   * live provider read with `refresh`. A project with no upstream provider
   * returns an empty list; errors land in `upstreamErrorByProject` instead of
   * failing the local list. */
  async loadUpstream(projectKey: string, opts?: { refresh?: boolean }): Promise<void> {
    const pending = this.upstreamLoadsByProject.get(projectKey)
    if (pending) return pending

    this.upstreamLoadingByProject.set(projectKey, true)
    this.upstreamErrorByProject.delete(projectKey)
    const load = (async () => {
      try {
        const upstream = await window.solus.tasksListUpstream(projectKey, opts)
        this.upstreamTasksByProject.set(projectKey, upstream.tasks)
        if (upstream.fromCache) this.upstreamFromCacheByProject.set(projectKey, true)
        else this.upstreamFromCacheByProject.delete(projectKey)
        if (upstream.fetchedAt !== undefined) {
          this.upstreamRefreshedAtByProject.set(projectKey, upstream.fetchedAt)
        } else if (!upstream.fromCache && upstream.tasks.length > 0) {
          this.upstreamRefreshedAtByProject.set(projectKey, Date.now())
        }
        if (upstream.truncated) this.upstreamTruncatedByProject.set(projectKey, true)
        else this.upstreamTruncatedByProject.delete(projectKey)
      } catch (error) {
        this.upstreamErrorByProject.set(
          projectKey,
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        this.upstreamLoadingByProject.delete(projectKey)
        this.upstreamLoadsByProject.delete(projectKey)
      }
    })()
    this.upstreamLoadsByProject.set(projectKey, load)
    return load
  }

  private replaceLinks(links: Record<string, TaskSessionLink[]>): void {
    this.sessionsByTask.clear()
    this.taskIdBySessionId.clear()
    for (const [taskId, list] of Object.entries(links)) {
      this.sessionsByTask.set(taskId, list)
      for (const link of list) this.taskIdBySessionId.set(link.sessionId, taskId)
    }
  }

  /** Expose the binding on the session-init frame while the authoritative
   * task-session read is still in flight. The host has already persisted this
   * association; the optimistic entry lets every task surface show live work
   * immediately and is replaced by the next authoritative sidebar snapshot.
   *
   * The display fields are genuinely unknown here rather than merely omitted:
   * the session has not reached the index yet, and a just-started session is
   * always mounted, so every surface names it from its live tab regardless. */
  trackSessionStart(taskId: string, sessionId: string): void {
    this.taskIdBySessionId.set(sessionId, taskId)
    const attempts = this.sessionsByTask.get(taskId) ?? []
    if (attempts.some((attempt) => attempt.sessionId === sessionId)) return
    this.sessionsByTask.set(taskId, [
      ...attempts,
      {
        taskId,
        sessionId,
        sessionTitle: null,
        provider: null,
        lastActivityAt: null,
        linkedAt: Date.now(),
      },
    ])
  }

  /** Hydrate the complete lightweight tree for an opened session even when the
   * global snapshot already knows its owner. The targeted read carries sibling
   * subtasks and every linked session's display metadata; none of it requires a
   * transcript. Fall back to a fresh global snapshot only when that focused
   * read cannot resolve a newly-created link. */
  async ensureSessionBinding(sessionId: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    const existing = this.taskForSession(sessionId)
    const hydrated = await this.hydrateSessionTree(sessionId)
    if (hydrated) return hydrated
    if (existing) return existing
    await this.load()
    return this.taskForSession(sessionId)
  }

  /** The two-level tree a session belongs to — its task, that task's parent,
   * and every subtask under the root, each by name. The global snapshot
   * carries all of them whenever it succeeds; this is the read that still
   * answers when it did not, so a session restored from disk never renders as
   * a loose row beside a parent whose subtasks are missing. */
  private async hydrateSessionTree(sessionId: string): Promise<Task | null> {
    const tree = await window.solus.tasksForSession(sessionId).catch(() => null)
    if (!tree) return null
    for (const task of [tree.parent, tree.task, ...tree.subtasks, ...tree.siblings]) {
      if (task) this.replace(task.id, task)
    }
    this.taskIdBySessionId.set(sessionId, tree.task.id)
    for (const attempt of tree.attempts) {
      const taskId = attempt.taskId ?? tree.task.id
      const attempts = this.sessionsByTask.get(taskId)
      if (!attempts) this.sessionsByTask.set(taskId, [attempt])
      else {
        // Overwrite rather than skip: the entry already there may be the
        // optimistic one from `trackSessionStart`, which carries no display
        // metadata. This read is authoritative, so it upgrades in place.
        const index = attempts.findIndex((existing) => existing.sessionId === attempt.sessionId)
        if (index === -1) attempts.push(attempt)
        else attempts[index] = attempt
      }
      this.taskIdBySessionId.set(attempt.sessionId, taskId)
    }
    return tree.task
  }

  /** Guarantee that a snapshot starts after any cold load already in flight.
   * New session links use this after their optimistic same-frame projection. */
  async refreshSessionBinding(sessionId: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    await this.load()
    return this.taskForSession(sessionId)
  }

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    const task = this.taskById(id)
    const previous = task?.status
    if (task) task.status = status
    try {
      const updated = task && task.providerId !== 'local'
        ? await window.solus.tasksUpdateUpstream(this.upstreamCwd(task), id, { status })
        : await window.solus.tasksUpdate(id, { status })
      this.replace(id, updated)
    } catch (err) {
      if (task && previous) task.status = previous
      throw err
    }
  }

  async update(id: string, patch: TaskUpdatePatch): Promise<Task> {
    const task = this.taskById(id)
    const updated = task && task.providerId !== 'local'
      ? await window.solus.tasksUpdateUpstream(this.upstreamCwd(task), id, patch)
      : await window.solus.tasksUpdate(id, patch)
    this.replace(id, updated)
    return updated
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const created = await window.solus.tasksCreate(input)
    this.replace(created.id, created)
    return created
  }

  async comment(id: string, body: string): Promise<Task> {
    const task = this.taskById(id)
    if (task && task.providerId !== 'local') {
      const cwd = this.upstreamCwd(task)
      const updated = await window.solus.tasksCommentUpstream(cwd, id, body)
      this.replace(id, updated)
      this.detailsByTask.set(id, upstreamTaskDetails(updated, this.tasksForProject(cwd)))
      return updated
    }
    const details = await window.solus.tasksComment(id, body)
    this.reconcileDetails(details)
    return details.task
  }

  /** Attach a doc, plan, PR or automation to a task. */
  async link(id: string, input: TaskLinkInput): Promise<TaskDetails> {
    const details = await window.solus.tasksLink(id, input)
    this.reconcileDetails(details)
    return details
  }

  async unlink(id: string, kind: TaskLinkKind, targetKey: string, targetScope = ''): Promise<TaskDetails> {
    const details = await window.solus.tasksUnlink(id, kind, targetKey, targetScope)
    this.reconcileDetails(details)
    return details
  }

  /** The detail read behind the task page: comments, links and activity, none
   * of which the flat `tasks` list carries. */
  async loadDetails(id: string, projectKey?: string): Promise<TaskDetails> {
    const task = this.taskById(id, projectKey)
    if (task ? task.providerId !== 'local' : await this.isUpstreamId(id, projectKey)) {
      const cwd = task?.projectKey ?? projectKey
      if (!cwd) throw new Error(`Project not found for upstream task ${id}.`)
      const updated = await window.solus.tasksGetUpstream(cwd, id)
      this.replace(id, updated)
      const details = upstreamTaskDetails(updated, this.tasksForProject(cwd))
      this.detailsByTask.set(id, details)
      return details
    }
    const details = await window.solus.tasksGet(id)
    this.reconcileDetails(details)
    return details
  }

  /** A directly opened task the store has never listed: an issue-number id in a
   * project with an upstream provider is an upstream ticket (local ids are
   * ULIDs), so a deep link hydrates instead of reading as a missing local task. */
  private async isUpstreamId(id: string, projectKey?: string): Promise<boolean> {
    if (!projectKey || !/^\d+$/.test(id)) return false
    const status = this.providerStatusByCwd.get(projectKey) ?? await this.loadProviderStatus(projectKey)
    return status.provider !== 'local'
  }

  detailsFor(id: string | null | undefined): TaskDetails | null {
    return id ? (this.detailsByTask.get(id) ?? null) : null
  }

  /** Upstream tasks are always stamped with their project by the host; that
   * project is the cwd the `tasks*Upstream` RPCs key their provider on. */
  private upstreamCwd(task: Task): string {
    if (!task.projectKey) throw new Error(`Project not found for ${task.providerId} task ${task.id}.`)
    return task.projectKey
  }

  /** Tasks and their detail payload only. Session links are not part of a
   * detail read — `sessionsByTask` is written by the snapshot and the focused
   * session-tree read, and nothing else, so no surface can narrow it by opening. */
  private reconcileDetails(details: TaskDetails): void {
    this.replace(details.task.id, details.task)
    for (const subtask of details.subtasks) this.replace(subtask.id, subtask)
    this.detailsByTask.set(details.task.id, details)
  }

  private replace(id: string, updated: Task): void {
    if (updated.providerId !== 'local' && updated.projectKey) {
      const upstream = this.upstreamTasksByProject.get(updated.projectKey)
      const index = upstream?.findIndex((task) => task.id === id) ?? -1
      if (!upstream) this.upstreamTasksByProject.set(updated.projectKey, [updated])
      else if (index === -1) upstream.push(updated)
      else upstream[index] = updated
      return
    }
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index === -1) this.tasks.push(updated)
    else this.tasks[index] = updated
  }

  private taskById(id: string, projectKey?: string): Task | undefined {
    const local = this.tasks.find((task) => task.id === id)
    if (local) return local
    if (projectKey) return this.upstreamTasksByProject.get(projectKey)?.find((task) => task.id === id)
    return Array.from(this.upstreamTasksByProject.values()).flat().find((task) => task.id === id)
  }

  private pendingDelete: Task[] = []

  softRemove(ids: string[]): boolean {
    const taskIds = new Set(ids)
    const removed = this.tasks.filter((task) => taskIds.has(task.id))
    if (!removed.length) return false
    this.pendingDelete = removed
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      if (taskIds.has(this.tasks[index].id)) this.tasks.splice(index, 1)
    }
    return true
  }

  restorePending(): void {
    if (!this.pendingDelete.length) return
    this.tasks.push(...this.pendingDelete)
    this.tasks.sort((a, b) => b.updatedAt - a.updatedAt)
    this.pendingDelete = []
  }

  async commitPending(): Promise<void> {
    const pending = this.pendingDelete
    this.pendingDelete = []
    const results = await Promise.allSettled(pending.map((task) => window.solus.tasksDelete(task.id)))
    const failed = pending.filter((_, index) => results[index].status === 'rejected')
    if (failed.length) {
      this.tasks.push(...failed)
      this.tasks.sort((a, b) => b.updatedAt - a.updatedAt)
      const first = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      throw first?.reason ?? new Error('Delete failed')
    }
  }
}
