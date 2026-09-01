import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type {
  PrepareSessionTaskResult,
  Task as TaskRecord,
  TaskCreateInput,
  TaskForSessionResult,
  TaskLinkTarget,
  TaskLinkedTask,
  TaskProviderStatus,
  TaskSessionLink,
  TaskSidebarSnapshot,
  TaskSidebarPrLink,
} from '@solus/contracts/task-types'
import { Task } from './task.svelte'

const INVALIDATION_DEBOUNCE_MS = 100
const UPSTREAM_SEARCH_DEBOUNCE_MS = 350
const TASK_DELETE_CONCURRENCY = 8

/** The one spelling of a link target's identity, shared by the reverse-lookup
 *  cache and every card that reads it. */
export function linkTargetKey(target: TaskLinkTarget): string {
  return `${target.kind}:${target.targetScope}:${target.targetKey}`
}

/** The inverse, for re-reading a cached key. A scope may hold a colon (a
 *  repository path never does; a session id never does either), so the split
 *  takes the first and last separators and leaves the middle whole. */
function splitLinkTargetKey(key: string): [TaskLinkTarget['kind'], string, string] {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  // SAFETY: keys are only ever minted by `linkTargetKey` from a `TaskLinkKind`.
  const kind = key.slice(0, first) as TaskLinkTarget['kind']
  return [kind, key.slice(first + 1, last), key.slice(last + 1)]
}

/**
 * Every task this client knows anything about, and how far each read has got.
 *
 * Tasks are host-scoped: each host keeps its own store, and a project's tasks
 * live on the host that project was opened from. This store merges every
 * connected host's snapshot into one list and remembers which host each task
 * came from, so every later read and write goes back to the host that owns it.
 * Ids stay bare strings throughout — they are ULIDs, unique across hosts — which
 * is what keeps routes, deep links and agent tools unaware that hosts exist.
 *
 * Nothing here is about one task. What is known about a task, and everything
 * that can be done to it, lives on `Task` and is reached through `get(id)`.
 *
 * What is left is the collection, and it is left here for one of three reasons.
 * It is about **which tasks exist** (`load`, the groupings, the Undo batch). It
 * is about a **project** rather than a task (the upstream list, provider
 * status). Or it is about a **session**, answering "which task owns this one"
 * (`taskForSession`, the binding reads) — the reverse direction is a task's own
 * `sessions`. `create` and `prepareForSession` sit here because a task that does
 * not exist yet cannot be a method on one.
 *
 * A row becoming a task is `get(id).hydrate(record)`: this store finds the one
 * `Task` for that id, and the task takes the row and files itself.
 */
export class TasksStore {
  loading = $state(false)
  loaded = $state(false)
  error = $state<string | null>(null)
  refreshedAt = $state<number | null>(null)

  /**
   * One `Task` per id — the same object every time, so what one surface writes
   * is what another reads.
   *
   * A plain `Map`, deliberately. `get` mints a missing entity, and render paths
   * legitimately call it (`$derived(store.get(taskId))`); a `SvelteMap`
   * would make that a state write during derivation. Membership is the reactive
   * part and is tracked by `tasks` and `upstreamTasksByProject` instead, which
   * is also the honest split: this index is identity, those are "what exists".
   */
  private readonly byId = new Map<string, Task>()

  /** The durable tasks the last snapshot listed, in its order. Membership only —
   *  each element is the one `Task` for its id, so a field written through it
   *  redraws the rows reading that field without this list being rebuilt. */
  tasks = $state<Task[]>([])

  /** Provider-owned tickets per project. Live rows answering a provider query,
   *  never persisted. */
  upstreamTasksByProject = new SvelteMap<string, Task[]>()

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

  // --- Per-project provider state -----------------------------------------
  // Facts about a project, not about any one task, so they stay here.

