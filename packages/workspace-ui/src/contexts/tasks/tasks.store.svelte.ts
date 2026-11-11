import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostKey, splitHostKey } from '@solus/client-core/host-key'
import type { SessionStatus } from '@solus/contracts/types'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import { attemptServerId } from '../../lib/sessionUtils'
import { hosts } from '../hosts/hosts.svelte'
import { projectsStore } from '../projects/projects.store.svelte'
import type {
  PrepareSessionTaskRequest,
  PrepareSessionTaskResult,
  TaskAssigneeCandidate,
  TaskCreateInput,
  TaskForSessionResult,
  TaskLinkTarget,
  TaskLinkedTask,
  TaskSessionLink,
  TaskSidebarSnapshot,
  TaskSummary,
} from '@solus/contracts/task-types'
import { MAX_SIDEBAR_TASK_IDS } from '@solus/contracts/task-types'
import { Task } from './task.svelte'
import { taskSnoozesStore } from './task-snoozes.store.svelte'
import { taskSourcesStore } from './task-sources.store.svelte'
import { tasksInSources } from './task-projects'

const INVALIDATION_DEBOUNCE_MS = 100
const TASK_DELETE_CONCURRENCY = 8

/** The statuses in which an agent is working on a task. A session that waits
 *  for an answer, a plan review, or a rate limit is not running. */
export function isAgentRunningStatus(status: SessionStatus | undefined): boolean {
  return status === 'running' || status === 'connecting'
}

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
 * GitHub and Jira own every task (docs/plans/provider-owned-tasks.md). Each
 * host keeps a copy of the tasks that its projects' task sources list, and the
 * Solus attachments of a task key. This store merges every connected host's
 * snapshot into one list. A task is one task key, so two hosts that read the
 * same issue describe the same `Task`; the first of them in catalog order
 * reads and writes it. A host that holds only attachments (the organization's
 * Solus API) answers no tasks, and its session links join the task by its key.
 *
 * Nothing here is about one task. What is known about a task, and everything
 * that can be done to it, lives on `Task` and is reached through `get(id)`.
 *
 * What is left is the collection, and it is left here for one of three reasons.
 * It is about **which tasks exist** (`load`, the groupings, the Undo batch). It
 * is about a **project** rather than a task (which tasks its sources list). Or
 * it is about a **session**, answering "which task owns this one"
 * (`taskForSession`, the binding reads) — the reverse direction is a task's own
 * `sessions`. `create` and `prepareForSession` sit here because a task that does
 * not exist yet cannot be a method on one.
 */
export class TasksStore {
  /** The person's execution preferences for task work (plans/018 §6); the workspace supplies them. */
  executionPreferences: () => ExecutionPreferences = () => ({})
  private readonly checkedWorkerTitles = new Set<string>()

  /** Repair only the attempts on a task the person opened, two at a time. Each
   *  session is asked once per client run: a null answer (a lead, a session
   *  nobody delegated, naming turned off) is final, and only a failed call is
   *  asked again on a later page open. A title the task already shows costs no
   *  further read or write. */
  async repairWorkerTitles(taskId: string, links: TaskSessionLink[]): Promise<void> {
    const preferences = this.executionPreferences()
    if (preferences.autoRenameSessions === false) return
    const taskServerId = this.get(taskId).serverId
    const candidates = links.flatMap((link) => {
      const serverId = attemptServerId({ link, taskServerId })
      if (!serverId) return []
      const key = `${serverId}:${link.sessionId}`
      if (this.checkedWorkerTitles.has(key)) return []
      return [{ link, serverId }]
    }).slice(0, 20)
    for (const { link, serverId } of candidates) this.checkedWorkerTitles.add(`${serverId}:${link.sessionId}`)
    for (let index = 0; index < candidates.length; index += 2) {
      await Promise.all(candidates.slice(index, index + 2).map(async ({ link, serverId }) => {
        try {
          const title = await serverConnections.apiFor(serverId).ensureBackgroundSessionTitle(link.sessionId, preferences)
          if (!title || title === link.sessionTitle) return
          if (taskServerId && taskServerId !== serverId) {
            await serverConnections.apiFor(taskServerId).setSessionTitle(link.sessionId, title, 'generated', undefined, false)
          }
          await this.refreshSessionBinding(link.sessionId, taskServerId ?? serverId)
        } catch {
          // A host that is offline or has not updated yet can be retried on a later page open.
          this.checkedWorkerTitles.delete(`${serverId}:${link.sessionId}`)
        }
      }))
    }
  }
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
   * part and is tracked by `tasks` instead, which is also the honest split:
   * this index is identity, that list is "what exists".
   */
  private readonly byId = new Map<string, Task>()

