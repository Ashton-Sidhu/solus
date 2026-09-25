import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTicket,
  Task,
  TaskCandidateOptions,
  TaskDetails,
  TaskExternalLink,
  TaskSyncField,
  TicketPatch,
} from '@solus/contracts/task-types'
import { TASKS_AUTH_ERROR_PREFIX } from '@solus/contracts/task-types'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { sql } from 'drizzle-orm'
import { getDatabase } from '../db/database'
import { resourceOwner } from '../sharing/schema'
import { withCredentialScope } from '../vault/credential-scope'
import { taskLinks, tasks } from './schema'
import { createLogger } from '../logger'
import { loadProjectConfig } from '../project-config/project-config'
import { pullRequestIsMerged } from '../prs/code-host'
import { readTaskLinks, type PrLinkTarget } from './task-links'
import { taskSessions } from './task-sessions'
import { createTask, emitChanged } from './task-store'
import { Task as TaskModel } from './task'
import {
  dirtyCommentsForTask,
  acknowledgeExternalPush,
  externalLinkForTask,
  externalLinkForTicket,
  hasPendingSync,
  insertExternalComments,
  listExternalLinks,
  listExternalLinksForPoll,
  markCommentSynced,
  markExternalLinkError,
  notifyTaskSyncDirty,
  onTaskSyncDirty,
  updateExternalLinkAfterSync,
  writeExternalLink,
  writeTaskEpic,
  type ExternalLinkRecord,
} from './task-sync-store'
import { resolveTaskPublishTarget, taskSyncAdapter } from './adapters/registry'
import type { TaskSyncAdapter } from './adapters/types'
import { z } from 'zod'

const log = createLogger('main', 'task-sync')
const PUSH_DEBOUNCE_MS = 2_000

const ownerRowSchema = z.object({ owner_user_id: z.string() })

