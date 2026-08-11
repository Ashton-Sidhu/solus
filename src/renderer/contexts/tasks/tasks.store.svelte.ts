import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@client-core/server-connections'
import type {
  PrepareSessionTaskResult,
  SessionExecutionHost,
  Task,
  TaskCreateInput,
  TaskDetails,
  TaskLinkInput,
  TaskLinkKind,
  TaskProviderStatus,
  TaskSessionLink,
  TaskSidebarSnapshot,
  TaskSidebarPrLink,
  TaskSnapshot,
  TaskSnoozeInput,
  TaskStatus,
  TaskUpdatePatch,
} from '../../../shared/task-types'
import { upstreamTaskDetails } from './upstream-task-details'
import { resolveTaskSnoozeReminder, type TaskSnoozeReminder } from './task-snooze'
import type { HostApi } from '@client-core/host-api'

const INVALIDATION_DEBOUNCE_MS = 100

/**
 * Global, local-first task state shared by every renderer surface. Local tasks
 * live in `tasks`; upstream tickets (GitHub issues) are kept per-project in
 * `upstreamTasksByProject` and routed to the `tasks*Upstream` RPCs by their
 * `providerId`.
 *
 * Tasks are host-scoped: each host keeps its own store, and a project's tasks
 * live on the host that project was opened from. This store merges every
 * connected host's snapshot into one list and remembers which host each task
 * came from, so every later read and write goes back to the host that owns it.
 * Ids stay bare strings throughout — they are ULIDs, unique across hosts — which
 * is what keeps routes, deep links and agent tools unaware that hosts exist.
 */
export class TasksStore {
  tasks = $state<Task[]>([])
  loading = $state(false)
  loaded = $state(false)
  error = $state<string | null>(null)
  refreshedAt = $state<number | null>(null)
  lifecycleNow = $state(Date.now())

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
  private prLinkByTask = new SvelteMap<string, TaskSidebarPrLink>()
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
  /** Which host each known task lives on. Every write is routed by this. */
  private hostByTaskId = new SvelteMap<string, string>()
  private loadPromise: Promise<void> | null = null
  private providerStatusLoadsByCwd = new Map<string, Promise<TaskProviderStatus>>()
  private upstreamLoadsByProject = new Map<string, Promise<void>>()
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null
  private subscribedServerIds = new Set<string>()

  constructor() {
    $effect(() => {
      const now = this.lifecycleNow
      const nextWake = this.tasks.reduce((next, task) => {
        const until = task.snoozedUntil ?? 0
        return until > now && (next === 0 || until < next) ? until : next
      }, 0)
      if (!nextWake) return
      const timeout = window.setTimeout(() => {
        this.lifecycleNow = Date.now()
      }, Math.max(1, nextWake - Date.now()))
      return () => window.clearTimeout(timeout)
    })
    for (const serverId of serverConnections.connectedServerIds()) {
      this.watchHost(serverId)
    }
    // A host connected later — dispatching to it, or opening a project on it —
    // owns tasks this store has never read. Without this, its work is invisible
    // until something else forces a reload.
    serverConnections.onConnectionCreated((connection) => {
      if (this.subscribedServerIds.has(connection.serverId)) return
      this.watchHost(connection.serverId)
      void this.load()
    })
    queueMicrotask(() => void this.ensureLoaded())
  }

