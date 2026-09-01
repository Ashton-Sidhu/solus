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
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { loadProjectConfig } from '../project-config/project-config'
import { pullRequestIsMerged } from '../prs/code-host'
import { readTaskLinks, type PrLinkTarget } from './task-links'
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
  markCommentSynced,
  markExternalLinkError,
  notifyTaskSyncDirty,
  onTaskSyncDirty,
  updateExternalLinkAfterSync,
  writeExternalLink,
} from './task-sync-store'
import { resolveTaskPublishTarget, taskSyncAdapter } from './adapters/registry'
import type { TaskSyncAdapter } from './adapters/types'
import { z } from 'zod'

const log = createLogger('main', 'task-sync')
const PUSH_DEBOUNCE_MS = 2_000
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
    this.unsubscribeDirty = onTaskSyncDirty((taskId) => this.schedulePush(taskId))
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

  schedulePush(taskId: string): void {
    const existing = this.pushTimers.get(taskId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pushTimers.delete(taskId)
      void this.syncTask(taskId, { retryAuth: false })
    }, this.pushDebounceMs)
    timer.unref?.()
    this.pushTimers.set(taskId, timer)
  }

  pullSoon(taskId: string): void {
    const timer = setTimeout(() => void this.syncTask(taskId, { retryAuth: false }), 0)
    timer.unref?.()
  }

  async poll(): Promise<TaskExternalLink[]> {
    const links = listExternalLinks()
    if (!links.length) return []
    const results: TaskExternalLink[] = []
    for (const link of await this.linksDueForPoll(links)) {
      const synced = await this.syncTask(link.taskId, { retryAuth: false })
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
  private async linksDueForPoll(links: TaskExternalLink[]): Promise<TaskExternalLink[]> {
    const byScope = new Map<string, TaskExternalLink[]>()
    for (const link of links) {
      const scope = `${link.provider}\0${link.externalKey}`
      const group = byScope.get(scope)
      if (group) group.push(link)
      else byScope.set(scope, [link])
    }

    const due: TaskExternalLink[] = []
    for (const [scope, group] of byScope) {
      const polledAt = this.now()
      const changed = await this.changedInScope(scope, group)
      // Either way this scope has now been looked at in full: a change set names
      // everything that moved, and the fallback visits every link.
      this.polledAtByScope.set(scope, polledAt)
      if (!changed) {
        due.push(...group)
        continue
      }
      for (const link of group) {
        const mustVisit = link.lastSyncedAt == null
          || link.syncState !== 'ok'
          || hasPendingSync(link.taskId)
        if (mustVisit || changed.has(link.externalId)) due.push(link)
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

  async syncNow(taskId?: string): Promise<TaskExternalLink[]> {
    const links = listExternalLinks(taskId)
    const results: TaskExternalLink[] = []
    for (const link of links) {
      const synced = await this.syncTask(link.taskId, { retryAuth: true })
      if (synced) results.push(synced)
    }
    return results
  }

  async syncTask(
    taskId: string,
    options: { retryAuth: boolean } = { retryAuth: true },
  ): Promise<TaskExternalLink | null> {
    const current = this.syncs.get(taskId)
    if (current) return current
    const pending = this.performSync(taskId, options).finally(() => {
      if (this.syncs.get(taskId) === pending) this.syncs.delete(taskId)
    })
    this.syncs.set(taskId, pending)
    return pending
  }

  private async performSync(
    taskId: string,
    options: { retryAuth: boolean },
  ): Promise<TaskExternalLink | null> {
    const link = externalLinkForTask(taskId)
    if (!link) return null
    const now = this.now()
    if (!options.retryAuth && link.syncState === 'auth_error') return link
    if (!options.retryAuth && link.retryAt && link.retryAt > now) return link

    try {
      const adapter = this.adapterFor(link.provider)
      const external = await adapter.fetchTicket(refFor(link))
      const externalMoved = link.externalUpdatedAt !== null
        && link.externalUpdatedAt !== undefined
        && external.externalUpdatedAt !== link.externalUpdatedAt

      if (externalMoved) {
        await this.applyExternal(adapter, taskId, external)
        return externalLinkForTask(taskId)
      }

      // Comments can arrive without a meaningful issue-field change. Import
      // them on every successful fetch; the external-id index makes this safe.
      const changedCommentCount = withTx(() => insertExternalComments(getDb(), taskId, external.comments))

      let lastTicket = external
      const currentLink = externalLinkForTask(taskId)!
      let pushedPatch: TicketPatch = {}
      if (currentLink.dirtyFields.length) {
        const task = (await TaskModel.byId(taskId)).record()
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

      const dirtyComments = dirtyCommentsForTask(taskId)
      for (const comment of dirtyComments) {
        // Assets go up before the text that references them, and the durable
        // comment keeps its `asset://` reference: only the posted body carries
        // the provider URL.
        const publishedBody = await adapter.publishAssets(refFor(currentLink), comment.body)
        const posted = await adapter.postComment(refFor(currentLink), publishedBody)
        withTx(() => markCommentSynced(getDb(), comment.id, posted.externalId))
      }
      const currentTask = (await TaskModel.byId(taskId)).record()
      withTx(() => acknowledgeExternalPush(
        getDb(),
        taskId,
        lastTicket,
        acknowledgedFields(adapter, currentTask, currentLink, pushedPatch),
        now,
      ))
      const hasClientVisibleChange = changedCommentCount > 0
        || currentLink.dirtyFields.length > 0
        || dirtyComments.length > 0
        || currentLink.syncState !== 'ok'
      if (hasClientVisibleChange) emitChanged()
      return externalLinkForTask(taskId)
    } catch (error) {
      const classified = providerError(error)
      withTx(() => markExternalLinkError(getDb(), taskId, classified.state, classified.message, now))
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
    taskId: string,
    ticket: NormalizedTicket,
  ): Promise<void> {
    const task = await TaskModel.byId(taskId)
    await task.update({
      title: ticket.title,
      body: ticket.body,
      labels: ticket.labels,
      priority: ticket.priorityHint ?? null,
      status: reconcileStatus(adapter, ticket.status, task.status),
    }, { actor: 'system' }, { markSyncDirty: false })
    withTx(() => {
      insertExternalComments(getDb(), taskId, ticket.comments)
      updateExternalLinkAfterSync(getDb(), taskId, ticket, this.now())
    })
    emitChanged()
  }

  async listCandidates(cwd: string, options: TaskCandidateOptions = {}): Promise<CandidateTicket[]> {
    const target = await resolveTaskPublishTarget(cwd)
    return target ? target.adapter.listCandidates(target.ref, options) : []
  }

  async importTickets(cwd: string, externalIds: string[]): Promise<TaskDetails[]> {
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
      const existing = externalLinkForTicket(ticket)
      if (existing) {
        imported.push(await (await TaskModel.byId(existing.taskId)).details())
        continue
      }
      const task = await createTask({
        projectKey,
        title: ticket.title,
        body: ticket.body,
        status: reconcileStatus(target.adapter, ticket.status, 'todo'),
        labels: ticket.labels,
        priority: ticket.priorityHint,
        source: 'import',
      })
      try {
        withTx(() => writeExternalLink(getDb(), task.id, ticket, this.now()))
        imported.push(await (await TaskModel.byId(task.id)).details())
      } catch (error) {
        const winner = externalLinkForTicket(ticket)
        if (!winner) throw error
        await (await TaskModel.byId(task.id)).delete()
        imported.push(await (await TaskModel.byId(winner.taskId)).details())
      }
    }
    emitChanged()
    return imported
  }

  async publishTask(taskId: string, cwd: string): Promise<TaskDetails> {
    const current = this.publishes.get(taskId)
    if (current) return current
    const pending = this.performPublish(taskId, cwd).finally(() => {
      if (this.publishes.get(taskId) === pending) this.publishes.delete(taskId)
    })
    this.publishes.set(taskId, pending)
    return pending
  }

  private async performPublish(taskId: string, cwd: string): Promise<TaskDetails> {
    const existing = externalLinkForTask(taskId)
    if (existing) return (await TaskModel.byId(taskId)).details()
    const target = await resolveTaskPublishTarget(cwd)
    if (!target) throw new Error('This project has no task publish target.')
    const task = (await TaskModel.byId(taskId)).record()
    const ticket = await target.adapter.createTicket(target.ref, {
      title: task.title,
      body: task.body,
      labels: task.labels,
      status: task.status,
      priority: task.priority ?? null,
    })
    withTx(() => writeExternalLink(getDb(), taskId, ticket, this.now()))
    emitChanged()
    return (await TaskModel.byId(taskId)).details()
  }
}

const engine = new TaskSyncEngine()

export function startTaskSyncEngine(): void {
  engine.start()
}

export function scheduleTaskPush(taskId: string): void {
  notifyTaskSyncDirty(taskId)
}

export function pullTaskSoon(taskId: string): void {
  engine.pullSoon(taskId)
}

export function syncTasksNow(taskId?: string): Promise<TaskExternalLink[]> {
  return engine.syncNow(taskId)
}

export function listTaskCandidates(cwd: string, options?: TaskCandidateOptions): Promise<CandidateTicket[]> {
  return engine.listCandidates(cwd, options)
}

export function importTaskTickets(cwd: string, externalIds: string[]): Promise<TaskDetails[]> {
  return engine.importTickets(cwd, externalIds)
}

export function publishTask(taskId: string, cwd: string): Promise<TaskDetails> {
  return engine.publishTask(taskId, cwd)
}

export function taskHasPendingSync(taskId: string): boolean {
  return hasPendingSync(taskId, getDb())
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
 * Called by the merge handler, which has authoritative success, and by
 * `PrReconciler` for a merge made outside Solus.
 */
export async function completeTasksForMergedPullRequest(
  cwd: string,
  number: number,
  isMerged: (target: PrLinkTarget) => Promise<boolean> = ({ projectScope, number: linked }) =>
    pullRequestIsMerged(projectScope, linked),
): Promise<string[]> {
  const config = await loadProjectConfig(cwd)
  if (config?.taskDoneOnMerge === false) return []
  const db = getDb()
  const rows = z.array(z.object({ id: z.string() })).parse(db.prepare(`
    SELECT DISTINCT tasks.id
    FROM tasks
    JOIN task_links ON task_links.task_id = tasks.id
    WHERE tasks.status NOT IN ('done', 'dropped')
      AND task_links.kind = 'pr'
      AND task_links.target_key = ?
      AND task_links.target_scope = ?
  `).all(String(number), cwd))

  const completed: string[] = []
  for (const row of rows) {
    const others = readTaskLinks(db, row.id).flatMap((link) => {
      if (link.kind !== 'pr') return []
      const linkedNumber = Number(link.targetKey)
      if (!Number.isSafeInteger(linkedNumber) || linkedNumber <= 0) return []
      if (linkedNumber === number && link.targetScope === cwd) return []
      return [{ projectScope: link.targetScope, number: linkedNumber }]
    })
    let allMerged = true
    for (const other of others) {
      if (await isMerged(other)) continue
      allMerged = false
      break
    }
    if (!allMerged) continue
    await (await TaskModel.byId(row.id)).update({ status: 'done' }, { actor: 'system' })
    completed.push(row.id)
  }
  return completed
}
