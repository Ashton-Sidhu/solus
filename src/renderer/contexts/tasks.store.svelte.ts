import { SvelteMap } from 'svelte/reactivity'
import type { Task, TaskStatus, TaskKind, TaskSessionLink, TaskPr, TaskPriority } from '../../shared/task-types'

// Renderer-side cache + RPC wrapper for tasks. Mirrors AutomationsStore, but
// scoped to a single project cwd at a time: a task provider is bound to one
// repo, so switching the active project reloads the list. The main process owns
// the disposable provider cache; this is purely the in-flight UI view.
export class TasksStore {
  tasks = $state<Task[]>([])
  loading = $state(false)
  loaded = $state(false)
  /** Set when the last load failed (e.g. GitHub offline / not connected). */
  error = $state<string | null>(null)
  /** The cwd the current `tasks` belong to, so a stale project never renders. */
  cwd = $state<string | null>(null)
  /** Epoch ms of the last successful load — drives the "updated Xm ago" hint so
   *  the user can judge how fresh the list is (the provider may be cached). */
  refreshedAt = $state<number | null>(null)
  /** task id → sessions started from it. Persisted in a local sidecar so the
   *  back-link survives reloads even though a session's `boundTaskId` doesn't. */
  sessionsByTask = new SvelteMap<string, TaskSessionLink[]>()

  async load(cwd: string, opts: { assignedToMe?: boolean } = {}): Promise<void> {
    this.cwd = cwd
    this.loading = true
    this.error = null
    try {
      const list = await window.solus.tasksList(cwd, opts)
      // Guard against a slower earlier load resolving after a project switch.
      if (this.cwd !== cwd) return
      this.tasks = list
      this.loaded = true
      this.refreshedAt = Date.now()
      void this.loadLinks(cwd)
    } catch (err) {
      if (this.cwd !== cwd) return
      this.error = err instanceof Error ? err.message : String(err)
      this.tasks = []
      this.loaded = true
    } finally {
      if (this.cwd === cwd) this.loading = false
    }
  }

  /** Pull the task→session links for a project so cards can show "has an active
   *  session" and offer a jump-back. Best-effort — a missing sidecar is normal. */
  async loadLinks(cwd: string): Promise<void> {
    try {
      const links = await window.solus.tasksSessions(cwd)
      if (this.cwd !== cwd) return
      this.sessionsByTask.clear()
      for (const [taskId, list] of Object.entries(links)) this.sessionsByTask.set(taskId, list)
    } catch {
      // Non-fatal: the list just renders without back-links.
    }
  }

  /** Record a session as started-from a task — optimistic local update plus the
   *  durable sidecar write. Called from the session reducer on session_init. */
  linkSession(cwd: string, taskId: string, sessionId: string): void {
    const list = this.sessionsByTask.get(taskId) ?? []
    if (!list.some((l) => l.sessionId === sessionId)) {
      this.sessionsByTask.set(taskId, [...list, { sessionId, linkedAt: Date.now() }])
    }
    void window.solus.tasksLinkSession(cwd, taskId, sessionId)
  }

  /** Narrow status write-back (label/close on GitHub, field on local). Moves the
   *  card optimistically — flip `status` in place so the board re-buckets it
   *  instantly — then reconcile with the provider's post-write truth, or roll the
   *  status back and rethrow so the caller can surface the failure. */
  async setStatus(cwd: string, id: string, status: TaskStatus): Promise<void> {
    const task = this.tasks.find((t) => t.id === id)
    const prev = task?.status
    if (task) task.status = status
    try {
      const updated = await window.solus.tasksUpdate(cwd, id, { status })
      this.replace(id, updated)
    } catch (err) {
      if (task && prev) task.status = prev
      throw err
    }
  }

  /** Edit task fields. Local accepts every field; GitHub maps title/body/labels/
   *  assignee/status to native issue fields and ignores the rest. Throws so the
   *  caller can surface a toast and keep the draft. */
  async update(cwd: string, id: string, patch: Partial<Task>): Promise<Task> {
    const updated = await window.solus.tasksUpdate(cwd, id, patch)
    this.replace(id, updated)
    return updated
  }

  private replace(id: string, updated: Task): void {
    const i = this.tasks.findIndex((t) => t.id === id)
    if (i === -1) this.tasks.unshift(updated)
    else this.tasks[i] = updated
  }

  /** Create a task. The provider already returns the hydrated source-of-truth row,
   *  so only the assignee-scoped view needs a reload to preserve its server filter. */
  async create(
    cwd: string,
    input: {
      title: string
      body?: string
      kind?: TaskKind
      parentId?: string
      dueDate?: string
      priority?: TaskPriority
      status?: TaskStatus
      labels?: string[]
      branch?: string
      pr?: TaskPr
    },
    opts: { assignedToMe?: boolean } = {},
  ): Promise<Task> {
    const created = await window.solus.tasksCreate(cwd, input)
    if (opts.assignedToMe) await this.load(cwd, opts)
    else this.replace(created.id, created)
    return created
  }

  /** Post a comment (GitHub issue comment / local note) and swap in the
   *  re-hydrated task so the new comment shows. Throws so the composer keeps the
   *  draft + surfaces a toast on failure. */
  async comment(cwd: string, id: string, body: string): Promise<Task> {
    const updated = await window.solus.tasksComment(cwd, id, body)
    this.replace(id, updated)
    return updated
  }

  // ── Deferred delete (undo-toast pattern, mirrors AutomationsStore) ──
  // Soft-remove hides rows immediately and stashes them; the on-disk delete is
  // deferred until the toast commits, so Undo is a pure in-memory restore.
  private pendingDelete: Task[] = []

  /** Hide the given tasks and stash them for a possible undo. Returns whether
   *  anything was removed (so the caller only shows a toast when it was). */
  softRemove(ids: string[]): boolean {
    const set = new Set(ids)
    const removed = this.tasks.filter((t) => set.has(t.id))
    if (!removed.length) return false
    this.pendingDelete = removed
    this.tasks = this.tasks.filter((t) => !set.has(t.id))
    return true
  }

  /** Undo: put the stashed rows back (nothing was deleted on disk yet). */
  restorePending(): void {
    if (!this.pendingDelete.length) return
    this.tasks.push(...this.pendingDelete)
    this.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    this.pendingDelete = []
  }

  /** Commit: actually delete the stashed rows through the provider. */
  async commitPending(cwd: string): Promise<void> {
    const pending = this.pendingDelete
    this.pendingDelete = []
    await Promise.all(pending.map((t) => window.solus.tasksDelete(cwd, t.id)))
  }
}
