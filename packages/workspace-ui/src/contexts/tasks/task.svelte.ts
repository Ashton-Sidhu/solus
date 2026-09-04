// One task, as this client can read and act on it.
//
// The plane the surfaces work against. Before this, every per-task operation was
// a method on `TasksStore` taking the id as its first argument, and everything
// known about a task was spread across seven maps keyed by that id —
// `hostByTaskId`, `detailsByTask`, `prLinksByTask`, `sessionsByTask`, the detail
// load and watch counters, and the regenerating-title set. Those were seven
// indexes of one thing, and a surface reading the wrong one saw a task the rest
// of the workspace had already moved past.
//
// There is **one of these per task id**, held in `TasksStore`'s index, so what
// one surface writes is what every other surface reads.
//
// `TaskRecord` is the same shape as the wire, and this class implements it — a
// Task *is* a task, so a surface reads `task.title`, not `task.record.title`.
// That mirrors the server's own `Task` (packages/server/src/tasks/task.ts). The
// fields are `$state`, so a snapshot that changes only `status` notifies only
// what reads `status`. Everything this *client* knows on top of the row — the
// host serving it, its detail payload, its attempts — is private, so the public
// surface of a Task is the task plus the things you can do to it.

import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import type {
  SessionExecutionHost,
  Task as TaskRecord,
  TaskDetails,
  TaskKind,
  TaskLinkInput,
  TaskLinkKind,
  TaskMirroredTicket,
  TaskPr,
  TaskPriority,
  TaskProviderId,
  TaskSessionLink,
  TaskSidebarPrLink,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
  TaskTitleSource,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import { sameMirroredTicket, samePr, samePrLinks, sameStrings } from './task-reconcile'
import { upstreamTaskDetails } from './upstream-task-details'
import { taskTitleRegenerationInput } from './task-title-regeneration'
import type { TasksStore } from './tasks.store.svelte'

export class Task implements TaskRecord {
  // --- The task -----------------------------------------------------------
  // `TaskRecord`, field for field. Written only by `hydrate`.

  readonly id: string
  providerId = $state<TaskProviderId>('local')
  shortId = $state<number | undefined>()
  projectKey = $state<string | null | undefined>()
  kind = $state<TaskKind>('task')
  title = $state('')
  titleSource = $state<TaskTitleSource | undefined>()
  body = $state('')
  status = $state<TaskStatus>('todo')
  url = $state<string | null>(null)
  mirroredTicket = $state<TaskMirroredTicket | undefined>()
  assignee = $state<string | undefined>()
  assigneeAvatarUrl = $state<string | undefined>()
  labels = $state<string[]>([])
  parentId = $state<string | undefined>()
  childIds = $state<string[] | undefined>()
  dueDate = $state<string | undefined>()
  priority = $state<TaskPriority | undefined>()
  pr = $state<TaskPr | undefined>()
  canEditPlanningFields = $state<boolean | undefined>()
  source = $state<TaskSource | undefined>()
  originSessionId = $state<string | undefined>()
  originAutomationId = $state<string | undefined>()
  createdAt = $state<number | undefined>()
  updatedAt = $state(0)
  triagedAt = $state<number | undefined>()
  doneAt = $state<number | undefined>()
  lastReadAt = $state<number | undefined>()
  raw = $state<unknown>()

  // --- What this client knows besides the row -----------------------------

  readonly #store: TasksStore

  /** Whether any host has described this task yet. `TasksStore.get` mints a task
   *  on first mention — a deep link, an id typed into an agent tool — so the
   *  fields above are defaults until this is true. */
  #known = $state(false)

  /** The host that serves this task. Null until a snapshot places it, which
   *  falls back to the default host — where a single-host user's tasks all are. */
  #serverId = $state<string | null>(null)

  #details = $state<TaskDetails | null>(null)
  #sessions = $state<TaskSessionLink[]>([])
  #prLinks = $state<TaskSidebarPrLink[]>([])
  #regeneratingTitle = $state(false)
  #hiddenForUndo = $state(false)
  #detailLoad: Promise<TaskDetails> | null = null

  /**
   * How many visible surfaces are rendering this task's detail.
   *
   * Detail payloads are larger than sidebar rows, and hidden mounted tabs can
   * leave many of them cached. Only tasks on screen are refreshed when a host
   * invalidates; the rest keep their cached value and catch up when they become
   * visible again.
   */
  #watchCount = 0

  constructor(store: TasksStore, id: string) {
    this.#store = store
    this.id = id
  }

  // --- Answers ------------------------------------------------------------

  /** True once a host has described this task. A task minted for an id nobody
   *  has listed reads as an empty task until then. */
  get isKnown(): boolean {
    return this.#known
  }

  /** A provider-owned ticket rather than a Solus-owned task. */
  get isUpstream(): boolean {
    return this.#known && this.providerId !== 'local'
  }

  get serverId(): string | null {
    return this.#serverId
  }

  set serverId(serverId: string | null) {
    this.#serverId = serverId
  }

  /** Hidden while its Undo toast is up. The host row still exists until the
   *  toast commits, so a refresh landing in that window must not put it back. */
  get hiddenForUndo(): boolean {
    return this.#hiddenForUndo
  }

  /** Comments, links and activity. Null until a detail surface has opened it;
   *  the sidebar row carries none of it. */
  get details(): TaskDetails | null {
    return this.#details
  }

  /** This task's own session attempts. `attempts` is the tree-wide view. */
  get sessions(): TaskSessionLink[] {
    return this.#sessions
  }

  get isRegeneratingTitle(): boolean {
    return this.#regeneratingTitle
  }

  /** Every durable pull request link, newest first. The task's own captured
   *  pull request answers for older hosts and migrated tasks. */
  get prLinks(): TaskSidebarPrLink[] {
    if (this.#prLinks.length) return this.#prLinks
    return this.pr ? [{ number: this.pr.number, url: this.pr.url }] : []
  }

  /** The newest durable linked pull request, for callers that need only one. */
  get prLink(): TaskSidebarPrLink | null {
    return this.prLinks[0] ?? null
  }

  /** Every session shown under this task in the session tree — its own, plus
   *  every sibling subtask's, since the tree renders them under one root. */
  get attempts(): TaskSessionLink[] {
    if (!this.#known) return this.#sessions
    const rootId = this.parentId ?? this.id
    const tree = [rootId, ...(this.#store.byParent.get(rootId) ?? []).map((child) => child.id)]
    const links = tree.flatMap((id) => this.#store.peek(id)?.sessions ?? [])
    return [...new Map(links.map((link) => [link.sessionId, link])).values()]
  }

  /** True while a visible surface is rendering this task's detail. */
  get isDetailWatched(): boolean {
    return this.#watchCount > 0
  }

  /**
   * The RPC surface that serves this task.
   *
   * A provider ticket is routed by its project, because a bare issue number
   * means nothing without one. Everything else is routed by the host the
   * snapshot placed the task on, and an unplaced task falls back to the default.
   */
  get #api(): HostApi {
    const serverId = this.#store.providerHostFor(this.projectKey)
      ?? this.#serverId
      ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  /** The project the `tasks*Upstream` RPCs key their provider on. The host
   *  always stamps an upstream task with one, so its absence is a real fault. */
  get #upstreamCwd(): string {
    if (!this.projectKey) {
      throw new Error(`Project not found for ${this.providerId} task ${this.id}.`)
    }
    return this.projectKey
  }

  // --- Reads --------------------------------------------------------------

  /**
   * Resolve the host that owns this task, trying harder than `serverId`: an
   * outbox op can name a task this client has never listed (recorded by an agent
   * on a borrowed machine), so an unplaced id is asked of every connected host
   * before giving up. Undefined means "no connected host owns it" — the op stays
   * pending, which is a reported state, not a failure.
   */
  async ownerHost(): Promise<string | undefined> {
    if (this.#serverId) return this.#serverId
    await this.#store.ensureLoaded()
    if (this.#serverId) return this.#serverId
    for (const serverId of serverConnections.connectedServerIds()) {
      try {
        const details = await serverConnections.apiFor(serverId).tasksGet(this.id)
        if (details?.task) {
          this.#serverId = serverId
          return serverId
        }
      } catch {
        // Not this host's task.
      }
    }
    return undefined
  }

  /** Keep this task's detail current while a surface that renders it is visible. */
  watchDetails(): () => void {
    this.#watchCount++
    return () => {
      if (this.#watchCount > 0) this.#watchCount--
    }
  }

  /** The detail read behind the task page: comments, links and activity. */
  loadDetails(): Promise<TaskDetails> {
    if (this.#detailLoad) return this.#detailLoad
    const load = (async () => {
      if (this.#known ? this.isUpstream : await this.#looksUpstream()) {
        const cwd = this.#upstreamCwd
        this.hydrate(await this.#api.tasksGetUpstream(cwd, this.id))
        const details = upstreamTaskDetails(this, this.#store.tasksForProject(cwd))
        this.#details = details
        return details
      }
      const details = await this.#api.tasksGet(this.id)
      this.applyDetails(details)
      return details
    })().finally(() => {
      if (this.#detailLoad === load) this.#detailLoad = null
    })
    this.#detailLoad = load
    return load
  }

  /** A directly opened task no snapshot has listed: an issue-number id in a
   *  project with an upstream provider is a provider ticket (local ids are
   *  ULIDs), so a deep link hydrates instead of reading as a missing task. */
  async #looksUpstream(): Promise<boolean> {
    if (!this.projectKey) return false
    const status = this.#store.providerStatus(this.projectKey)
      ?? await this.#store.loadProviderStatus(this.projectKey)
    if (status.provider === 'github') return /^\d+$/.test(this.id)
    if (status.provider === 'jira') return /^[A-Z][A-Z0-9_]+-\d+$/i.test(this.id)
    return false
  }

  // --- Writes -------------------------------------------------------------

  async setStatus(status: TaskStatus): Promise<void> {
    const previous = this.status
    // Optimistic: the row redraws on this frame, and only what reads `status`
    // is invalidated.
    this.status = status
    try {
      this.hydrate(this.isUpstream
        ? await this.#api.tasksUpdateUpstream(this.#upstreamCwd, this.id, { status })
        : await this.#api.tasksUpdate(this.id, { status }))
    } catch (err) {
      this.status = previous
      throw err
    }
  }

  async update(patch: TaskUpdatePatch): Promise<this> {
    this.hydrate(this.isUpstream
      ? await this.#api.tasksUpdateUpstream(this.#upstreamCwd, this.id, patch)
      : await this.#api.tasksUpdate(this.id, patch))
    return this
  }

  /** Generate a new name from this task's durable description, then write it
   *  through the same host/provider path as a manual rename. */
  async regenerateTitle(): Promise<this> {
    if (this.#regeneratingTitle) throw new Error('The task title is already regenerating.')
    if (!this.#known) throw new Error('Task not found.')
    this.#regeneratingTitle = true
    try {
      const metadata = await this.#api.generateSessionMetadata(
        taskTitleRegenerationInput(this),
        this.projectKey ?? '~',
      )
      if (!metadata) throw new Error("Couldn't generate a new task title.")
      return await this.update({ title: metadata.title })
    } finally {
      this.#regeneratingTitle = false
    }
  }

  async markRead(read: boolean): Promise<this> {
    this.hydrate(await this.#api.tasksMarkRead(this.id, read))
    return this
  }

  async recordActivity(): Promise<this> {
    this.hydrate(await this.#api.tasksRecordActivity(this.id))
    return this
  }

  async delete(): Promise<void> {
    await this.#api.tasksDelete(this.id)
  }

  /**
   * `pushToExternal` decides whether this comment goes to the linked ticket as
   * well as into the task. Omitted, the project's auto-post setting decides —
   * the host reads it, so a client never has to be right about it.
   */
  async comment(body: string, opts?: { pushToExternal?: boolean }): Promise<this> {
    if (this.isUpstream) {
      const cwd = this.#upstreamCwd
      this.hydrate(await this.#api.tasksCommentUpstream(cwd, this.id, body))
      this.#details = upstreamTaskDetails(this, this.#store.tasksForProject(cwd))
      return this
    }
    this.applyDetails(await this.#api.tasksComment(this.id, body, opts))
    return this
  }

  async deleteComment(commentId: string): Promise<void> {
    this.applyDetails(await this.#api.tasksDeleteComment(this.id, commentId))
  }

  /** Send comments upstream that were written while auto-posting was off. The
   *  host queues them and the sync engine posts them on its own next pass. */
  async publishComments(commentIds: string[]): Promise<void> {
    if (!commentIds.length) return
    this.applyDetails(await this.#api.tasksPublishComments(this.id, commentIds))
  }

  /** Create the upstream ticket this task does not have yet, in the provider
   *  the project is configured for, and link the two from then on. */
  async publishUpstream(cwd: string): Promise<void> {
    const details = await this.#api.tasksPublish(this.id, cwd)
    this.applyDetails(details)
    // The ticket we just created belongs to this task now. The host leaves
    // mirrored tickets out of its upstream list, but this client is holding one
    // from before the link existed — drop it here rather than showing the same
    // work twice until the next provider read.
    if (details.externalLink) {
      this.#store.get(details.externalLink.externalId, cwd).forgetUpstreamRow()
    }
  }

  /**
   * Promote this provider ticket to a Solus-owned task, and answer with it.
   *
   * The import mints a new task with its own id, so the result is a different
   * Task — this one goes on standing for the provider's ticket. Import is
   * idempotent on the host, so two pickers racing resolve to the same task.
   */
  async promote(): Promise<Task> {
    if (!this.#known) throw new Error(`Task ${this.id} has not been read yet.`)
    if (!this.isUpstream) return this
    const cwd = this.#upstreamCwd
    const [details] = await this.#api.tasksImport(cwd, [this.id])
    if (!details) throw new Error(`Could not import ${this.providerId} ticket ${this.id}.`)
    const promoted = this.#store.get(details.task.id)
    promoted.applyDetails(details)
    this.forgetUpstreamRow()
    return promoted
  }

  /**
   * Home a provider ticket on the host and project that will serve its detail
   * and action RPCs.
   *
   * The row stays provider-owned and is not persisted; this only records who
   * answers for it. A ticket read from the cross-host inbox reaches this client
   * from several hosts at once, and which one should own it is the user's choice
   * after deduplication — the only fact neither the provider nor any host can
   * supply. Once homed, ordinary `update` and `promote` route themselves.
   */
  placeIn(home: { serverId: string; projectKey: string }): this {
    this.#serverId = home.serverId
    // The provider does not know which project this client filed the ticket
    // under, so the caller's choice outranks whatever the row said.
    this.projectKey = home.projectKey
    this.#store.setProviderHost(home.projectKey, home.serverId)
    this.#file()
    return this
  }

  /**
   * The live state a dispatched prompt ships to its execution host.
   *
   * Read from the named host rather than this task's own routing: a snapshot for
   * a session's own task must come from where that session files it
   * (docs/plans/dispatch-parity.md).
   */
  async dispatchSnapshot(serverId: string): Promise<TaskSnapshot | null> {
    return serverConnections.apiFor(serverId).tasksSnapshot(this.id)
  }

  /**
   * Bind a started session to this task, on the host that owns it.
   *
   * For an explicit task, the bind prepares before the prompt and the durable
   * link follows `session_init`. For a fallback task, minting and linking both
   * happen after turn settlement. A dispatch can involve different machines in
   * either case.
   *
   * That second machine is also the only thing neither host can work out for
   * itself, so the client states it in `execution` and the task's host records a
   * session row for it. `execution` is null for a run that stayed on the task's
   * host — the two ids being equal is the definition of "not a dispatch", and a
   * host id is only meaningful next to a different one.
   *
   * `serverId` names this task's own host for the dispatch boundary, where the
   * caller knows it from the run and this client may not have placed the task
   * yet. Given, it is remembered.
   */
  async linkSession(
    sessionId: string,
    execution: SessionExecutionHost | null,
    serverId?: string,
  ): Promise<void> {
    if (serverId) this.#serverId = serverId
    await this.#api.tasksLinkSession(this.id, sessionId, 'working', execution)
  }

  /**
   * Exchange this task with the ticket it is linked to, now: push the fields
   * and comments the host is holding, then take whatever moved upstream.
   *
   * The engine already does this on its own debounce, so this is the user
   * saying "don't wait" — after an auth repair, or before trusting the page.
   * The detail re-read is what refreshes the sync state the page renders.
   */
  async syncNow(): Promise<void> {
    await this.#api.tasksSyncNow(this.id)
    await this.loadDetails()
  }

  /** Attach a doc, plan, pull request or automation to this task. */
  async link(input: TaskLinkInput): Promise<TaskDetails> {
    const details = await this.#api.tasksLink(this.id, input)
    this.applyDetails(details)
    this.#store.noteLinked(
      { kind: input.kind, targetScope: input.targetScope ?? '', targetKey: input.targetKey },
      this,
    )
    return details
  }

  async unlink(kind: TaskLinkKind, targetKey: string, targetScope = ''): Promise<TaskDetails> {
    const details = await this.#api.tasksUnlink(this.id, kind, targetKey, targetScope)
    this.applyDetails(details)
    this.#store.noteUnlinked({ kind, targetScope, targetKey }, this.id)
    return details
  }

  /** File a linked artifact's still (and its HTML, where the ticket takes it)
   *  as a comment bound for the ticket. The host renders the still. */
  async attachArtifact(workId: string, cwd?: string): Promise<TaskDetails> {
    const details = await this.#api.tasksAttachArtifact(this.id, workId, cwd)
    this.applyDetails(details)
    return details
  }

  // --- Sessions -----------------------------------------------------------

  /**
   * Expose the binding on the session-init frame while the authoritative
   * task-session read is still in flight. The host has already persisted this
   * association; the optimistic entry lets every task surface show live work
   * immediately and is replaced by the next authoritative sidebar snapshot.
   *
   * The display fields are genuinely unknown here rather than merely omitted:
   * the session has not reached the index yet, and a just-started session is
   * always mounted, so every surface names it from its live tab regardless.
   */
  trackSessionStart(sessionId: string): void {
    this.bindSession(sessionId)
    if (this.#sessions.some((attempt) => attempt.sessionId === sessionId)) return
    this.#sessions.push({
      taskId: this.id,
      sessionId,
      sessionTitle: null,
      provider: null,
      model: null,
      startedAt: Date.now(),
      lastActivityAt: null,
      linkedAt: Date.now(),
    })
  }

  /**
   * Record an authoritative attempt row.
   *
   * Overwrite rather than skip: the entry already here may be the optimistic one
   * from `trackSessionStart`, which carries no display metadata. A read that
   * names the session is authoritative, so it upgrades in place.
   */
  applyAttempt(attempt: TaskSessionLink): void {
    const index = this.#sessions.findIndex((existing) => existing.sessionId === attempt.sessionId)
    if (index === -1) this.#sessions.push(attempt)
    else this.#sessions[index] = attempt
    // A `referenced` attempt is listed but does not own the session.
    if (attempt.role !== 'referenced') this.bindSession(attempt.sessionId)
  }

  /** Claim a session for this task in the store's session index, which is what
   *  `taskForSession` answers from. The attempt row itself is `sessions`. */
  bindSession(sessionId: string): void {
    this.#store.taskIdBySessionId.set(sessionId, this.id)
  }

  /** Release a session, if it is still this task's. */
  unbindSession(sessionId: string): void {
    if (this.#store.taskIdBySessionId.get(sessionId) === this.id) {
      this.#store.taskIdBySessionId.delete(sessionId)
    }
  }

  /**
   * Detach a session from this task, on the host that owns it. The attempt row
   * goes on this frame so every mounted surface drops it now; the next
   * authoritative snapshot agrees rather than restores it.
   */
  async unlinkSession(sessionId: string): Promise<void> {
    await this.#api.tasksUnlinkSession(this.id, sessionId)
    const index = this.#sessions.findIndex((attempt) => attempt.sessionId === sessionId)
    if (index !== -1) this.#sessions.splice(index, 1)
    this.unbindSession(sessionId)
  }

  /** Move one mounted attempt from its provider id to the stable handoff id, on
   *  the same frame as the provider switch. */
  rekeySession(sourceSessionId: string, targetSessionId: string): void {
    const sourceIndex = this.#sessions.findIndex((attempt) => attempt.sessionId === sourceSessionId)
    if (sourceIndex === -1) return
    const targetIndex = this.#sessions.findIndex((attempt) => attempt.sessionId === targetSessionId)
    if (targetIndex === -1) this.#sessions[sourceIndex].sessionId = targetSessionId
    else this.#sessions.splice(sourceIndex, 1)
  }

  replaceSessions(sessions: TaskSessionLink[]): void {
    this.#sessions = sessions
  }

  // --- Undo ---------------------------------------------------------------

  /** Leave the lists for an Undo window. The host row still exists until the
   *  toast commits, so a refresh landing in between must not restore it. */
  hideForUndo(): void {
    this.#hiddenForUndo = true
  }

  /** Take the Undo back: the task is listed again and refreshes reach it. */
  restore(): void {
    this.#hiddenForUndo = false
    this.#file()
  }

  // --- Ingest -------------------------------------------------------------
  // Written by `TasksStore` as responses land.

  /**
   * Take a newly read row.
   *
   * Field by field, and only where the value actually changed. Most reads answer
   * with an unchanged task, and this is what keeps that from invalidating the
   * whole workspace — including the sidebar's pull request discovery inputs,
   * whose effect issued the read in the first place. An absent optional is
   * cleared rather than left standing: the row is authoritative about what it
   * omits.
   */
  hydrate(record: TaskRecord, serverId?: string): this {
    if (serverId) this.#serverId = serverId
    // A task inside its Undo window still exists on the host, so a refresh
    // landing here would otherwise put it straight back on screen.
    if (this.#hiddenForUndo) return this
    this.#known = true
    this.providerId = record.providerId
    this.shortId = record.shortId
    this.projectKey = record.projectKey
    this.kind = record.kind
    this.title = record.title
    this.titleSource = record.titleSource
    this.body = record.body
    this.status = record.status
    this.url = record.url
    this.assignee = record.assignee
    this.assigneeAvatarUrl = record.assigneeAvatarUrl
    this.parentId = record.parentId
    this.dueDate = record.dueDate
    this.priority = record.priority
    this.canEditPlanningFields = record.canEditPlanningFields
    this.source = record.source
    this.originSessionId = record.originSessionId
    this.originAutomationId = record.originAutomationId
    this.createdAt = record.createdAt
    this.updatedAt = record.updatedAt
    this.triagedAt = record.triagedAt
    this.doneAt = record.doneAt
    this.lastReadAt = record.lastReadAt
    // A `$state` write of an equal primitive notifies nobody, so only the
    // composite fields need a guard of their own — each read hands us a fresh
    // array or object whose identity would otherwise read as a change. `raw` is
    // the provider's own payload and is only ever re-parsed by the read that
    // replaced it, so its identity is the honest comparison.
    if (!sameMirroredTicket(this.mirroredTicket, record.mirroredTicket)) {
      this.mirroredTicket = record.mirroredTicket
    }
    if (!sameStrings(this.labels, record.labels)) this.labels = record.labels
    if (!sameStrings(this.childIds, record.childIds)) this.childIds = record.childIds
    if (!samePr(this.pr, record.pr)) this.pr = record.pr
    this.raw = record.raw
    this.#file()
    return this
  }

  /**
   * Take the place in the collection this task's own fields call for.
   *
   * A provider ticket read from the cross-host inbox arrives before anyone has
   * said which project owns it. It has nowhere to go yet, and the durable list
   * is not it — `placeIn` files it once the user picks.
   */
  #file(): void {
    if (this.isUpstream) {
      if (!this.projectKey) return
      const rows = this.#store.upstreamRowsFor(this.projectKey)
      if (!rows.some((row) => row.id === this.id)) rows.push(this)
      return
    }
    const listed = this.#store.tasks
    if (!listed.some((row) => row.id === this.id)) listed.push(this)
  }

  /** Leave the project's live provider list — this ticket has been imported or
   *  mirrored, and showing it beside the task it became is the same work twice. */
  forgetUpstreamRow(): void {
    if (!this.projectKey) return
    const rows = this.#store.upstreamRowsFor(this.projectKey)
    const index = rows.findIndex((row) => row.id === this.id)
    if (index >= 0) rows.splice(index, 1)
  }

  /** The equality guard matters as much as the write: a detail read answers
   *  with the same links most times, and a fresh array identity would invalidate
   *  the sidebar's pull request discovery inputs, whose effect issued the read. */
  applyPrLinks(links: TaskSidebarPrLink[]): void {
    if (!links.length && !this.#prLinks.length) return
    if (samePrLinks(this.#prLinks, links)) return
    this.#prLinks = links
  }

  /**
   * Take a detail payload: this task, its subtasks, its pull request links and
   * the detail itself.
   *
   * Session links are deliberately not part of this. A task's attempts are
   * written by the sidebar snapshot and the focused session-tree read and by
   * nothing else, so no surface can narrow them by opening a task.
   */
  applyDetails(details: TaskDetails): void {
    this.hydrate(details.task)
    this.applyPrLinks(prLinksOf(details))
    for (const subtask of details.subtasks) this.#store.get(subtask.id).hydrate(subtask)
    this.#details = details
  }
}

/** The sidebar's compact view of a detail read's pull request links. */
function prLinksOf(details: TaskDetails): TaskSidebarPrLink[] {
  return details.links
    .filter((link) => link.kind === 'pr' && Number.isSafeInteger(Number(link.targetKey)))
    .map((pr) => {
      const prLink: TaskSidebarPrLink = {
        number: Number(pr.targetKey),
        title: pr.liveTitle || pr.title,
        targetScope: pr.targetScope,
        createdBy: pr.createdBy,
      }
      if (pr.url) prLink.url = pr.url
      if (pr.originSessionId) prLink.originSessionId = pr.originSessionId
      return prLink
    })
}