  providerStatusByCwd = new SvelteMap<string, TaskProviderStatus>()
  upstreamErrorByProject = new SvelteMap<string, string>()
  upstreamFromCacheByProject = new SvelteMap<string, boolean>()
  upstreamRefreshedAtByProject = new SvelteMap<string, number>()
  upstreamTruncatedByProject = new SvelteMap<string, boolean>()
  upstreamLoadingByProject = new SvelteMap<string, boolean>()
  /** The provider search the loaded rows answer, empty for the plain list. Read
   * by the page so it can say the rows are a search result, and by every later
   * reload so a refresh does not silently drop the search. */
  upstreamQueryByProject = new SvelteMap<string, string>()
  private upstreamSearchTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Which task a session belongs to — what `taskForSession` answers from.
   *
   * Written by `Task.bindSession`, which is the task claiming the session; the
   * reverse direction, a task's own attempt rows, is `get(taskId).sessions`.
   * `Task` and this store are one unit split across two files for size, so this
   * index is shared between them rather than private to either.
   */
  taskIdBySessionId = new SvelteMap<string, string>()
  /**
   * Which tasks link each target, keyed by `linkTargetKey` — what a
   * conversation card reads to say "Linked to T-184" beside the document it
   * rendered. A target with no entry has not been read yet; one with an empty
   * list is known to be unlinked. Written by `ensureLinkedTasks`, corrected
   * in place by `Task.link`/`unlink`, and re-read whenever a host announces
   * a task change.
   */
  linkedTasksByTarget = new SvelteMap<string, TaskLinkedTask[]>()
  /** The host each cached target was read from, so a refresh asks the same one. */
  private hostByLinkTargetKey = new Map<string, string>()
  private linkedTargetLoads = new Map<string, Promise<void>>()
  /** Reject an older reverse-link read after a newer read or a local write has
   *  already changed the same target. Without this guard, an unlink can briefly
   *  restore the stale "Linked to…" label while the next invalidation catches up. */
  private linkedTargetGenerations = new Map<string, number>()
  /** Provider-owned issue ids are only unique inside a project. Route their
   * writes by project instead of teaching a bare issue number one host. */
  private hostByProjectKey = new SvelteMap<string, string>()
  private loadPromise: Promise<void> | null = null
  private providerStatusLoadsByCwd = new Map<string, Promise<TaskProviderStatus>>()
  private upstreamLoadsByProject = new Map<string, Promise<void>>()
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null
  private subscribedServerIds = new Set<string>()
  /** Changes whenever the set of hosts included in a sidebar snapshot changes. */
  private hostGeneration = 0