  /** Each host announces its own invalidations, so each is subscribed once. */
  private watchHost(serverId: string): void {
    this.subscribedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('tasks.invalidated', () => {
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
  }

  /**
   * The RPC surface that owns a task. A task the store has not placed yet — a
   * deep link, or an id typed into a tool — falls back to the primary host,
   * which is where a single-host user's tasks all are anyway.
   */
  private apiForTask(taskId?: string | null): HostApi {
    const serverId = taskId ? this.hostByTaskId.get(taskId) : undefined
    return serverId ? serverConnections.apiFor(serverId) : serverConnections.primaryApi()
  }

  /** Which host a task lives on, for a caller that has to name it explicitly. */
  hostFor(taskId: string | null | undefined): string | null {
    return taskId ? this.hostByTaskId.get(taskId) ?? null : null
  }

  /**
   * Resolve a task's owner host for the outbox courier, trying harder than
   * `hostFor`: an op can name a task this client has never listed (recorded by
   * an agent on a borrowed machine), so an unplaced id is asked of every
   * connected host before giving up. Undefined means "no connected host owns
   * it" — the op stays pending, which is a reported state, not a failure.
   */
  async ownerHostForTask(taskId: string): Promise<string | undefined> {
    const placed = this.hostByTaskId.get(taskId)
    if (placed) return placed
    await this.ensureLoaded()
    const listed = this.hostByTaskId.get(taskId)
    if (listed) return listed
    for (const serverId of serverConnections.connectedServerIds()) {
      try {
        const details = await serverConnections.apiFor(serverId).tasksGet(taskId)
        if (details?.task) {
          this.hostByTaskId.set(taskId, serverId)
          return serverId
        }
      } catch {
        // Not this host's task.
      }
    }
    return undefined
  }

  /**
   * Which host a project's tasks live on, inferred from the tasks already filed
   * against it. A project this store has never seen a task for returns null, and
   * the caller falls back to the primary host — correct for the single-host case
   * and for a project whose first task is being created right here.
   *
   * This spares every task surface from threading a host id it would only be
   * re-deriving from the same place.
   */
  hostForProject(projectKey: string | null | undefined): string | null {
    if (!projectKey) return null
    for (const task of this.tasks) {
      if (task.projectKey !== projectKey) continue
      const serverId = this.hostByTaskId.get(task.id)
      if (serverId) return serverId
    }
    return null
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

  /** The durable linked PR wins. The captured task field keeps older hosts and
   * migrated tasks working until their next explicit link write. */
  prLinkFor(taskId: string | null | undefined): TaskSidebarPrLink | null {
    if (!taskId) return null
    const linked = this.prLinkByTask.get(taskId)
    if (linked) return linked
    const captured = this.taskById(taskId)?.pr
    return captured ? { number: captured.number, url: captured.url } : null
  }

  taskForSession(sessionId: string | null | undefined): Task | null {
    if (!sessionId) return null
    const taskId = this.taskIdBySessionId.get(sessionId)
    return taskId ? (this.tasks.find((task) => task.id === taskId) ?? null) : null
  }

  snoozeReminderForSession(sessionId: string | null | undefined): TaskSnoozeReminder | null {
    return resolveTaskSnoozeReminder(this.taskForSession(sessionId), this.lifecycleNow)
  }

  sessionBranchFor(taskId: string, sessionId: string): string | null {
    return this.sessionsByTask.get(taskId)?.find((link) => link.sessionId === sessionId)?.branch ?? null
  }

  providerStatus(cwd: string | null | undefined): TaskProviderStatus | null {
    return cwd ? (this.providerStatusByCwd.get(cwd) ?? null) : null
  }

  /** `serverId` names the host that holds `cwd`; a path is meaningless on any
   *  other machine, so a remote project's status must be read from its own. */
  loadProviderStatus(
    cwd: string,
    opts?: { checkAccess?: boolean; serverId?: string },
  ): Promise<TaskProviderStatus> {
    const pending = this.providerStatusLoadsByCwd.get(cwd)
    if (pending) return pending
    const load = (async () => {
      try {
        const serverId = opts?.serverId ?? this.hostForProject(cwd)
        const api = serverId ? serverConnections.apiFor(serverId) : serverConnections.primaryApi()
        const status = await api.tasksProviderStatus(cwd, opts)
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
        // One snapshot per connected host, merged. A host that fails is reported
        // rather than emptying the list: losing one machine's tasks must not read
        // as "the sidebar lost my tasks" for every other machine.
        const serverIds = serverConnections.connectedServerIds()
        const snapshots = await Promise.all(
          serverIds.map(async (serverId) => {
            try {
              return { serverId, snapshot: await serverConnections.apiFor(serverId).tasksSidebarSnapshot() }
            } catch (err) {
              console.error('tasks sidebar snapshot load failed', serverId, err)
              return { serverId, error: err }
            }
          }),
        )
        const failed = snapshots.filter((entry) => 'error' in entry)
        const ok = snapshots.filter((entry) => 'snapshot' in entry)
        this.hostByTaskId.clear()
        this.prLinkByTask.clear()
        const merged: Task[] = []
        const links: Record<string, TaskSessionLink[]> = {}
        for (const { serverId, snapshot } of ok as Array<{ serverId: string; snapshot: TaskSidebarSnapshot }>) {
          for (const task of snapshot.tasks) {
            this.hostByTaskId.set(task.id, serverId)
            merged.push(task)
          }
          for (const [taskId, list] of Object.entries(snapshot.sessionsByTask)) {
            links[taskId] = list as TaskSessionLink[]
          }
          for (const [taskId, pr] of Object.entries(snapshot.prLinksByTask ?? {})) {
            this.prLinkByTask.set(taskId, pr)
          }
        }
        this.tasks.splice(0, this.tasks.length, ...merged)
        this.replaceLinks(links)
        this.loaded = true
        this.refreshedAt = Date.now()
        this.error = failed.length
          ? `Couldn't read tasks from ${failed.length} host${failed.length === 1 ? '' : 's'}.`
          : null
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
  async loadUpstream(
    projectKey: string,
    opts?: { refresh?: boolean; serverId?: string },
  ): Promise<void> {
    const pending = this.upstreamLoadsByProject.get(projectKey)
    if (pending) return pending

    this.upstreamLoadingByProject.set(projectKey, true)
    this.upstreamErrorByProject.delete(projectKey)
    const load = (async () => {
      try {
        const serverId = opts?.serverId ?? this.hostForProject(projectKey)
        const api = serverId ? serverConnections.apiFor(serverId) : serverConnections.primaryApi()
        const upstream = await api.tasksListUpstream(projectKey, opts)
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
  async ensureSessionBinding(sessionId: string, serverId?: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    const existing = this.taskForSession(sessionId)
    const hydrated = await this.hydrateSessionTree(sessionId, serverId)
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
  private async hydrateSessionTree(sessionId: string, serverId?: string): Promise<Task | null> {
    const api = serverId ? serverConnections.apiFor(serverId) : serverConnections.primaryApi()
    const tree = await api.tasksForSession(sessionId).catch(() => null)
    if (!tree) return null
    for (const task of [tree.parent, tree.task, ...tree.subtasks, ...tree.siblings]) {
      if (!task) continue
      if (serverId) this.hostByTaskId.set(task.id, serverId)
      this.replace(task.id, task)
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
  async refreshSessionBinding(sessionId: string, serverId?: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    await this.load()
    const bound = this.taskForSession(sessionId)
    if (bound || !serverId) return bound
    // The global snapshot raced the link the task host has just written. Ask
    // that host directly rather than leaving the session projected as loose.
    return this.hydrateSessionTree(sessionId, serverId)
  }

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    const task = this.taskById(id)
    const previous = task?.status
    if (task) task.status = status
    try {
      const updated = task && task.providerId !== 'local'
        ? await this.apiForTask(id).tasksUpdateUpstream(this.upstreamCwd(task), id, { status })
        : await this.apiForTask(id).tasksUpdate(id, { status })
      this.replace(id, updated)
    } catch (err) {
      if (task && previous) task.status = previous
      throw err
    }
  }

  async update(id: string, patch: TaskUpdatePatch): Promise<Task> {
    const task = this.taskById(id)
    const updated = task && task.providerId !== 'local'
      ? await this.apiForTask(id).tasksUpdateUpstream(this.upstreamCwd(task), id, patch)
      : await this.apiForTask(id).tasksUpdate(id, patch)
    this.replace(id, updated)
    return updated
  }

  async snooze(id: string, input: TaskSnoozeInput): Promise<Task> {
    const updated = await this.apiForTask(id).tasksSnooze(id, input)
    this.replace(id, updated)
    return updated
  }

  async markRead(id: string, read: boolean): Promise<Task> {
    const updated = await this.apiForTask(id).tasksMarkRead(id, read)
    this.replace(id, updated)
    return updated
  }

  async recordActivity(id: string): Promise<Task> {
    const updated = await this.apiForTask(id).tasksRecordActivity(id)
    this.replace(id, updated)
    return updated
  }

  /** `serverId` is the host the task belongs to — the one that owns the project
   *  it was created from. Omitted, it lands on the primary host. */
  async create(input: TaskCreateInput, serverId?: string): Promise<Task> {
    const host = serverId ?? this.hostForProject(input.projectKey)
    const api = host ? serverConnections.apiFor(host) : serverConnections.primaryApi()
    const created = await api.tasksCreate(input)
    if (host) this.hostByTaskId.set(created.id, host)
    this.replace(created.id, created)
    return created
  }

  /**
   * Mint (or bind) the task a session is about to start under, on the host that
   * owns its project.
   *
   * This is the first-dispatch boundary, moved out of whichever host happens to
   * run the agent. A dispatched session runs on one machine and files here, so
   * the mint cannot be a side effect of the prompt landing — the client has to
   * name the host, and it is the only party that knows both.
   *
   * Returns null when the host declined to mint (a resumed provider session), in
   * which case the caller sends no task id and nothing is bound.
   */
  async prepareForSession(
    serverId: string,
    input: { existingTaskId?: string | null; parentTaskId?: string | null; projectKey?: string | null; worktreeKey?: string | null; prompt?: string; branch?: string | null; includeSnapshot?: boolean },
  ): Promise<PrepareSessionTaskResult> {
    const result = await serverConnections.apiFor(serverId).tasksPrepareForSession(input)
    if (!result.task) return result
    this.hostByTaskId.set(result.task.id, serverId)
    this.replace(result.task.id, result.task)
    return result
  }

  /** The live task state a dispatched prompt ships to its execution host. Read
   *  from the named task host — not `apiForTask` — because a snapshot for a
   *  session's own task must come from where that session files it. */
  async snapshotForDispatch(serverId: string, taskId: string): Promise<TaskSnapshot | null> {
    return serverConnections.apiFor(serverId).tasksSnapshot(taskId)
  }

  async comment(id: string, body: string): Promise<Task> {
    const task = this.taskById(id)
    if (task && task.providerId !== 'local') {
      const cwd = this.upstreamCwd(task)
      const updated = await this.apiForTask(id).tasksCommentUpstream(cwd, id, body)
      this.replace(id, updated)
      this.detailsByTask.set(id, upstreamTaskDetails(updated, this.tasksForProject(cwd)))
      return updated
    }
    const details = await this.apiForTask(id).tasksComment(id, body)
    this.reconcileDetails(details)
    return details.task
  }

  /**
   * Bind a started session to its task, on the host that owns that task.
   *
   * Split out from the mint because the two happen at different moments and, for
   * a dispatch, involve different machines: the task is minted here before the
   * prompt leaves, and the session id only exists once the *execution* host has
   * started the agent and echoed `session_init` back.
   *
   * That second machine is also the only thing neither host can work out for
   * itself, so the client states it here and the task's host records a session
   * row for it. `execution` is null for a run that stayed on the task's host —
   * the two ids being equal is the definition of "not a dispatch", and a host
   * id is only meaningful next to a different one.
   */
  async linkSession(
    serverId: string,
    taskId: string,
    sessionId: string,
    execution: SessionExecutionHost | null,
    branch: string | null,
  ): Promise<void> {
    await serverConnections
      .apiFor(serverId)
      .tasksLinkSession(taskId, sessionId, 'working', execution, branch)
  }

  /** Attach a doc, plan, PR or automation to a task. */
  async link(id: string, input: TaskLinkInput): Promise<TaskDetails> {
    const details = await this.apiForTask(id).tasksLink(id, input)
    this.reconcileDetails(details)
    return details
  }

  async unlink(id: string, kind: TaskLinkKind, targetKey: string, targetScope = ''): Promise<TaskDetails> {
    const details = await this.apiForTask(id).tasksUnlink(id, kind, targetKey, targetScope)
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
      const updated = await this.apiForTask(id).tasksGetUpstream(cwd, id)
      this.replace(id, updated)
      const details = upstreamTaskDetails(updated, this.tasksForProject(cwd))
      this.detailsByTask.set(id, details)
      return details
    }
    const details = await this.apiForTask(id).tasksGet(id)
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
    const pr = details.links.find((link) => link.kind === 'pr' && Number.isSafeInteger(Number(link.targetKey)))
    if (pr) {
      this.prLinkByTask.set(details.task.id, {
        number: Number(pr.targetKey),
        ...(pr.url ? { url: pr.url } : {}),
      })
    } else {
      this.prLinkByTask.delete(details.task.id)
    }
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
    const results = await Promise.allSettled(pending.map((task) => this.apiForTask(task.id).tasksDelete(task.id)))
    const failed = pending.filter((_, index) => results[index].status === 'rejected')
    if (failed.length) {
      this.tasks.push(...failed)
      this.tasks.sort((a, b) => b.updatedAt - a.updatedAt)
      const first = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      throw first?.reason ?? new Error('Delete failed')
    }
  }
}