/** Whose credential a task's link syncs with: its owner's; null (the host's own) for the host owner or a task nobody claimed. */
async function taskOwnerCredentialUserId(organizationId: string, taskId: string): Promise<string | null> {
  const row = ownerRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT owner_user_id FROM ${resourceOwner}
    WHERE organization_id = ${organizationId} AND resource_kind = 'task' AND resource_id = ${taskId}
  `))
  const ownerUserId = row?.owner_user_id ?? null
  return ownerUserId === HOST_OWNER_USER_ID ? null : ownerUserId
}
const POLL_INTERVAL_MS = 5 * 60_000

export interface TaskSyncEngineOptions {
  adapterFor?: (provider: string) => TaskSyncAdapter
  now?: () => number
  pushDebounceMs?: number
}

/**
 * What the local status becomes when the ticket says `external`.
 *
 * The provider states its own fidelity through `statusKey`; the engine only
 * asks whether the two statuses are distinguishable there. Same key means the
 * upstream state is not evidence of a change, so local nuance the provider
 * cannot see — `inbox`, `in_review`, `dropped` — survives the read.
 */
function reconcileStatus(
  adapter: TaskSyncAdapter,
  external: Task['status'],
  local: Task['status'],
): Task['status'] {
  return adapter.statusKey(external) === adapter.statusKey(local) ? local : external
}

function refFor(link: TaskExternalLink): ExternalTicketRef {
  return {
    provider: link.provider,
    externalKey: link.externalKey,
    externalId: link.externalId,
    url: link.url,
  }
}

interface ProviderError {
  state: 'error' | 'auth_error'
  message: string
}

function providerError<Failure>(error: Failure): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const isAuth = message.startsWith(TASKS_AUTH_ERROR_PREFIX)
    || /not connected|bad credentials|reconnect|401|unauthorized|authorization.*invalid/i.test(message)
  return {
    state: isAuth ? 'auth_error' : 'error',
    message: message.replace(TASKS_AUTH_ERROR_PREFIX, ''),
  }
}

function patchForDirtyFields(
  adapter: TaskSyncAdapter,
  task: Task,
  link: TaskExternalLink,
): TicketPatch {
  const fields = new Set(link.dirtyFields.filter((field) => adapter.writableFields.has(field)))
  const patch: TicketPatch = {}
  if (fields.has('title')) patch.title = task.title
  if (fields.has('body')) patch.body = task.body
  if (fields.has('labels')) patch.labels = task.labels
  if (fields.has('status')) patch.status = task.status
  if (fields.has('priority')) patch.priority = task.priority ?? null
  if (fields.has('assignee')) patch.assignee = task.assignee ?? null
  return patch
}

/**
 * Which dirty fields this push settled, compared against the task as it stands
 * *now* — an edit made while the request was in flight must stay dirty.
 *
 * A field the provider cannot write is settled too: it was never going to land,
 * and holding it forever would show the user a pending change with nowhere to
 * go.
 */
function acknowledgedFields(
  adapter: TaskSyncAdapter,
  task: Task,
  link: TaskExternalLink,
  patch: TicketPatch,
): TaskSyncField[] {
  const fields = link.dirtyFields.filter((field) => !adapter.writableFields.has(field))
  if (patch.title !== undefined && patch.title === task.title) fields.push('title')
  if (patch.body !== undefined && patch.body === task.body) fields.push('body')
  if (patch.labels !== undefined && JSON.stringify(patch.labels) === JSON.stringify(task.labels)) fields.push('labels')
  if (patch.priority !== undefined && (patch.priority ?? null) === (task.priority ?? null)) fields.push('priority')
  if (patch.assignee !== undefined && (patch.assignee ?? null) === (task.assignee ?? null)) fields.push('assignee')
  // The provider may have stored a coarser status than we sent. That is not a
  // failed push, so ask the adapter whether the two are the same state to it.
  if (patch.status !== undefined && adapter.statusKey(patch.status) === adapter.statusKey(task.status)) {
    fields.push('status')
  }
  return fields
}

export class TaskSyncEngine {
  private readonly adapterFor: (provider: string) => TaskSyncAdapter
  private readonly now: () => number
  private readonly pushDebounceMs: number
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly syncs = new Map<string, Promise<TaskExternalLink | null>>()
  private readonly publishes = new Map<string, Promise<TaskDetails>>()
  /** When each bound scope was last polled in full, which is what the next
   *  poll's change window is measured from. Disposable: a restart simply makes
   *  the first poll a plain one. */
  private readonly polledAtByScope = new Map<string, number>()
  private unsubscribeDirty: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: TaskSyncEngineOptions = {}) {
    this.adapterFor = options.adapterFor ?? taskSyncAdapter
    this.now = options.now ?? Date.now
    this.pushDebounceMs = options.pushDebounceMs ?? PUSH_DEBOUNCE_MS
  }

  start(): void {
    if (this.unsubscribeDirty) return
    this.unsubscribeDirty = onTaskSyncDirty((organizationId, taskId) => this.schedulePush(organizationId, taskId))
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  stop(): void {
    this.unsubscribeDirty?.()
    this.unsubscribeDirty = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    for (const timer of this.pushTimers.values()) clearTimeout(timer)
    this.pushTimers.clear()
  }

  schedulePush(organizationId: string, taskId: string): void {
    const existing = this.pushTimers.get(taskId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pushTimers.delete(taskId)
      void this.syncTask(organizationId, taskId, { retryAuth: false })
    }, this.pushDebounceMs)
    timer.unref?.()
    this.pushTimers.set(taskId, timer)
  }

  pullSoon(organizationId: string, taskId: string): void {
    const timer = setTimeout(() => void this.syncTask(organizationId, taskId, { retryAuth: false }), 0)
    timer.unref?.()
  }

  async poll(): Promise<TaskExternalLink[]> {
    const links = await listExternalLinksForPoll()
    if (!links.length) return []
    const results: TaskExternalLink[] = []
    for (const record of await this.linksDueForPoll(links)) {
      const synced = await this.syncTask(record.organizationId, record.link.taskId, { retryAuth: false })
      if (synced) results.push(synced)
    }
    return results
  }

  /**
   * The links this poll has to touch, which on a quiet interval is none.
   *
   * A poll that asks the provider about every link costs one request per linked
   * task, forever, whether or not anything happened — the shape that stops
   * working somewhere in the low hundreds. Providers that can answer "what
   * changed since" for a whole scope in one query are asked that instead, and
   * only the answer is followed up.
   *
   * A link is still visited when it has never synced, has local work waiting, or
   * is in a failed state: none of those are questions about upstream, so no
   * upstream answer can settle them.
   */
  private async linksDueForPoll(records: ExternalLinkRecord[]): Promise<ExternalLinkRecord[]> {
    // One provider scope may be bound by several organizations; each is its own group.
    const byScope = new Map<string, ExternalLinkRecord[]>()
    for (const record of records) {
      const scope = `${record.organizationId}\0${record.link.provider}\0${record.link.externalKey}`
      const group = byScope.get(scope)
      if (group) group.push(record)
      else byScope.set(scope, [record])
    }

    const due: ExternalLinkRecord[] = []
    for (const [scope, group] of byScope) {
      const polledAt = this.now()
      const changed = await this.changedInScope(scope, group.map((record) => record.link))
      // Either way this scope has now been looked at in full: a change set names
      // everything that moved, and the fallback visits every link.
      this.polledAtByScope.set(scope, polledAt)
      if (!changed) {
        due.push(...group)
        continue
      }
      for (const record of group) {
        const link = record.link
        const mustVisit = link.lastSyncedAt == null
          || link.syncState !== 'ok'
          || await hasPendingSync(link.taskId)
        if (mustVisit || changed.has(link.externalId)) due.push(record)
      }
    }
    return due
  }

  /**
   * The change set for one scope, or null when it cannot be established — in
   * which case the caller asks about every link, exactly as it always did.
   *
   * The first poll of a run is deliberately one of those: with nothing to
   * measure a window from, the plain pass is both the correct answer and what
   * establishes the mark for every later poll.
   */
  private async changedInScope(
    scope: string,
    group: TaskExternalLink[],
  ): Promise<Set<string> | null> {
    const first = group[0]
    if (!first) return null
    const since = this.polledAtByScope.get(scope)
    if (since === undefined) return null
    let adapter: TaskSyncAdapter
    try {
      adapter = this.adapterFor(first.provider)
    } catch {
      return null
    }
    if (!adapter.changedSince) return null

    try {
      return await adapter.changedSince(
        { provider: first.provider, externalKey: first.externalKey },
        since,
      )
    } catch (error) {
      // Not fatal: the per-link pass below reaches the same provider and records
      // the real failure on each link, which is where the user can see it.
      log.warn('task_sync_delta_failed', {
        provider: first.provider,
        externalKey: first.externalKey,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async syncNow(organizationId: string, taskId?: string): Promise<TaskExternalLink[]> {
    const links = await listExternalLinks(organizationId, taskId)
    const results: TaskExternalLink[] = []
    for (const link of links) {
      const synced = await this.syncTask(organizationId, link.taskId, { retryAuth: true })
      if (synced) results.push(synced)
    }
    return results
  }

  async syncTask(
    organizationId: string,
    taskId: string,
    options: { retryAuth: boolean } = { retryAuth: true },
  ): Promise<TaskExternalLink | null> {
    const current = this.syncs.get(taskId)
    if (current) return current
    // A link is polled and pushed as the task's owner (cloud-service-model.md
    // §22): their Jira or GitHub connection, whoever or whatever asked for the sync.
    const pending = taskOwnerCredentialUserId(organizationId, taskId)
      .then((userId) => withCredentialScope(userId, () => this.performSync(organizationId, taskId, options)))
      .finally(() => {
        if (this.syncs.get(taskId) === pending) this.syncs.delete(taskId)
      })
    this.syncs.set(taskId, pending)
    return pending
  }

  private async performSync(
    organizationId: string,
    taskId: string,
    options: { retryAuth: boolean },
  ): Promise<TaskExternalLink | null> {
    const link = await externalLinkForTask(taskId)
    if (!link) return null
    const now = this.now()
    if (!options.retryAuth && link.syncState === 'auth_error') return link
    if (!options.retryAuth && link.retryAt && link.retryAt > now) return link

    try {
      const adapter = this.adapterFor(link.provider)
      const external = await adapter.fetchTicket(refFor(link))
      const epicChanged = await getDatabase().transaction((db) => writeTaskEpic(db, taskId, external.epic))
      const externalMoved = link.externalUpdatedAt !== null
        && link.externalUpdatedAt !== undefined
        && external.externalUpdatedAt !== link.externalUpdatedAt

      if (externalMoved) {
        await this.applyExternal(adapter, organizationId, taskId, external)
        return externalLinkForTask(taskId)
      }

      // Comments can arrive without a meaningful issue-field change. Import
      // them on every successful fetch; the external-id index makes this safe.
      const changedCommentCount = await getDatabase().transaction((db) =>
        insertExternalComments(db, organizationId, taskId, external.comments))

      let lastTicket = external
      const currentLink = (await externalLinkForTask(taskId))!
      let pushedPatch: TicketPatch = {}
      if (currentLink.dirtyFields.length) {
        const task = (await TaskModel.byId(organizationId, taskId)).record()
        pushedPatch = patchForDirtyFields(adapter, task, currentLink)
        // Every dirty field may be one this provider cannot write, which is a
        // settled push with no request to make.
        if (Object.keys(pushedPatch).length) {
          // `pushedPatch` stays the local truth, because acknowledgedFields
          // compares it against the task row to detect an edit that landed
          // mid-push. Only the sent copy carries provider asset URLs.
          const sentPatch = pushedPatch.body === undefined
            ? pushedPatch
            : { ...pushedPatch, body: await adapter.publishAssets(refFor(currentLink), pushedPatch.body) }
          lastTicket = await adapter.pushFields(refFor(currentLink), sentPatch)
        }
      }

      const dirtyComments = await dirtyCommentsForTask(taskId)
      for (const comment of dirtyComments) {
        // Assets go up before the text that references them, and the durable
        // comment keeps its `asset://` reference: only the posted body carries
        // the provider URL.
        const publishedBody = await adapter.publishAssets(refFor(currentLink), comment.body)
        const posted = await adapter.postComment(refFor(currentLink), publishedBody)
        await markCommentSynced(getDatabase(), comment.id, posted.externalId)
      }
      const currentTask = (await TaskModel.byId(organizationId, taskId)).record()
      await getDatabase().transaction((db) => acknowledgeExternalPush(
        db,
        taskId,
        lastTicket,
        acknowledgedFields(adapter, currentTask, currentLink, pushedPatch),
        now,
      ))
      const hasClientVisibleChange = changedCommentCount > 0
        || epicChanged
        || currentLink.dirtyFields.length > 0
        || dirtyComments.length > 0
        || currentLink.syncState !== 'ok'
      if (hasClientVisibleChange) emitChanged()
      return externalLinkForTask(taskId)
    } catch (error) {
      const classified = providerError(error)
      await getDatabase().transaction((db) => markExternalLinkError(db, taskId, classified.state, classified.message, now))
      emitChanged()
      log.warn('task_sync_failed', {
        taskId,
        provider: link.provider,
        state: classified.state,
        error: classified.message,
      })
      return externalLinkForTask(taskId)
    }
  }

  private async applyExternal(
    adapter: TaskSyncAdapter,
    organizationId: string,
    taskId: string,
    ticket: NormalizedTicket,
  ): Promise<void> {
    const task = await TaskModel.byId(organizationId, taskId)
    await task.update({
      title: ticket.title,
      body: ticket.body,
      labels: ticket.labels,
      priority: ticket.priorityHint ?? null,
      assignee: ticket.assignee ?? null,
      status: reconcileStatus(adapter, ticket.status, task.status),
    }, { actor: 'system' }, { markSyncDirty: false })
    await getDatabase().transaction(async (db) => {
      await insertExternalComments(db, organizationId, taskId, ticket.comments)
      await updateExternalLinkAfterSync(db, taskId, ticket, this.now())
    })
    emitChanged()
  }

  async listCandidates(cwd: string, options: TaskCandidateOptions = {}): Promise<CandidateTicket[]> {
    const target = await resolveTaskPublishTarget(cwd)
    return target ? target.adapter.listCandidates(target.ref, options) : []
  }

  async importTickets(organizationId: string, cwd: string, externalIds: string[]): Promise<TaskDetails[]> {
    const target = await resolveTaskPublishTarget(cwd)
    if (!target) throw new Error('This project has no task publish target.')
    const projectKey = cwd
    const uniqueIds = [...new Set(externalIds.map((id) => id.trim()).filter(Boolean))]
    const refs: ExternalTicketRef[] = await Promise.all(uniqueIds.map(async (externalId) => ({
      ...target.ref,
      externalId,
      url: await target.adapter.ticketUrl(target.ref, externalId),
    })))
    const tickets = await target.adapter.fetchTickets(refs)
    const imported: TaskDetails[] = []
    for (const ticket of tickets) {
      const existing = await externalLinkForTicket(organizationId, ticket)
      if (existing) {
        imported.push(await (await TaskModel.byId(organizationId, existing.taskId)).details())
        continue
      }
      const task = await createTask(organizationId, {
        projectKey,
        title: ticket.title,
        body: ticket.body,
        status: reconcileStatus(target.adapter, ticket.status, 'todo'),
        labels: ticket.labels,
        priority: ticket.priorityHint,
        assignee: ticket.assignee,
        source: 'import',
      })
      try {
        await getDatabase().transaction((db) => writeExternalLink(db, organizationId, task.id, ticket, this.now()))
        imported.push(await (await TaskModel.byId(organizationId, task.id)).details())
      } catch (error) {
        const winner = await externalLinkForTicket(organizationId, ticket)
        if (!winner) throw error
        await (await TaskModel.byId(organizationId, task.id)).delete()
        imported.push(await (await TaskModel.byId(organizationId, winner.taskId)).details())
      }
    }
    emitChanged()
    return imported
  }

  async publishTask(organizationId: string, taskId: string, cwd: string): Promise<TaskDetails> {
    const current = this.publishes.get(taskId)
    if (current) return current
    const pending = this.performPublish(organizationId, taskId, cwd).finally(() => {
      if (this.publishes.get(taskId) === pending) this.publishes.delete(taskId)
    })
    this.publishes.set(taskId, pending)
    return pending
  }

  private async performPublish(organizationId: string, taskId: string, cwd: string): Promise<TaskDetails> {
    const existing = await externalLinkForTask(taskId)
    if (existing) return (await TaskModel.byId(organizationId, taskId)).details()
    const target = await resolveTaskPublishTarget(cwd)
    if (!target) throw new Error('This project has no task publish target.')
    const task = (await TaskModel.byId(organizationId, taskId)).record()
    const ticket = await target.adapter.createTicket(target.ref, {
      title: task.title,
      body: task.body,
      labels: task.labels,
      status: task.status,
      priority: task.priority ?? null,
      assignee: task.assignee ?? null,
    })
    await getDatabase().transaction((db) => writeExternalLink(db, organizationId, taskId, ticket, this.now()))
    emitChanged()
    return (await TaskModel.byId(organizationId, taskId)).details()
  }
}

