// One task, as this client can read and act on it.
//
// GitHub and Jira own every task (docs/plans/provider-owned-tasks.md). A host
// keeps a copy of it and the Solus attachments: session links, links to works,
// plans, automations and pull requests, and snoozes. There is **one of these
// per task key**, held in `TasksStore`'s index, so what one surface writes is
// what every other surface reads.
//
// `TaskRecord` is the same shape as the wire, and this class implements it — a
// Task *is* a task, so a surface reads `task.title`, not `task.record.title`.
// The fields are `$state`, so a snapshot that changes only `category` notifies
// only what reads `category`.
//
// Two kinds of host can know a task. The host that has the project reads the
// task from its provider: `serverId` names it, and every task read and write
// goes there. Any host can hold attachments of the task key, and the
// organization's Solus API holds only those. So the session links and the pull
// request links are kept per host and read merged.

import { SvelteMap } from 'svelte/reactivity'
import { taskSnoozesStore } from './task-snoozes.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import type {
  SessionExecutionHost,
  Task as TaskRecord,
  TaskAttachments,
  TaskDetails,
  TaskEpic,
  TaskField,
  TaskKind,
  TaskLink,
  TaskLinkInput,
  TaskLinkKind,
  TaskMoveTarget,
  TaskPlacement,
  TaskPr,
  TaskPriority,
  TaskProviderId,
  TaskSessionLink,
  TaskSidebarPrLink,
  TaskSnapshot,
  TaskState,
  TaskSummary,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import { sameEpic, samePlacements, samePr, samePrLinks, sameStrings } from './task-reconcile'
import { hostOfSessionLink, mergePrLinks, mergeSessionLinks } from './task-projects'
import type { TasksStore } from './tasks.store.svelte'

export class Task implements TaskRecord {
  // --- The task -----------------------------------------------------------
  // `TaskRecord`, field for field. Written only by `hydrate` and by a move
  // that waits for its host.

  readonly id: string
  providerId = $state<TaskProviderId>('github')
  kind = $state<TaskKind>('issue')
  reference = $state<string | undefined>()
  title = $state('')
  body = $state('')
  url = $state<string | null>(null)
  state = $state<TaskState>({ name: '', category: 'open' })
  category = $state<TaskStatusCategory>('open')
  placements = $state<TaskPlacement[]>([])
  assignee = $state<string | undefined>()
  assigneeAvatarUrl = $state<string | undefined>()
  labels = $state<string[]>([])
  epic = $state<TaskEpic | undefined>()
  dueDate = $state<string | undefined>()
  priority = $state<TaskPriority | undefined>()
  pr = $state<TaskPr | undefined>()
  writableFields = $state<TaskField[]>([])
  createdAt = $state<number | undefined>()
  updatedAt = $state(0)
  lastReadAt = $state<number | undefined>()

  // --- What this client knows besides the row -----------------------------

  readonly #store: TasksStore

  /** Whether any host has described this task yet. `TasksStore.get` mints a task
   *  on first mention — a deep link, a session link from a host that holds only
   *  attachments — so the fields above are defaults until this is true. */
  #known = $state(false)

  /** The host that reads this task from its provider. Null until a host
   *  describes the task. */
  #serverId = $state<string | null>(null)

  #details = $state<TaskDetails | null>(null)
  /** Session links, by the host that holds them. */
  #sessionsByHost = new SvelteMap<string, TaskSessionLink[]>()
  /** Pull request links, by the host that holds them. */
  #prLinksByHost = new SvelteMap<string, TaskSidebarPrLink[]>()
  /** The host that holds each link of `details.links` that another host than
   *  `serverId` answered, so an unlink goes back to that host. */
  #attachmentHosts = new Map<string, string>()
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

  /** True once a host has described this task. A task minted for a key nobody
   *  has listed reads as an empty task until then. */
  get isKnown(): boolean {
    return this.#known
  }