  constructor() {
    for (const serverId of serverConnections.connectedServerIds()) {
      this.watchHost(serverId)
    }
    // A host connected later — dispatching to it, or opening a project on it —
    // owns tasks this store has never read. Without this, its work is invisible
    // until something else forces a reload.
    serverConnections.onConnectionCreated((connection) => {
      if (this.subscribedServerIds.has(connection.serverId)) return
      this.watchHost(connection.serverId)
      this.hostGeneration++
      // `load` shares its in-flight promise, but checks this generation before
      // publishing. A host restored during the cold read therefore makes that
      // same operation retry instead of exposing an incomplete sidebar frame.
      void this.load()
    })
    // A catalog host exists before its socket is accepted. Its RPC queue can
    // wait through the whole retry ladder, so including it in a federated read
    // would keep healthy hosts out of the sidebar. Read it only after this edge,
    // then merge its rows into the snapshot already on screen.
    serverConnections.onPhaseChange((_serverId, phase) => {
      if (phase !== 'connected') return
      this.hostGeneration++
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
        // The broadcast carries no payload, so visible detail surfaces re-read
        // their own task. Hidden tabs stay mounted and can leave many cached
        // details behind; refreshing that full cache creates an RPC burst for
        // work the user cannot see.
        for (const task of this.byId.values()) {
          if (task.isDetailWatched) void task.loadDetails()
        }
        void this.refreshLinkedTasks(serverId)
      }, INVALIDATION_DEBOUNCE_MS)
    })
  }

  // --- Reverse links ------------------------------------------------------
  // Which tasks link a document, plan, or automation: the question a
  // conversation card asks, batched per host.

  /** The tasks linking `target`, or undefined until the host has answered. */
  linkedTasksFor(target: TaskLinkTarget): TaskLinkedTask[] | undefined {
    return this.linkedTasksByTarget.get(linkTargetKey(target))
  }

  /** Read the targets this client has not asked about yet, on the host that
   *  owns the conversation showing them. Targets already known are not
   *  re-read here — invalidation does that — so a transcript of a hundred
   *  cards costs one request, not one per scroll. */
  async ensureLinkedTasks(targets: TaskLinkTarget[], serverId?: string): Promise<void> {
    const host = serverId ?? serverConnections.defaultServerId()
    if (!host) return
    const missing = targets.filter((target) => {
      const key = linkTargetKey(target)
      return !this.linkedTasksByTarget.has(key) && !this.linkedTargetLoads.has(key)
    })
    if (!missing.length) return
    await this.readLinkedTasks(missing, host)
  }

  /** Re-read every cached target from the host that changed. */
  private async refreshLinkedTasks(serverId: string): Promise<void> {
    const targets: TaskLinkTarget[] = []
    for (const [key, host] of this.hostByLinkTargetKey) {
      if (host !== serverId) continue
      const [kind, targetScope, targetKey] = splitLinkTargetKey(key)
      targets.push({ kind, targetScope, targetKey })
    }
    if (targets.length) await this.readLinkedTasks(targets, serverId)
  }

  private async readLinkedTasks(targets: TaskLinkTarget[], serverId: string): Promise<void> {
    const generations = new Map<string, number>()
    for (const target of targets) {
      const key = linkTargetKey(target)
      const generation = (this.linkedTargetGenerations.get(key) ?? 0) + 1
      this.linkedTargetGenerations.set(key, generation)
      generations.set(key, generation)
    }
    const load = (async () => {
      try {
        const linked = await serverConnections.apiFor(serverId).tasksLinkedTo(targets)
        const byKey = new Map<string, TaskLinkedTask[]>()
        for (const target of targets) byKey.set(linkTargetKey(target), [])
        for (const edge of linked) byKey.get(linkTargetKey(edge))?.push(edge)
        for (const [key, edges] of byKey) {
          if (this.linkedTargetGenerations.get(key) !== generations.get(key)) continue
          this.linkedTasksByTarget.set(key, edges)
          this.hostByLinkTargetKey.set(key, serverId)
        }
      } catch (error) {
        // A card without its label is recoverable; the next invalidation or
        // mount asks again. Saying nothing is better than a wrong label.
        console.warn('[Solus] Linked-task read failed.', error)
      } finally {
        for (const target of targets) this.linkedTargetLoads.delete(linkTargetKey(target))
      }
    })()
    for (const target of targets) this.linkedTargetLoads.set(linkTargetKey(target), load)
    await load
  }

  /** A link this client just wrote: show it now rather than after the
   *  host's broadcast comes back around. */
  noteLinked(target: TaskLinkTarget, task: Task): void {
    const key = linkTargetKey(target)
    const edges = this.linkedTasksByTarget.get(key)
    if (!edges) return
    if (edges.some((edge) => edge.taskId === task.id)) return
    this.linkedTargetGenerations.set(key, (this.linkedTargetGenerations.get(key) ?? 0) + 1)
    this.linkedTasksByTarget.set(key, [{
      ...target,
      taskId: task.id,
      title: task.title,
      status: task.status,
      shortId: task.shortId,
      projectKey: task.projectKey,
    }, ...edges])
  }

  noteUnlinked(target: TaskLinkTarget, taskId: string): void {
    const key = linkTargetKey(target)
    const edges = this.linkedTasksByTarget.get(key)
    if (!edges) return
    const index = edges.findIndex((edge) => edge.taskId === taskId)
    if (index === -1) return
    this.linkedTargetGenerations.set(key, (this.linkedTargetGenerations.get(key) ?? 0) + 1)
    this.linkedTasksByTarget.set(key, edges.filter((edge) => edge.taskId !== taskId))
  }

  // --- The index ----------------------------------------------------------

  /**
   * The task to act on, by id — the same object every time.
   *
   * Minted on first mention, so a deep link or an agent tool can act on an id no
   * snapshot has listed; until a host describes it, `isKnown` is false and its
   * fields are defaults. Use `peek` to ask whether this client knows a task at
   * all: `get` always answers, and rendering its answer would draw an empty row.
   *
   * `projectKey` names the project of a provider ticket, whose issue number is
   * only unique inside it. A local ULID needs nothing.
   */
  get(id: string, projectKey?: string): Task {
    const existing = this.byId.get(id)
    if (existing) {
      if (projectKey) existing.projectKey = projectKey
      return existing
    }
    const created = new Task(this, id)
    if (projectKey) created.projectKey = projectKey
    this.byId.set(id, created)
    return created
  }

  /** The task this client knows, or null — the read counterpart to `get`, for
   *  the surfaces that render "no such task" rather than acting on one. */
  peek(id: string | null | undefined): Task | null {
    const task = id ? this.byId.get(id) : undefined
    return task?.isKnown ? task : null
  }

  /** The host a project's provider tickets are read through, once one has been. */
  providerHostFor(projectKey: string | null | undefined): string | undefined {
    return projectKey ? this.hostByProjectKey.get(projectKey) : undefined
  }

  /** Record which host answers for a project's provider tickets. The
   *  cross-host inbox is the only party that knows, and it says so by homing a
   *  ticket (`Task.placeIn`). */
  setProviderHost(projectKey: string, serverId: string): void {
    this.hostByProjectKey.set(projectKey, serverId)
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
    const providerHost = this.hostByProjectKey.get(projectKey)
    if (providerHost) return providerHost
    for (const task of this.tasks) {
      if (task.projectKey !== projectKey) continue
      const serverId = this.byId.get(task.id)?.serverId
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

  taskForSession(sessionId: string | null | undefined): Task | null {
    if (!sessionId) return null
    const taskId = this.taskIdBySessionId.get(sessionId)
    return taskId ? (this.tasks.find((task) => task.id === taskId) ?? null) : null
  }

  providerStatus(cwd: string | null | undefined): TaskProviderStatus | null {
    return cwd ? (this.providerStatusByCwd.get(cwd) ?? null) : null
  }

  // --- Ingest -------------------------------------------------------------
  // The one way a response becomes state. Called by `load`, by the session-tree
  // reads, and by every `Task` write that gets a row back.

  /** The live provider rows for a project, created empty on first ask. A `Task`
   *  files and unfiles itself here as its project and provider change. */
  upstreamRowsFor(projectKey: string): Task[] {
    const rows = this.upstreamTasksByProject.get(projectKey)
    if (rows) return rows
    const created: Task[] = []
    this.upstreamTasksByProject.set(projectKey, created)
    return created
  }

  // --- Loading ------------------------------------------------------------

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
        const serverId = opts?.serverId ?? this.hostForProject(cwd) ?? serverConnections.defaultServerId()
        if (!serverId) throw new Error('Primary Solus connection has not been registered')
        const status = await serverConnections.apiFor(serverId).tasksProviderStatus(cwd, opts)
        this.providerStatusByCwd.set(cwd, status)
        return status
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.error = message
        const status: TaskProviderStatus = {
          provider: this.providerStatus(cwd)?.provider ?? 'local',
          ok: false,
          reason: 'access_failed',
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
        while (true) {
          const hostGeneration = this.hostGeneration
          // One snapshot per accepted host, merged. A catalog host whose socket
          // is still connecting stays out of this read: its first-connect queue
          // has no deadline and must not hold every healthy host's rows back.
          // A host that fails after acceptance is reported rather than emptying
          // the list: losing one machine's tasks must not read as "the sidebar
          // lost my tasks" for every other machine.
          const serverIds = serverConnections.connectedServerIds().filter(
            (serverId) => serverConnections.phaseFor(serverId) === 'connected',
          )
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
          // Materializing restored tabs can add their remote hosts while this
          // read is pending. Discard the partial result before it reaches any
          // reactive state; the sidebar keeps its skeleton until the host set
          // and its task lifecycles are complete.
          if (hostGeneration !== this.hostGeneration) continue

          const failed = snapshots.filter((entry) => 'error' in entry)
          const ok = snapshots.filter((entry): entry is { serverId: string; snapshot: TaskSidebarSnapshot } => 'snapshot' in entry)
          this.applySnapshots(ok)
          this.loaded = true
          this.refreshedAt = Date.now()
          this.error = failed.length
            ? `Couldn't read tasks from ${failed.length} host${failed.length === 1 ? '' : 's'}.`
            : null
          break
        }
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

  /**
   * Merge every host's snapshot into the collection.
   *
   * Pull request links and session attempts are replaced wholesale rather than
   * merged: the snapshot is the authority on both, so a link removed on the host
   * has to disappear here, and a task absent from it holds neither.
   */
  private applySnapshots(ok: Array<{ serverId: string; snapshot: TaskSidebarSnapshot }>): void {
    const claimedIds = new Set<string>()
    const listed: Task[] = []
    const sessionsById = new Map<string, TaskSessionLink[]>()
    const prLinksById = new Map<string, TaskSidebarPrLink[]>()

    for (const { serverId, snapshot } of ok) {
      for (const record of snapshot.tasks) {
        // Two catalog hosts can serve one task store — a desktop host and a
        // standalone server over the same data directory both report the same
        // ULIDs. The task is one task: it belongs to the host that claimed it
        // first (the primary leads `connectedServerIds`), and listing it twice
        // would route its writes by the losing host and break the sidebar's
        // keyed rows outright.
        if (claimedIds.has(record.id)) continue
        claimedIds.add(record.id)
        const task = this.get(record.id)
        task.serverId = serverId
        if (task.hiddenForUndo) continue
        task.hydrate(record)
        listed.push(task)
      }
      // Sessions and pull request links follow the task to the host that won
      // it, so a row never shows one host's attempts under another host's task.
      for (const [taskId, links] of Object.entries(snapshot.sessionsByTask)) {
        if (!sessionsById.has(taskId)) sessionsById.set(taskId, links)
      }
      const prLinkLists = snapshot.prLinkListsByTask
        ?? Object.fromEntries(Object.entries(snapshot.prLinksByTask ?? {}).map(
          ([taskId, link]) => [taskId, [link]],
        ))
      for (const [taskId, links] of Object.entries(prLinkLists)) {
        if (!prLinksById.has(taskId)) prLinksById.set(taskId, links)
      }
    }

    this.tasks.splice(0, this.tasks.length, ...listed)
    this.taskIdBySessionId.clear()
    for (const taskId of new Set([...this.byId.keys(), ...sessionsById.keys(), ...prLinksById.keys()])) {
      const task = this.get(taskId)
      task.replaceSessions(sessionsById.get(taskId) ?? [])
      task.applyPrLinks(prLinksById.get(taskId) ?? [])
      for (const link of task.sessions) this.taskIdBySessionId.set(link.sessionId, taskId)
    }
  }

  /** Fetch a project's upstream tickets from the live provider. A project with no upstream provider
   * returns an empty list; errors land in `upstreamErrorByProject` instead of
   * failing the local list. */
  async loadUpstream(
    projectKey: string,
    opts?: { serverId?: string; query?: string },
  ): Promise<void> {
    // An absent `query` keeps whatever search is active, so an ordinary refresh
    // does not throw the user back to the unfiltered list. An empty one clears
    // it — that is how the page says "the search box is empty now".
    const query = opts?.query === undefined
      ? this.upstreamQueryByProject.get(projectKey) ?? ''
      : opts.query.trim()
    const pending = this.upstreamLoadsByProject.get(projectKey)
    if (pending) {
      // A different search is a different question, and the answer in flight
      // does not answer it.
      if (query === (this.upstreamQueryByProject.get(projectKey) ?? '')) return pending
      await pending
    }
    if (query) this.upstreamQueryByProject.set(projectKey, query)
    else this.upstreamQueryByProject.delete(projectKey)

    this.upstreamLoadingByProject.set(projectKey, true)
    this.upstreamErrorByProject.delete(projectKey)
    const load = (async () => {
      try {
        const serverId = opts?.serverId ?? this.hostForProject(projectKey) ?? serverConnections.defaultServerId()
        if (!serverId) throw new Error('Primary Solus connection has not been registered')
        const upstream = await serverConnections.apiFor(serverId)
          .tasksListUpstream(projectKey, { query })
        this.hostByProjectKey.set(projectKey, serverId)
        this.replaceUpstreamRows(projectKey, upstream.tasks)
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

  private replaceUpstreamRows(projectKey: string, records: TaskRecord[]): void {
    this.upstreamTasksByProject.set(projectKey, records.map((record) => {
      const task = this.get(record.id, projectKey)
      task.hydrate(record)
      return task
    }))
  }

  /**
   * Search the provider for a scope whose list came back capped.
   *
   * Below the cap the page already holds every ticket and filters them as you
   * type. Past it, the same filter quietly means "of the 200 loaded", so the
   * text has to go to the provider — an issue nobody has touched this month is
   * exactly the one being looked for.
   *
   * Debounced, because this is a keystroke handler and the far end is a network
   * search.
   */
  searchUpstream(projectKey: string, query: string): void {
    const trimmed = query.trim()
    const timer = this.upstreamSearchTimers.get(projectKey)
    if (timer) clearTimeout(timer)
    if (trimmed === (this.upstreamQueryByProject.get(projectKey) ?? '')) return
    this.upstreamSearchTimers.set(projectKey, setTimeout(() => {
      this.upstreamSearchTimers.delete(projectKey)
      void this.loadUpstream(projectKey, { query: trimmed })
    }, UPSTREAM_SEARCH_DEBOUNCE_MS))
  }

  // --- Session binding ----------------------------------------------------

  /** Move one mounted attempt from its provider id to the stable handoff id on
   * the same frame as the provider switch. A dispatched session's execution
   * host cannot edit the task host, so forward the same re-key to that host. */
  rekeySessionBinding(
    sourceSessionId: string,
    targetSessionId: string,
    taskServerId?: string,
  ): void {
    if (sourceSessionId === targetSessionId) return
    const taskId = this.taskIdBySessionId.get(sourceSessionId)
    if (taskId) {
      this.taskIdBySessionId.delete(sourceSessionId)
      this.taskIdBySessionId.set(targetSessionId, taskId)
      this.get(taskId).rekeySession(sourceSessionId, targetSessionId)
    }

    if (!taskServerId) return
    void serverConnections.apiFor(taskServerId)
      .tasksRekeySession(sourceSessionId, targetSessionId)
      .then(() => this.refreshSessionBinding(targetSessionId, taskServerId))
      .catch((error) => {
        console.warn('[Solus] Task session handoff re-key failed on the task host.', error)
      })
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

  /** Read each known identity from the task host before fallback task creation.
   * Unlike normal UI hydration, an RPC failure must reject: an empty cache is
   * not proof that the running agent did not create a task link. */
  async findSessionTaskOnHost(sessionIds: string[], serverId: string): Promise<Task | null> {
    const api = serverConnections.apiFor(serverId)
    for (const sessionId of sessionIds) {
      const tree = await api.tasksForSession(sessionId)
      if (tree) return this.applySessionTree(sessionId, tree, serverId)
    }
    return null
  }

  /** The two-level tree a session belongs to — its task, that task's parent,
   * and every subtask under the root, each by name. The global snapshot
   * carries all of them whenever it succeeds; this is the read that still
   * answers when it did not, so a session restored from disk never renders as
   * a loose row beside a parent whose subtasks are missing. */
  private async hydrateSessionTree(sessionId: string, serverId?: string): Promise<Task | null> {
    const ownerServerId = serverId ?? serverConnections.defaultServerId()
    if (!ownerServerId) return null
    const api = serverConnections.apiFor(ownerServerId)
    const tree = await api.tasksForSession(sessionId).catch(() => null)
    if (!tree) return null
    return this.applySessionTree(sessionId, tree, serverId)
  }

  private applySessionTree(
    sessionId: string,
    tree: TaskForSessionResult,
    serverId?: string,
  ): Task {
    const task = this.get(tree.task.id)
    for (const record of [tree.parent, tree.task, ...tree.subtasks, ...tree.siblings]) {
      if (record) this.get(record.id).hydrate(record, serverId)
    }
    task.bindSession(sessionId)
    for (const attempt of tree.attempts) {
      this.get(attempt.taskId ?? tree.task.id).applyAttempt(attempt)
    }
    return task
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

  /** `serverId` is the host the task belongs to — the one that owns the project
   *  it was created from. Omitted, it lands on the default host. */
  async create(input: TaskCreateInput, serverId?: string): Promise<Task> {
    const host = serverId ?? this.hostForProject(input.projectKey) ?? serverConnections.defaultServerId()
    if (!host) throw new Error('Primary Solus connection has not been registered')
    const created = await serverConnections.apiFor(host).tasksCreate(input)
    return this.get(created.id).hydrate(created, host)
  }

  /**
   * Bind an explicitly selected task before a session starts, or mint the
   * fallback task after a taskless turn settles, on the host that owns its
   * project.
   *
   * This is the first-dispatch boundary, moved out of whichever host happens to
   * run the agent. A dispatched session runs on one machine and files here, so
   * the mint cannot be a side effect of the prompt landing — the client has to
   * name the host, and it is the only party that knows both.
   *
   * Returns null when the host declines the operation, in which case the caller
   * leaves the session taskless.
   */
  async prepareForSession(
    serverId: string,
    input: { existingTaskId?: string | null; parentTaskId?: string | null; projectKey?: string | null; prompt?: string; includeSnapshot?: boolean },
  ): Promise<PrepareSessionTaskResult> {
    const result = await serverConnections.apiFor(serverId).tasksPrepareForSession(input)
    if (result.task) this.get(result.task.id).hydrate(result.task, serverId)
    return result
  }

  // --- Bulk delete --------------------------------------------------------

  /** Hide tasks for their Undo window. The host rows still exist until the
   *  toast commits, so a refresh landing in between must not restore them. */
  softRemove(ids: string[]): Task[] {
    const wanted = new Set(ids)
    const removed: Task[] = []
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      const task = this.tasks[index]
      if (!wanted.has(task.id)) continue
      task.hideForUndo()
      removed.unshift(task)
      this.tasks.splice(index, 1)
    }
    return removed
  }

  restorePending(pending: Task[]): void {
    if (!pending.length) return
    for (const task of pending) task.restore()
    this.tasks.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async commitPending(pending: Task[]): Promise<void> {
    const failureByIndex = new Map<number, unknown>()
    let nextIndex = 0
    const workers = Array.from(
      { length: Math.min(TASK_DELETE_CONCURRENCY, pending.length) },
      async () => {
        while (nextIndex < pending.length) {
          const index = nextIndex++
          try {
            await pending[index].delete()
          } catch (reason) {
            failureByIndex.set(index, reason)
          }
        }
      },
    )
    await Promise.all(workers)
    for (const task of pending) task.restore()
    const failed = pending.filter((_, index) => failureByIndex.has(index))
    if (failed.length) {
      this.restorePending(failed)
      const firstFailureIndex = pending.findIndex((_, index) => failureByIndex.has(index))
      throw failureByIndex.get(firstFailureIndex) ?? new Error('Delete failed')
    }
  }
}