const engine = new TaskSyncEngine()

export function startTaskSyncEngine(): void {
  engine.start()
}

export function scheduleTaskPush(organizationId: string, taskId: string): void {
  notifyTaskSyncDirty(organizationId, taskId)
}

export function pullTaskSoon(organizationId: string, taskId: string): void {
  engine.pullSoon(organizationId, taskId)
}

export function syncTasksNow(organizationId: string, taskId?: string): Promise<TaskExternalLink[]> {
  return engine.syncNow(organizationId, taskId)
}

export function listTaskCandidates(cwd: string, options?: TaskCandidateOptions): Promise<CandidateTicket[]> {
  return engine.listCandidates(cwd, options)
}

export function importTaskTickets(organizationId: string, cwd: string, externalIds: string[]): Promise<TaskDetails[]> {
  return engine.importTickets(organizationId, cwd, externalIds)
}

export function publishTask(organizationId: string, taskId: string, cwd: string): Promise<TaskDetails> {
  return engine.publishTask(organizationId, taskId, cwd)
}

export interface MergedPullRequestCompletion {
  /** The host's `updatedAt` for the merged pull request. A task touched after
   *  it has been reopened or resumed on purpose; that newer decision wins until
   *  the pull request itself changes again. */
  mergedAt: string
  /** Whether a Solus session is still mid-turn. Work merged under a session
   *  that is still working is not finished yet; the next poll asks again. */
  isSessionBusy: (sessionId: string) => boolean
  isMerged?: (target: PrLinkTarget) => Promise<boolean>
}