  /** The tasks that some host's snapshot lists. Membership only — each element
   *  is the one `Task` for its key, so a field written through it redraws the
   *  rows reading that field without this list being rebuilt. */
  private listedTasks = $state<Task[]>([])

  /** The task keys each host's snapshot lists. A task leaves the list when no
   *  host lists it. */
  private readonly listedTaskIdsByHost = new Map<string, Set<string>>()
  /** The task keys each host holds session links or pull request links of. */
  private readonly attachedTaskIdsByHost = new Map<string, Set<string>>()

  get tasks(): Task[] {
    return this.listedTasks
  }

  /** Puts a task on the list, once. */
  private list(task: Task): void {
    if (!this.listedTasks.some((row) => row.id === task.id)) this.listedTasks.push(task)
  }

  /** The projects whose task sources list a task. One source can be in many
   *  projects, so a task can be in more than one. */
  projectKeysOf(task: Pick<Task, 'placements'>): string[] {
    const projectKeys = new Set<string>()
    for (const placement of task.placements) {
      for (const projectKey of taskSourcesStore.projectKeysBySource.get(placement.sourceKey) ?? []) {
        projectKeys.add(projectKey)
      }
    }
    return [...projectKeys]
  }

  /** The tasks that the task sources of one project list. */
  tasksInProject(projectKey: string | null | undefined): Task[] {
    if (!projectKey) return []
    const sourceKeys = taskSourcesStore.sourceKeysByProject.get(projectKey)
    return sourceKeys ? tasksInSources(this.tasks, sourceKeys) : []
  }

  /** Every task of these projects, each once, and every task that no known
   *  project lists (a task that only a session link brought here) — the
   *  every-project list has no other page to leave those on. */
  tasksInProjects(projectKeys: ReadonlySet<string>): Task[] {
    return this.tasks.filter((task) => {
      const taskProjectKeys = this.projectKeysOf(task)
      return taskProjectKeys.length === 0 || taskProjectKeys.some((projectKey) => projectKeys.has(projectKey))
    })
  }

  /** The tasks that are not done. */
  upNext: Task[] = $derived(this.tasks.filter((task) => task.category !== 'done'))

  // --- Assignee candidates ----------------------------------------------
  // The people a provider permits a task to be assigned to: for one task, or
  // for a new task in one source of a project. Keyed by `assigneeTargetKey`.

  private assigneeCandidatesByTarget = new SvelteMap<string, TaskAssigneeCandidate[]>()
  private assigneeCandidatesLoadingByTarget = new SvelteMap<string, boolean>()
  private assigneeCandidatesErrorByTarget = new SvelteMap<string, string>()

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
   * The sessions each host reports as running, keyed by `hostKey`. A task link
   * only says a session exists; this says whether its agent works now. It
   * holds only what `session.statusChanged` has said since this client
   * connected, so a host's entries go when its connection drops rather than
   * stay "running" for a turn that ended while nobody was listening.
   */
  private runningSessionKeys = new SvelteSet<string>()
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
  private loadPromise: Promise<void> | null = null
  private assigneeCandidateLoads = new Map<string, Promise<TaskAssigneeCandidate[]>>()
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null
  /** The tasks each host named since the debounce began; null when a host
   *  named none, which means "read everything". */
  private pendingInvalidations = new Map<string, Set<string> | null>()
  /** Bumped by each whole-list read. A narrowed read that started before one
   *  cannot overwrite the newer rows it brought. */
  private wholeListGeneration = 0
  private subscribedServerIds = new Set<string>()
  /** Changes whenever the set of hosts included in a sidebar snapshot changes. */
  private hostGeneration = 0
  /** Per host, the revision of the whole list on screen. A reconnect sends it
   *  and reads only what changed (docs/plans/task-snapshot-resume.md). */
  private readonly revisionByServerId = new Map<string, string>()

