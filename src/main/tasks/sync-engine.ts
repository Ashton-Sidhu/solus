import type {
  CandidateTicket,
  ExternalTaskStatus,
  ExternalTicketRef,
  NormalizedTicket,
  Task,
  TaskCandidateOptions,
  TaskDetails,
  TaskExternalLink,
  TicketPatch,
} from '../../shared/task-types'
import { TASKS_AUTH_ERROR_PREFIX } from '../../shared/task-types'
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { loadProjectConfig } from '../project-config/project-config'
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

const log = createLogger('main', 'task-sync')
const PUSH_DEBOUNCE_MS = 2_000
const POLL_INTERVAL_MS = 5 * 60_000

export interface TaskSyncEngineOptions {
  adapterFor?: (provider: string) => TaskSyncAdapter
  now?: () => number
  pushDebounceMs?: number
}

function statusForExternal(status: Task['status']): ExternalTaskStatus {
  if (status === 'done' || status === 'dropped') return 'closed'
  if (status === 'in_progress' || status === 'in_review') return 'in_progress'
  return 'open'
}

function statusFromExternal(status: ExternalTaskStatus, local: Task['status']): Task['status'] {
  if (status === 'closed') return local === 'dropped' ? 'dropped' : 'done'
  if (status === 'in_progress') return local === 'in_review' ? 'in_review' : 'in_progress'
  return local === 'inbox' ? 'inbox' : 'todo'
}

function refFor(link: TaskExternalLink): ExternalTicketRef {
  return {
    provider: link.provider,
    externalKey: link.externalKey,
    externalId: link.externalId,
    url: link.url,
  }
}

function providerError(error: unknown): { state: 'error' | 'auth_error'; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const isAuth = message.startsWith(TASKS_AUTH_ERROR_PREFIX)
    || /not connected|bad credentials|reconnect|401|unauthorized|authorization.*invalid/i.test(message)
  return {
    state: isAuth ? 'auth_error' : 'error',
    message: message.replace(TASKS_AUTH_ERROR_PREFIX, ''),
  }
}

function patchForDirtyFields(task: Task, link: TaskExternalLink): TicketPatch {
  const fields = new Set(link.dirtyFields)
  return {
    ...(fields.has('title') ? { title: task.title } : {}),
    ...(fields.has('body') ? { body: task.body } : {}),
    ...(fields.has('labels') ? { labels: task.labels } : {}),
    ...(fields.has('status') ? { status: statusForExternal(task.status) } : {}),
  }
}

function acknowledgedFields(
  task: Task,
  patch: TicketPatch,
): TaskExternalLink['dirtyFields'] {
  const fields: TaskExternalLink['dirtyFields'] = []
  if (patch.title !== undefined && patch.title === task.title) fields.push('title')
  if (patch.body !== undefined && patch.body === task.body) fields.push('body')
  if (patch.labels !== undefined && JSON.stringify(patch.labels) === JSON.stringify(task.labels)) fields.push('labels')
  if (patch.status !== undefined && patch.status === statusForExternal(task.status)) fields.push('status')
  return fields
}

export class TaskSyncEngine {
  private readonly adapterFor: (provider: string) => TaskSyncAdapter
  private readonly now: () => number
  private readonly pushDebounceMs: number
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly syncs = new Map<string, Promise<TaskExternalLink | null>>()
  private readonly publishes = new Map<string, Promise<TaskDetails>>()
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
    for (const link of links) {
      const synced = await this.syncTask(link.taskId, { retryAuth: false })
      if (synced) results.push(synced)
    }
    return results
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
        await this.applyExternal(taskId, external)
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
        pushedPatch = patchForDirtyFields(task, currentLink)
        lastTicket = await adapter.pushFields(refFor(currentLink), pushedPatch)
      }

      const dirtyComments = dirtyCommentsForTask(taskId)
      for (const comment of dirtyComments) {
        const posted = await adapter.postComment(refFor(currentLink), comment.body)
        withTx(() => markCommentSynced(getDb(), comment.id, posted.externalId))
      }
      const currentTask = (await TaskModel.byId(taskId)).record()
      withTx(() => acknowledgeExternalPush(
        getDb(),
        taskId,
        lastTicket,
        acknowledgedFields(currentTask, pushedPatch),
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

  private async applyExternal(taskId: string, ticket: NormalizedTicket): Promise<void> {
    const task = await TaskModel.byId(taskId)
    await task.update({
      title: ticket.title,
      body: ticket.body,
      labels: ticket.labels,
      status: statusFromExternal(ticket.status, task.status),
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
    const refs: ExternalTicketRef[] = uniqueIds.map((externalId) => ({
      ...target.ref,
      externalId,
      url: target.ref.provider === 'github'
        ? `https://github.com/${target.ref.externalKey}/issues/${externalId}`
        : '',
    }))
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
        status: statusFromExternal(ticket.status, 'todo'),
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
      status: statusForExternal(task.status),
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
  return hasPendingSync(taskId)
}

/** The provider merge path already has authoritative success. Use that event
 * instead of polling the task page, and let the ordinary dirty-field path close
 * any linked external ticket. */
export async function completeTasksForMergedPullRequest(cwd: string, number: number): Promise<string[]> {
  const config = await loadProjectConfig(cwd)
  if (config?.taskDoneOnMerge === false) return []
  const rows = getDb().prepare(`
    SELECT DISTINCT tasks.id
    FROM tasks
    JOIN task_links ON task_links.task_id = tasks.id
    WHERE tasks.status = 'in_review'
      AND task_links.kind = 'pr'
      AND task_links.target_key = ?
      AND task_links.target_scope = ?
  `).all(String(number), cwd) as unknown as Array<{ id: string }>
  for (const row of rows) {
    await (await TaskModel.byId(row.id)).update({ status: 'done' }, { actor: 'system' })
  }
  return rows.map((row) => row.id)
}