/**
 * Finish the work a merged pull request finished.
 *
 * A task is done when every pull request it links is merged — not when it
 * happened to be sitting in review, which was the old rule and which never
 * matched the ordinary case of several tasks landing on one branch. The task's
 * status is not part of the question: work merged is work finished, whether or
 * not anybody moved a card first.
 *
 * The pull request named here is known merged, so only a task's *other* links
 * cost a read; one link, the common case, costs none. A link that cannot be
 * read leaves the task alone — see `pullRequestIsMerged`.
 *
 * This is the one place the rule lives. Called by the merge handler, which has
 * authoritative success, and by `PrReconciler` for a merge made outside Solus;
 * `tasks.invalidated` carries the answer to every client.
 */
export async function completeTasksForMergedPullRequest(
  organizationId: string,
  repositoryScope: string,
  number: number,
  completion: MergedPullRequestCompletion,
): Promise<string[]> {
  const isMerged = completion.isMerged ?? (({ projectScope, number: linked }) =>
    pullRequestIsMerged(projectScope, linked))
  const mergedAtMs = Date.parse(completion.mergedAt)
  const db = getDatabase()
  const rows = z.array(z.object({ id: z.string(), project_key: z.string().nullable(), updated_at: z.number() })).parse(await db.all(sql`
    SELECT DISTINCT tasks.id, tasks.project_key, tasks.updated_at
    FROM ${tasks}
    JOIN ${taskLinks} ON task_links.task_id = tasks.id
    WHERE tasks.organization_id = ${organizationId}
      AND tasks.status NOT IN ('done', 'dropped')
      AND task_links.kind = 'pr'
      AND task_links.target_key = ${String(number)}
      AND task_links.target_scope = ${repositoryScope}
  `))

  const completed: string[] = []
  for (const row of rows) {
    const config = row.project_key ? await loadProjectConfig(row.project_key) : null
    if (config?.taskDoneOnMerge === false) continue
    if (Number.isFinite(mergedAtMs) && row.updated_at > mergedAtMs) continue
    const working = ((await taskSessions(organizationId, row.id))[row.id] ?? []).filter((link) => link.role === 'working')
    if (working.some((link) => completion.isSessionBusy(link.sessionId))) continue
    const others = (await readTaskLinks(db, organizationId, row.id)).flatMap((link) => {
      if (link.kind !== 'pr') return []
      const linkedNumber = Number(link.targetKey)
      if (!Number.isSafeInteger(linkedNumber) || linkedNumber <= 0) return []
      if (linkedNumber === number && link.targetScope === repositoryScope) return []
      return [{ projectScope: link.targetScope, number: linkedNumber }]
    })
    let allMerged = true
    for (const other of others) {
      if (await isMerged(other)) continue
      allMerged = false
      break
    }
    if (!allMerged) continue
    await (await TaskModel.byId(organizationId, row.id)).update({ status: 'done' }, { actor: 'system' })
    completed.push(row.id)
  }
  return completed
}