  constructor() {
    taskSnoozesStore.start()
    taskSourcesStore.start()
    for (const serverId of serverConnections.connectedServerIds()) {
      this.watchHost(serverId)
    }
    // A host connected later — dispatching to it, or opening a project on it —
    // has tasks this store has never read. Without this, its work is invisible
    // until something else forces a reload.
    serverConnections.onConnectionCreated((connection) => {
      if (this.subscribedServerIds.has(connection.serverId)) return
      this.watchHost(connection.serverId)
      this.hostGeneration++
      // Include a host restored during an in-flight read on the next pass.
      // Responses from the current hosts can already appear.
      void this.load()
    })
    // A catalog host exists before its socket is accepted. Its RPC queue can
    // wait through the whole retry ladder, so including it in a federated read
    // would keep healthy hosts out of the sidebar. Read it only after this edge,
    // then merge its rows into the snapshot already on screen.
    serverConnections.onReadinessChange((serverId, readiness) => {
      if (readiness !== 'ready') {
        this.forgetRunningSessions(serverId)
        return
      }
      void this.reloadHost(serverId)
    })
    queueMicrotask(() => void this.ensureLoaded())
  }

  /** Each host announces its own invalidations, so each is subscribed once. */
  private watchHost(serverId: string): void {
    this.subscribedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('tasks.invalidated', (event) => {
      const named = this.pendingInvalidations.get(serverId)
      if (!event.taskId) this.pendingInvalidations.set(serverId, null)
      else if (named) named.add(event.taskId)
      else if (named === undefined) this.pendingInvalidations.set(serverId, new Set([event.taskId]))
      if (this.invalidationTimer) clearTimeout(this.invalidationTimer)
      this.invalidationTimer = setTimeout(() => {
        this.invalidationTimer = null
        this.applyInvalidations()
      }, INVALIDATION_DEBOUNCE_MS)
    })
    serverConnections.eventsFor(serverId).subscribe('session.statusChanged', (event) => {
      const key = hostKey(serverId, event.sessionId)
      if (isAgentRunningStatus(event.status)) this.runningSessionKeys.add(key)
      else this.runningSessionKeys.delete(key)
    })
  }

  /**
   * Re-read what the hosts said changed. A host that named its tasks costs one
   * narrowed read of those rows; the whole list — over a megabyte at a thousand
   * tasks — is read only when a host could not say which tasks changed.
   */
  private applyInvalidations(): void {
    const pending = [...this.pendingInvalidations]
    this.pendingInvalidations.clear()
    const readsWholeList = pending.some(([, taskIds]) => !taskIds || taskIds.size > MAX_SIDEBAR_TASK_IDS)
    if (readsWholeList) void this.load()
    else for (const [serverId, taskIds] of pending) if (taskIds) void this.refreshTasks(serverId, [...taskIds])
    // Visible detail surfaces re-read their own task. Hidden tabs stay mounted
    // and can leave many cached details behind; refreshing that full cache
    // creates an RPC burst for work the user cannot see.
    const changedIds = readsWholeList ? null : new Set(pending.flatMap(([, taskIds]) => [...taskIds ?? []]))
    for (const task of this.byId.values()) {
      if (task.isDetailWatched && (!changedIds || changedIds.has(task.id))) void task.loadDetails()
    }
    for (const [serverId] of pending) void this.refreshLinkedTasks(serverId)
  }