  get serverId(): string | null {
    return this.#serverId
  }

  set serverId(serverId: string | null) {
    this.#serverId = serverId
  }

  /** Hidden while its Undo toast is up. The draft still exists on the provider
   *  until the toast commits, so a refresh landing in that window must not put
   *  it back. */
  get hiddenForUndo(): boolean {
    return this.#hiddenForUndo
  }

  /** Comments, links and activity. Null until a detail surface has opened it;
   *  the sidebar row carries none of it. */
  get details(): TaskDetails | null {
    return this.#details
  }

  /** This task's session links from every host that holds one, newest first. */
  readonly sessions: TaskSessionLink[] = $derived(
    mergeSessionLinks(this.#sessionsByHost, this.#hostOrder()),
  )

  /** Every durable pull request link, newest first. The task's own captured
   *  pull request answers when no host listed a link. */
  readonly prLinks: TaskSidebarPrLink[] = $derived.by(() => {
    const links = mergePrLinks(this.#prLinksByHost, this.#hostOrder())
    if (links.length) return links
    return this.pr ? [{ number: this.pr.number, url: this.pr.url }] : []
  })

  /** The newest durable linked pull request, for callers that need only one. */
  get prLink(): TaskSidebarPrLink | null {
    return this.prLinks[0] ?? null
  }

  /** True while a visible surface is rendering this task's detail. */
  get isDetailWatched(): boolean {
    return this.#watchCount > 0
  }

  /** Whether the provider takes a change of this field for this task. */
  canWrite(field: TaskField): boolean {
    return this.writableFields.includes(field)
  }

  /** Only a draft item of a GitHub Project can be deleted. An issue is closed
   *  or moved on its provider. */
  get canDelete(): boolean {
    return this.#known && this.kind === 'draft'
  }

  /** The host that reads the task first, then the others in catalog order. */
  #hostOrder(): string[] {
    const order = serverConnections.connectedServerIds()
    return this.#serverId ? [this.#serverId, ...order.filter((serverId) => serverId !== this.#serverId)] : order
  }

  /** The RPC surface of the host that reads this task from its provider. */
  get #api(): HostApi {
    const serverId = this.#serverId ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  // --- Reads --------------------------------------------------------------

  /**
   * Resolve the host that reads this task, trying harder than `serverId`: an
   * outbox op can name a task this client has never listed (recorded by an agent
   * on a borrowed machine), so an unplaced key is asked of every connected host
   * that runs projects before giving up. Undefined means "no connected host has
   * it" — the op stays pending, which is a reported state, not a failure.
   */
  async ownerHost(): Promise<string | undefined> {
    if (this.#serverId) return this.#serverId
    await this.#store.ensureLoaded()
    if (this.#serverId) return this.#serverId
    for (const serverId of this.#store.taskReadHosts()) {
      try {
        const details = await serverConnections.apiFor(serverId).tasksGet(this.id)
        if (details?.task) {
          this.hydrate(details.task, serverId)
          return serverId
        }
      } catch {
        // This host does not have the task.
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

  /**
   * The detail read behind the task page: the task from its provider, with its
   * comments, links and activity. A host that holds session links of this task
   * but does not read it (the organization's Solus API) adds its links and
   * activity.
   */
  loadDetails(): Promise<TaskDetails> {
    if (this.#detailLoad) return this.#detailLoad
    const load = (async () => {
      const serverId = await this.ownerHost()
      if (!serverId) throw new Error('No connected host has this task.')
      const [details, others] = await Promise.all([
        serverConnections.apiFor(serverId).tasksGet(this.id),
        this.#readOtherAttachments(serverId),
      ])
      this.#attachmentHosts.clear()
      for (const { serverId: otherServerId, attachments } of others) {
        for (const link of attachments.links) {
          const key = attachmentKey(link)
          if (details.links.some((held) => attachmentKey(held) === key)) continue
          details.links.push(link)
          this.#attachmentHosts.set(key, otherServerId)
        }
        const activityIds = new Set(details.activity.map((activity) => activity.id))
        for (const activity of attachments.activity) {
          if (!activityIds.has(activity.id)) details.activity.push(activity)
        }
      }
      if (others.length) details.activity.sort((a, b) => a.at - b.at)
      this.applyDetails(details)
      return details
    })().finally(() => {
      if (this.#detailLoad === load) this.#detailLoad = null
    })
    this.#detailLoad = load
    return load
  }

  async #readOtherAttachments(readServerId: string): Promise<Array<{ serverId: string; attachments: TaskAttachments }>> {
    const serverIds = [...this.#sessionsByHost.keys()].filter((serverId) => serverId !== readServerId)
    const answers = await Promise.all(serverIds.map(async (serverId) => {
      try {
        return { serverId, attachments: await serverConnections.apiFor(serverId).tasksAttachments(this.id) }
      } catch {
        // The task page still shows the task; that host's links come with the next read.
        return null
      }
    }))
    return answers.filter((answer) => answer !== null)
  }

  // --- Writes -------------------------------------------------------------
  // A write goes to the provider first. When it fails the caller gets the
  // error and the task keeps its old value: there is no queue of changes.

  /**
   * Move the task to a column of one source, or to a status category, where
   * the host chooses the column of each source.
   *
   * The card moves on this frame, so a drag does not snap back while the
   * provider answers. A refused move puts it back and rethrows.
   */
  async move(target: TaskMoveTarget): Promise<this> {
    const previousCategory = this.category
    const placement = 'sourceKey' in target
      ? this.placements.find((held) => held.sourceKey === target.sourceKey)
      : undefined
    const previousColumnId = placement?.columnId
    if ('category' in target) this.category = target.category
    else if (placement) placement.columnId = target.columnId
    try {
      this.hydrate(await this.#api.tasksMove(this.id, target))
    } catch (error) {
      this.category = previousCategory
      if (placement && previousColumnId !== undefined) placement.columnId = previousColumnId
      throw error
    }
    return this
  }

  async update(patch: TaskUpdatePatch): Promise<this> {
    this.hydrate(await this.#api.tasksUpdate(this.id, patch))
    return this
  }

  async markRead(read: boolean): Promise<this> {
    this.hydrate(await this.#api.tasksMarkRead(this.id, read))
    return this
  }

  /** The reader's own snooze: their lists hide the task until then. It is
   *  not part of the task record; each person's host answers their own. */
  get snoozedUntil(): number | undefined {
    return taskSnoozesStore.get(this.id)?.snoozedUntil
  }

  get snoozeNote(): string | undefined {
    return taskSnoozesStore.get(this.id)?.snoozeNote
  }

  /** Hide the task from the reader's task lists until `until`, or wake it now
   *  with null. Nobody else's lists change, and its agents keep working. */
  async snooze(until: number | null, note = ''): Promise<this> {
    const serverId = await this.ownerHost()
    if (!serverId) throw new Error('No connected host has this task.')
    await taskSnoozesStore.snooze(serverId, this.id, until, note)
    return this
  }

  /** Delete a draft item from its GitHub Project. The host refuses an issue. */
  async delete(): Promise<void> {
    await this.#api.tasksDelete(this.id)
  }

  /** Post a comment to the provider. A comment the provider did not take comes
   *  back in the details as `unsent`, with its error. */
  async comment(body: string): Promise<this> {
    this.applyDetails(await this.#api.tasksComment(this.id, body))
    return this
  }

  /** Send an unsent comment again. */
  async retryComment(commentId: string): Promise<void> {
    this.applyDetails(await this.#api.tasksRetryComment(this.id, commentId))
  }

  /** Discard an unsent comment. */
  async discardComment(commentId: string): Promise<void> {
    this.applyDetails(await this.#api.tasksDeleteComment(this.id, commentId))
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
   * Link a started session to this task. A session link is an attachment: it
   * needs only the task key, so the host that files it can be another one than
   * the host that reads the task.
   *
   * The bind prepares before the prompt and the durable link follows
   * `session_init`. A dispatch can involve different machines, and the
   * execution machine is the one fact neither host can work out for itself, so
   * the client states it in `execution`. `execution` is null for a run that
   * stayed on the host that files the link.
   *
   * `serverId` names the host that files the link. Absent, it is the host that
   * reads the task.
   */
  async linkSession(
    sessionId: string,
    execution: SessionExecutionHost | null,
    serverId?: string,
  ): Promise<void> {
    const api = serverId ? serverConnections.apiFor(serverId) : this.#api
    await api.tasksLinkSession(this.id, sessionId, 'working', execution)
  }

  /** Attach a doc, plan, pull request or automation to this task. */
  async link(input: TaskLinkInput): Promise<void> {
    this.#applyAttachments(this.#serverId, await this.#api.tasksLink(this.id, input))
    this.#store.noteLinked(
      { kind: input.kind, targetScope: input.targetScope ?? '', targetKey: input.targetKey },
      this,
    )
  }

  async unlink(kind: TaskLinkKind, targetKey: string, targetScope = ''): Promise<void> {
    const heldBy = this.#attachmentHosts.get(attachmentKey({ kind, targetScope, targetKey }))
    const api = heldBy ? serverConnections.apiFor(heldBy) : this.#api
    this.#applyAttachments(heldBy ?? this.#serverId, await api.tasksUnlink(this.id, kind, targetKey, targetScope))
    this.#store.noteUnlinked({ kind, targetScope, targetKey }, this.id)
  }

  /** Post a linked artifact's still (and its HTML, where the provider takes
   *  files) as a comment on the task. The host renders the still. */
  async attachArtifact(workId: string): Promise<void> {
    this.applyDetails(await this.#api.tasksAttachArtifact(this.id, workId))
  }

  /**
   * Take one host's links after a link or an unlink on it. The links that
   * other hosts hold stay; the detail read is what brings them all together
   * again.
   */
  #applyAttachments(serverId: string | null, attachments: TaskAttachments): void {
    const details = this.#details
    if (!details) return
    const fromOtherHosts = details.links.filter((link) => {
      const heldBy = this.#attachmentHosts.get(attachmentKey(link)) ?? this.#serverId
      return heldBy !== serverId
    })
    for (const key of this.#attachmentHosts.keys()) {
      if (this.#attachmentHosts.get(key) === serverId) this.#attachmentHosts.delete(key)
    }
    if (serverId && serverId !== this.#serverId) {
      for (const link of attachments.links) this.#attachmentHosts.set(attachmentKey(link), serverId)
    }
    details.links = [...attachments.links, ...fromOtherHosts]
    if (serverId === this.#serverId) {
      details.activity = attachments.activity
      this.#applyDetailPrLinks(details)
    }
  }

  // --- Sessions -----------------------------------------------------------

  /**
   * Expose the link on the session-init frame while the authoritative
   * task-session read is still in flight. The host has already persisted this
   * association; the optimistic entry lets every task surface show live work
   * immediately and is replaced by the next authoritative sidebar snapshot.
   *
   * The display fields are genuinely unknown here rather than merely omitted:
   * the session has not reached the index yet, and a just-started session is
   * always mounted, so every surface names it from its live tab regardless.
   *
   * `serverId` names the host that filed the link.
   */
  trackSessionStart(sessionId: string, serverId?: string): void {
    this.bindSession(sessionId)
    if (this.sessions.some((link) => link.sessionId === sessionId)) return
    const heldBy = serverId ?? this.#serverId ?? serverConnections.defaultServerId()
    if (!heldBy) return
    this.#sessionsByHost.set(heldBy, [...(this.#sessionsByHost.get(heldBy) ?? []), {
      taskId: this.id,
      sessionId,
      sessionTitle: null,
      provider: null,
      model: null,
      startedAt: Date.now(),
      lastActivityAt: null,
      linkedAt: Date.now(),
    }])
  }

  /**
   * Record an authoritative session link that one host answered.
   *
   * Overwrite rather than skip: the entry already here may be the optimistic one
   * from `trackSessionStart`, which carries no display metadata. A read that
   * names the session is authoritative, so it upgrades in place.
   */
  applySessionLink(serverId: string, link: TaskSessionLink): void {
    // A new array each time: the map notifies on `set`, not on a change inside
    // a list it holds. One task has few session links.
    const held = this.#sessionsByHost.get(serverId) ?? []
    const index = held.findIndex((existing) => existing.sessionId === link.sessionId)
    this.#sessionsByHost.set(serverId, index === -1 ? [...held, link] : held.with(index, link))
    // A `referenced` session is listed but the task does not own it.
    if (link.role !== 'referenced') this.bindSession(link.sessionId)
  }

  /** Claim a session for this task in the store's session index, which is what
   *  `taskForSession` answers from. The link itself is in `sessions`. */
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
   * Detach a session from this task, on the host that holds the link. The link
   * goes on this frame so every mounted surface drops it now; the next
   * authoritative snapshot agrees rather than restores it.
   */
  async unlinkSession(sessionId: string): Promise<void> {
    const heldBy = hostOfSessionLink(this.#sessionsByHost, this.#hostOrder(), sessionId)
    const api = heldBy ? serverConnections.apiFor(heldBy) : this.#api
    await api.tasksUnlinkSession(this.id, sessionId)
    for (const [serverId, held] of this.#sessionsByHost) {
      if (!held.some((link) => link.sessionId === sessionId)) continue
      const kept = held.filter((link) => link.sessionId !== sessionId)
      if (kept.length) this.#sessionsByHost.set(serverId, kept)
      else this.#sessionsByHost.delete(serverId)
    }
    this.unbindSession(sessionId)
  }

  /** Take the session links and the pull request links that one host holds
   *  for this task. An empty answer forgets that host. */
  applyHostAttachments(serverId: string, sessions: TaskSessionLink[], prLinks: TaskSidebarPrLink[]): void {
    for (const link of this.#sessionsByHost.get(serverId) ?? []) this.unbindSession(link.sessionId)
    if (sessions.length) this.#sessionsByHost.set(serverId, sessions)
    else this.#sessionsByHost.delete(serverId)
    // The equality guard matters as much as the write: most reads answer with
    // the same links, and a fresh array identity would invalidate the sidebar's
    // pull request discovery inputs, whose effect issued the read.
    const heldPrLinks = this.#prLinksByHost.get(serverId)
    if (!prLinks.length) {
      if (heldPrLinks) this.#prLinksByHost.delete(serverId)
    } else if (!samePrLinks(heldPrLinks, prLinks)) {
      this.#prLinksByHost.set(serverId, prLinks)
    }
    for (const link of this.sessions) {
      if (link.role !== 'referenced') this.bindSession(link.sessionId)
    }
  }

  /** Whether a host holds a session link or a pull request link of this task. */
  hasAttachmentsOn(serverId: string): boolean {
    return this.#sessionsByHost.has(serverId) || this.#prLinksByHost.has(serverId)
  }

  // --- Undo ---------------------------------------------------------------

  /** Leave the lists for an Undo window. The draft still exists until the
   *  toast commits, so a refresh landing in between must not restore it. */
  hideForUndo(): void {
    this.#hiddenForUndo = true
  }

  /** Take the Undo back: the task is listed again and refreshes reach it. */
  restore(): void {
    this.#hiddenForUndo = false
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
   * omits — except a list row (`TaskSummary`), which never carries the body or
   * the epic; only a full record speaks for those.
   *
   * `serverId` names the host that read the task from its provider.
   */
  hydrate(record: TaskRecord | TaskSummary, serverId?: string): this {
    if (serverId) this.#serverId = serverId
    // A draft inside its Undo window still exists on the provider, so a refresh
    // landing here would otherwise put it straight back on screen.
    if (this.#hiddenForUndo) return this
    if (!this.#known) {
      this.#known = true
      this.#store.noteTaskKnown()
    }
    this.providerId = record.providerId
    this.kind = record.kind
    this.reference = record.reference
    this.title = record.title
    if ('body' in record) {
      this.body = record.body
      if (!sameEpic(this.epic, record.epic)) this.epic = record.epic
    }
    this.url = record.url
    this.category = record.category
    this.assignee = record.assignee
    this.assigneeAvatarUrl = record.assigneeAvatarUrl
    this.dueDate = record.dueDate
    this.priority = record.priority
    this.createdAt = record.createdAt
    this.updatedAt = record.updatedAt
    this.lastReadAt = record.lastReadAt
    // A `$state` write of an equal primitive notifies nobody, so only the
    // composite fields need a guard of their own — each read hands us a fresh
    // array or object whose identity would otherwise read as a change.
    if (this.state.name !== record.state.name || this.state.category !== record.state.category) {
      this.state = record.state
    }
    if (!samePlacements(this.placements, record.placements)) this.placements = record.placements
    if (!sameStrings(this.labels, record.labels)) this.labels = record.labels
    if (!sameStrings(this.writableFields, record.writableFields)) this.writableFields = record.writableFields
    if (!samePr(this.pr, record.pr)) this.pr = record.pr
    return this
  }

  /**
   * Take a detail payload from the host that reads this task: the task, its
   * pull request links on that host and the detail itself.
   *
   * Session links are deliberately not part of this. A task's session links
   * are written by the sidebar snapshot and the focused session read and by
   * nothing else, so no surface can narrow them by opening a task.
   */
  applyDetails(details: TaskDetails): void {
    this.hydrate(details.task)
    this.#details = details
    this.#applyDetailPrLinks(details)
  }

  #applyDetailPrLinks(details: TaskDetails): void {
    const serverId = this.#serverId
    if (!serverId) return
    const held = this.#prLinksByHost.get(serverId) ?? []
    const links = prLinksOf(details, this.#attachmentHosts).map((link) => ({
      ...link,
      snapshot: held.find((current) => current.number === link.number
        && current.targetScope === link.targetScope)?.snapshot,
    }))
    if (!links.length) {
      if (held.length) this.#prLinksByHost.delete(serverId)
    } else if (!samePrLinks(held, links)) {
      this.#prLinksByHost.set(serverId, links)
    }
  }
}

/** The identity of a link on one task (`TaskLink` identity). */
function attachmentKey(link: Pick<TaskLink, 'kind' | 'targetScope' | 'targetKey'>): string {
  return `${link.kind}:${link.targetScope}:${link.targetKey}`
}

/** The sidebar's compact view of the pull request links that the task's own
 *  host answered in a detail read. */
function prLinksOf(details: TaskDetails, attachmentHosts: ReadonlyMap<string, string>): TaskSidebarPrLink[] {
  return details.links
    .filter((link) => link.kind === 'pr'
      && Number.isSafeInteger(Number(link.targetKey))
      && !attachmentHosts.has(attachmentKey(link)))
    .map((pr) => {
      const prLink: TaskSidebarPrLink = {
        number: Number(pr.targetKey),
        title: pr.liveTitle || pr.title,
        targetScope: pr.targetScope,
        createdBy: pr.createdBy,
      }
      if (pr.url) prLink.url = pr.url
      if (pr.originSessionId) prLink.originSessionId = pr.originSessionId
      if (pr.ownerSessionId) prLink.ownerSessionId = pr.ownerSessionId
      return prLink
    })
}