  /**
   * Re-read one host after its socket connects again. It missed its own
   * invalidations while it was away, so it is asked what changed since the
   * revision on screen; a host that cannot say sends its whole list. Only that
   * host is read: a granted socket re-dials each time its grant expires, and
   * reading every host on each of those edges re-read every other host's full
   * list too.
   */
  private async reloadHost(serverId: string): Promise<void> {
    // Include a newly connected host in the current load's next pass.
    if (this.loadPromise) {
      this.hostGeneration++
      return
    }
    if (!this.loaded || this.error) {
      await this.load()
      return
    }
    if (!hosts.hasCollaboration(serverId)) return
    const generation = this.wholeListGeneration
    const since = this.revisionByServerId.get(serverId)
    let snapshot: TaskSidebarSnapshot
    try {
      const api = serverConnections.apiFor(serverId)
      snapshot = await (since ? api.tasksSidebarSnapshot({ since }) : api.tasksSidebarSnapshot())
    } catch (err) {
      console.error('tasks sidebar host read failed', serverId, err)
      return
    }
    if (generation !== this.wholeListGeneration) return
    if (snapshot.changedTaskIds) {
      this.applyTaskRows(serverId, snapshot.changedTaskIds, snapshot)
    } else {
      this.applyTaskRows(serverId, this.wholeAnswerTaskIds(serverId, snapshot), snapshot)
    }
    if (snapshot.revision) this.revisionByServerId.set(serverId, snapshot.revision)
    else this.revisionByServerId.delete(serverId)
  }

  /** Read the named rows from their host and merge them into the list in place. */
  private async refreshTasks(serverId: string, taskIds: string[]): Promise<void> {
    // A cold read in flight will list these rows too; merge after it so this
    // answer lands on a complete list, not an empty one.
    await (this.loadPromise ?? this.ensureLoaded())
    const generation = this.wholeListGeneration
    let snapshot: TaskSidebarSnapshot
    try {
      snapshot = await serverConnections.apiFor(serverId).tasksSidebarSnapshot({ taskIds })
    } catch (err) {
      console.error('tasks sidebar narrowed read failed', serverId, err)
      void this.load()
      return
    }
    if (generation !== this.wholeListGeneration) return
    this.applyTaskRows(serverId, taskIds, snapshot)
  }

  /** A whole answer covers every task the host listed or held attachments of
   *  before, so one it leaves out has gone from that host. */
  private wholeAnswerTaskIds(serverId: string, snapshot: TaskSidebarSnapshot): string[] {
    return [...new Set([
      ...snapshot.tasks.map((record) => record.id),
      ...Object.keys(snapshot.sessionsByTask),
      ...Object.keys(snapshot.prLinkListsByTask ?? {}),
      ...(this.listedTaskIdsByHost.get(serverId) ?? []),
      ...(this.attachedTaskIdsByHost.get(serverId) ?? []),
    ])]
  }

  /**
   * Merge one host's answer about the named tasks.
   *
   * A task row comes from a host that reads the task from its provider. When
   * two hosts list one task, the first in catalog order reads and writes it.
   * The session links and pull request links of a task key are attachments:
   * each host's are kept apart and the task reads them merged, so a host that
   * answers no task row (the organization's Solus API) still adds its links.
   * A named task the answer leaves out is no longer listed by this host; it
   * leaves the list when no other host lists it.
   */
  private applyTaskRows(serverId: string, taskIds: string[], snapshot: TaskSidebarSnapshot): void {
    const listed = this.taskIdsOn(this.listedTaskIdsByHost, serverId)
    const attached = this.taskIdsOn(this.attachedTaskIdsByHost, serverId)
    const answered = this.applyTaskRecords(serverId, snapshot.tasks)
    const prLinkLists = snapshot.prLinkListsByTask ?? {}
    for (const taskId of taskIds) {
      const sessions = snapshot.sessionsByTask[taskId] ?? []
      const prLinks = prLinkLists[taskId] ?? []
      const hasAttachments = sessions.length > 0 || prLinks.length > 0
      // A host that holds only attachments names task keys that no host has
      // described to this client yet; the task is minted so its links wait for it.
      const task = answered.has(taskId) || hasAttachments ? this.get(taskId) : this.byId.get(taskId)
      if (!task) continue
      if (hasAttachments || attached.has(taskId)) task.applyHostAttachments(serverId, sessions, prLinks)
      if (hasAttachments) attached.add(taskId)
      else attached.delete(taskId)
      if (answered.has(taskId) || !listed.delete(taskId)) continue
      const otherServerId = this.hostListing(taskId)
      if (otherServerId) {
        if (task.serverId === serverId) task.serverId = otherServerId
        continue
      }
      const index = this.listedTasks.indexOf(task)
      if (index !== -1) this.listedTasks.splice(index, 1)
    }
  }

  /** Take the task rows of one host's answer, and answer their task keys. */
  private applyTaskRecords(serverId: string, records: TaskSummary[]): Set<string> {
    const listed = this.taskIdsOn(this.listedTaskIdsByHost, serverId)
    const answered = new Set<string>()
    for (const record of records) {
      const task = this.get(record.id)
      answered.add(record.id)
      listed.add(record.id)
      if (!task.serverId || !this.listedTaskIdsByHost.get(task.serverId)?.has(task.id)
        || this.hostRank(serverId) < this.hostRank(task.serverId)) {
        task.serverId = serverId
      }
      if (task.serverId === serverId) task.hydrate(record)
      if (!task.hiddenForUndo) this.list(task)
    }
    return answered
  }

  private taskIdsOn(byHost: Map<string, Set<string>>, serverId: string): Set<string> {
    let taskIds = byHost.get(serverId)
    if (!taskIds) byHost.set(serverId, (taskIds = new Set()))
    return taskIds
  }

  /** A host's place in the catalog. A host this client does not know is last. */
  private hostRank(serverId: string): number {
    const index = serverConnections.connectedServerIds().indexOf(serverId)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }

  /** The first host in catalog order whose snapshot lists a task. */
  private hostListing(taskId: string): string | undefined {
    return serverConnections.connectedServerIds()
      .find((serverId) => this.listedTaskIdsByHost.get(serverId)?.has(taskId))
  }

  /** The connected hosts that can read a task from its provider: only a host
   *  that runs projects has task sources and a provider connection. */
  taskReadHosts(): string[] {
    return serverConnections.connectedServerIds().filter(
      (serverId) => serverConnections.readinessFor(serverId).readiness === 'ready' && hosts.hasExecution(serverId),
    )
  }

  /** Whether the host reported this session running, as far as this client heard. */
  isSessionRunning(serverId: string | null | undefined, sessionId: string): boolean {
    return !!serverId && this.runningSessionKeys.has(hostKey(serverId, sessionId))
  }

  /** Whether an agent works on one task attempt now. An open tab knows its own
   *  session's status, including a turn that began before this client
   *  connected; the host's feed answers for a session with no tab. */
  isAttemptRunning(
    link: Pick<TaskSessionLink, 'sessionId' | 'executionServerId'>,
    taskServerId: string | null,
    openSessionFor: (sessionId: string, serverId: string | undefined) => { status: SessionStatus } | undefined,
  ): boolean {
    const serverId = attemptServerId({ link, taskServerId })
    const open = openSessionFor(link.sessionId, serverId ?? undefined)
    return open ? isAgentRunningStatus(open.status) : this.isSessionRunning(serverId, link.sessionId)
  }

  private forgetRunningSessions(serverId: string): void {
    for (const key of [...this.runningSessionKeys]) {
      if (splitHostKey(key).serverId === serverId) this.runningSessionKeys.delete(key)
    }
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
      category: task.category,
      reference: task.reference,
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
   * The task to act on, by its task key — the same object every time.
   *
   * Minted on first mention, so a deep link or an agent tool can act on a key no
   * snapshot has listed; until a host describes it, `isKnown` is false and its
   * fields are defaults. Use `peek` to ask whether this client knows a task at
   * all: `get` always answers, and rendering its answer would draw an empty row.
   */
  get(id: string): Task {
    const existing = this.byId.get(id)
    if (existing) return existing
    const created = new Task(this, id)
    this.byId.set(id, created)
    return created
  }

  /** The task this client knows, or null — the read counterpart to `get`, for
   *  the surfaces that render "no such task" rather than acting on one.
   *
   *  `byId` is not reactive, so a miss reads `knownTaskCount`: a page opened
   *  before the first read of its task (a share link) asks again when it lands. */
  peek(id: string | null | undefined): Task | null {
    const task = id ? this.byId.get(id) : undefined
    if (task) return task.isKnown ? task : null
    void this.knownTaskCount
    return null
  }

  /** Grows when a task becomes known, so a `peek` that missed asks again. */
  private knownTaskCount = $state(0)

  /** Called by a task the first time a read describes it. */
  noteTaskKnown(): void {
    this.knownTaskCount++
  }

  /** The tasks of the project a checkout belongs to. */
  tasksForCheckout(serverId: string | null | undefined, path: string | null | undefined): Task[] {
    if (!serverId || !path) return []
    return this.tasksInProject(projectsStore.projectKeyFor(serverId, path))
  }

  /** Every label in use across a project's tasks, in name order. What a label
   *  picker offers beside the labels the task already carries. */
  knownLabels(serverId: string | null | undefined, path: string | null | undefined): string[] {
    return Array.from(new Set(this.tasksForCheckout(serverId, path).flatMap((task) => task.labels)))
      .sort((a, b) => a.localeCompare(b))
  }

  taskForSession(sessionId: string | null | undefined): Task | null {
    if (!sessionId) return null
    return this.peek(this.taskIdBySessionId.get(sessionId))
  }

  assigneeCandidates(target: TaskAssigneeTarget | null | undefined): TaskAssigneeCandidate[] {
    return target ? (this.assigneeCandidatesByTarget.get(assigneeTargetKey(target)) ?? []) : []
  }

  assigneeCandidatesLoading(target: TaskAssigneeTarget | null | undefined): boolean {
    return !!target && this.assigneeCandidatesLoadingByTarget.get(assigneeTargetKey(target)) === true
  }

  assigneeCandidatesError(target: TaskAssigneeTarget | null | undefined): string | null {
    return target ? (this.assigneeCandidatesErrorByTarget.get(assigneeTargetKey(target)) ?? null) : null
  }

  /** Load provider identities only when the assignee menu opens. */
  loadAssigneeCandidates(target: TaskAssigneeTarget, opts: { force?: boolean } = {}): Promise<TaskAssigneeCandidate[]> {
    const key = assigneeTargetKey(target)
    const held = this.assigneeCandidatesByTarget.get(key)
    if (!opts.force && held) return Promise.resolve(held)
    const pending = this.assigneeCandidateLoads.get(key)
    if (pending) return pending
    this.assigneeCandidatesLoadingByTarget.set(key, true)
    this.assigneeCandidatesErrorByTarget.delete(key)
    const load = (async () => {
      try {
        const serverId = 'taskId' in target ? await this.get(target.taskId).ownerHost() : target.serverId
        if (!serverId) throw new Error('No connected host has this task.')
        const candidates = await serverConnections.apiFor(serverId).tasksListAssigneeCandidates(
          'taskId' in target ? { taskId: target.taskId } : { cwd: target.cwd, sourceKey: target.sourceKey },
        )
        this.assigneeCandidatesByTarget.set(key, candidates)
        return candidates
      } catch (error) {
        this.assigneeCandidatesErrorByTarget.set(key, error instanceof Error ? error.message : String(error))
        throw error
      } finally {
        this.assigneeCandidatesLoadingByTarget.set(key, false)
        this.assigneeCandidateLoads.delete(key)
      }
    })()
    this.assigneeCandidateLoads.set(key, load)
    return load
  }

  // --- Loading ------------------------------------------------------------

  /** `loaded` means "the first attempt finished", which is what the spinners
   *  read — but a failed attempt must not stand in for a successful one here,
   *  or one bad snapshot latches every task surface empty for the rest of the
   *  session: no sidebar row, no rail card. Retry while the last
   *  attempt is still the failed one. */
  ensureLoaded(): Promise<void> {
    if (this.loaded && !this.error) return Promise.resolve()
    return this.loadPromise ?? this.load()
  }

  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loading = true
    this.error = null
    this.wholeListGeneration++
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
          // A host must serve the collaboration plane to hold tasks at all
          // (docs/plans/cloud-service-model.md).
          const serverIds = serverConnections.connectedServerIds().filter(
            (serverId) => serverConnections.readinessFor(serverId).readiness === 'ready' && hosts.hasCollaboration(serverId),
          )
          const snapshots = await Promise.all(
            serverIds.map(async (serverId) => {
              try {
                const snapshot = await serverConnections.apiFor(serverId).tasksSidebarSnapshot()
                this.applyHostSnapshot(serverId, snapshot)
                this.loaded = true
                this.refreshedAt = Date.now()
                return { serverId }
              } catch (err) {
                console.error('tasks sidebar snapshot load failed', serverId, err)
                return { serverId, error: err }
              }
            }),
          )
          // A finished pass ends the loading state, even when every host in it
          // failed: an unreachable host rejects, and must not hold the skeleton.
          this.loaded = true
          // Restored tabs can add hosts during this read. Include them on the
          // next pass without holding back responses already received.
          if (hostGeneration !== this.hostGeneration) continue

          const failed = snapshots.filter((entry) => 'error' in entry)
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

  /** Apply one whole host response, including its session and PR links.
   *  Other hosts keep their rows until they answer. */
  private applyHostSnapshot(serverId: string, snapshot: TaskSidebarSnapshot): void {
    this.applyTaskRows(serverId, this.wholeAnswerTaskIds(serverId, snapshot), snapshot)
    if (snapshot.revision) this.revisionByServerId.set(serverId, snapshot.revision)
    else this.revisionByServerId.delete(serverId)
  }

  /**
   * Ask the provider for the tasks of a project's sources that match a query.
   *
   * The only way to reach a task that a truncated source did not list: an issue
   * nobody has touched this month is exactly the one being looked for. The
   * answers are tasks to act on, but they do not join the list; the next
   * snapshot decides what the list holds.
   */
  async search(serverId: string, cwd: string, query: string): Promise<Task[]> {
    const found = await serverConnections.apiFor(serverId).tasksSearch(cwd, query)
    return found.map((record) => {
      const task = this.get(record.id)
      return task.hydrate(record, task.serverId ? undefined : serverId)
    })
  }

  // --- Session binding ----------------------------------------------------

  /** Hydrate an opened session's task and attempts even when the global
   * snapshot already knows its owner. The targeted read carries every linked
   * session's display metadata; none of it requires a transcript. The host's answer is authoritative: a session it reports as
   * taskless is taskless, and most sessions are, so that answer must not cost
   * a full snapshot per restored tab. Fall back to the global snapshot only
   * when the focused read itself failed. */
  async ensureSessionBinding(sessionId: string, serverId?: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    const existing = this.taskForSession(sessionId)
    const hydrated = await this.hydrateSessionTask(sessionId, serverId)
    if (hydrated) return hydrated
    if (hydrated === null || existing) return existing
    await this.load()
    return this.taskForSession(sessionId)
  }

  /** The task a session belongs to and every attempt on it. The global
   * snapshot carries them whenever it succeeds; this is the read that still
   * answers when it did not, so a session restored from disk never renders as
   * a loose row beside the task it belongs to.
   *
   * `null` is the host's answer that the session has no task; `undefined`
   * means no host could answer. */
  private async hydrateSessionTask(sessionId: string, serverId?: string): Promise<Task | null | undefined> {
    const ownerServerId = serverId ?? serverConnections.defaultServerId()
    if (!ownerServerId) return undefined
    const api = serverConnections.apiFor(ownerServerId)
    const found = await api.tasksForSession(sessionId).catch(() => undefined)
    if (found === undefined) return undefined
    if (found === null) return null
    return this.applySessionTask(sessionId, found, ownerServerId)
  }

  private applySessionTask(sessionId: string, found: TaskForSessionResult, serverId: string): Task {
    const task = this.get(found.task.id)
    task.hydrate(found.task, this.readHostFor(task, serverId))
    task.bindSession(sessionId)
    for (const link of found.attempts) task.applySessionLink(serverId, link)
    this.taskIdsOn(this.attachedTaskIdsByHost, serverId).add(task.id)
    return task
  }

  /** The host to record as the reader of a task that `serverId` just
   *  described: undefined when the task has a reader already, or when
   *  `serverId` holds only attachments and cannot read a task. */
  private readHostFor(task: Task, serverId: string): string | undefined {
    return !task.serverId && hosts.hasExecution(serverId) ? serverId : undefined
  }

  /** Read a session's binding after a write to its task host. New session
   * links use this after their optimistic same-frame projection. The host
   * broadcasts `tasks.invalidated` for the write, and that reloads the sidebar;
   * this is the focused read that answers the caller now, so a session start
   * does not cost a second full snapshot. It waits for any cold load in flight
   * so the targeted rows merge into a complete collection, not an empty one. */
  async refreshSessionBinding(sessionId: string, serverId?: string): Promise<Task | null> {
    await (this.loadPromise ?? this.ensureLoaded())
    const hydrated = await this.hydrateSessionTask(sessionId, serverId)
    return hydrated ?? this.taskForSession(sessionId)
  }

  /** Create a task on the provider, in a source of the project `input.cwd`.
   *  `serverId` names the host that has that project: a path alone does not
   *  name a host. A failed create throws and nothing is listed. */
  async create(input: TaskCreateInput, serverId: string): Promise<Task> {
    const created = await serverConnections.apiFor(serverId).tasksCreate(input)
    const task = this.get(created.id).hydrate(created, serverId)
    this.taskIdsOn(this.listedTaskIdsByHost, serverId).add(task.id)
    this.list(task)
    return task
  }

  /**
   * Bind the task a session names, before its first prompt leaves — on the
   * host that files the session link.
   *
   * This is the first-dispatch boundary, moved out of whichever host happens to
   * run the agent. A dispatched session runs on one machine and files here, so
   * the binding cannot be a side effect of the prompt landing — the client has
   * to name the host, and it is the only party that knows both.
   *
   * Returns null when the host declines the operation, in which case the caller
   * leaves the session taskless.
   */
  async prepareForSession(
    serverId: string,
    input: PrepareSessionTaskRequest,
  ): Promise<PrepareSessionTaskResult> {
    const result = await serverConnections.apiFor(serverId).tasksPrepareForSession(input)
    if (result.task) {
      const task = this.get(result.task.id)
      task.hydrate(result.task, this.readHostFor(task, serverId))
    }
    return result
  }

  // --- Bulk delete --------------------------------------------------------

  /** Hide draft tasks for their Undo window. The drafts still exist until the
   *  toast commits, so a refresh landing in between must not restore them. */
  softRemove(ids: string[]): Task[] {
    const wanted = new Set(ids)
    const removed: Task[] = []
    for (let index = this.listedTasks.length - 1; index >= 0; index--) {
      const task = this.listedTasks[index]
      if (!wanted.has(task.id)) continue
      task.hideForUndo()
      removed.unshift(task)
      this.listedTasks.splice(index, 1)
    }
    return removed
  }

  restorePending(pending: Task[]): void {
    if (!pending.length) return
    for (const task of pending) {
      task.restore()
      this.list(task)
    }
    this.listedTasks.sort((a, b) => b.updatedAt - a.updatedAt)
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
    // A deleted task stays hidden: restoring it would list it again until the
    // host's invalidation reload drops it, and a snapshot read before the
    // delete landed would bring it back outright.
    const failed = pending.filter((_, index) => failureByIndex.has(index))
    if (failed.length) {
      this.restorePending(failed)
      const firstFailureIndex = pending.findIndex((_, index) => failureByIndex.has(index))
      throw failureByIndex.get(firstFailureIndex) ?? new Error('Delete failed')
    }
  }
}

/** Whose assignee candidates to read: the people for one task, or for a new
 *  task in one source of a project on one host. */
export type TaskAssigneeTarget =
  | { taskId: string }
  | { serverId: string; cwd: string; sourceKey: string }

function assigneeTargetKey(target: TaskAssigneeTarget): string {
  return 'taskId' in target ? `task:${target.taskId}` : `source:${hostKey(target.serverId, target.cwd)}:${target.sourceKey}`
}
