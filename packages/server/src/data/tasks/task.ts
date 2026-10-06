import { sql } from 'drizzle-orm'
import { ulid } from '@solus/contracts/ulid'
import { taskComments, taskExternalLinks, taskLinks, taskSessionLinks, tasks } from './schema'
import { sameUser, type Attribution } from '@solus/contracts/user'
import { assertTaskAssignee, diffTaskActivity, notifyTaskAssignment, TASK_ACTIVITY_LIMIT } from './task-activity'
import { activityFor, deleteActivityFor } from '../activity/activity'
import { removeNotificationsFor } from '../notifications/store'
import { agentAttribution, attributionJson, parseStoredAttribution } from '../stored-attribution'
import { claimSessionOutputLink, deleteTaskLink, readTaskLinks, setTaskLinkPin, writeTaskLink, type TaskLinkWrite } from './task-links'
import { readSessionOutputs } from './session-outputs'
import {
  assertTaskStatus,
  commentsForTask,
  database,
  emitChanged,
  normalizedOptional,
  requireTask,
  TASK_HERE,
  taskFromRow,
  type TaskLocation,
  type TaskRow,
} from './task-store'
import { deleteSessionLink, taskSessions, writeSessionLink, type SessionLinkDetails } from './task-sessions'
import { linkSessionPullRequest, unlinkSessionPullRequest } from '../sessions/session-pull-requests'
import { reopenSessionsSettledByTask, settleSession } from '../sessions/session-states'
import { scopeClause } from '../scope'
import type { RecordScope } from '../../admission/principal'
import { createLogger } from '../../logger'
import { loadProjectConfig } from '../../project-config/project-config'
import {
  externalLinkForTask,
  markCommentsDirty,
  markTaskFieldsDirty,
  notifyTaskSyncDirty,
} from './task-sync-store'
import { blockedAssetReferences } from './adapters/registry'
import type {
  Task as TaskRecord,
  TaskComment,
  TaskDetails,
  TaskLink,
  TaskLinkInput,
  TaskLinkKind,
  TaskPriority,
  TaskSessionRole,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
  TaskTitleSource,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { resolvePullRequestUrl } from '../../providers/pull-request-url'
import { z } from 'zod'

const log = createLogger('main', 'task')
const taskIdRowSchema = z.object({ task_id: z.string() })
const taskPrRowSchema = z.object({ pr: z.string().nullable() })
const commentSourceRowSchema = z.object({ source: z.string(), external_id: z.string().nullable(), author: z.string().nullable() })
const existingPrLinkRowSchema = z.object({
  target_scope: z.string(),
  url: z.string().nullable(),
  title: z.string(),
  origin_session_id: z.string().nullable(),
})

interface PrLinkIdentity {
  title: string
  originSessionId: string | null
}

/**
 * Who a pull request link belongs to once the row exists.
 *
 * A system write only reports what one checkout observed, so a second session
 * observing the same pull request must not take the row over: rewriting the
 * title and the origin on every discovery pass makes two mounted checkouts
 * trade the row back and forth, and each trade broadcasts a task change that
 * starts the next pass. User and agent writes are explicit intent, so they
 * stay authoritative and may still fill a gap the system left.
 */
/** A finished task is done or dropped: no work goes on under it. */
function isFinishedStatus(status: string): boolean {
  return status === 'done' || status === 'dropped'
}

/** A moderator may delete any comment; anyone may delete an agent's or an
 *  automation's; a person may delete only their own (as `mayChangeThread`). */
function mayDeleteComment(author: Attribution | null, actor: { by: Attribution; canModerate: boolean }): boolean {
  if (actor.canModerate) return true
  if (author?.kind === 'agent' || author?.kind === 'automation') return true
  return author?.kind === 'user' && actor.by.kind === 'user' && sameUser(author.user.id, actor.by.user.id)
}

function nextPrLinkIdentity(
  existing: z.infer<typeof existingPrLinkRowSchema>,
  input: { title?: string; originSessionId: string | null; claimsRow: boolean },
): PrLinkIdentity {
  const suppliedTitle = input.title?.trim()
  if (input.claimsRow) {
    return {
      title: suppliedTitle || existing.title,
      originSessionId: input.originSessionId ?? existing.origin_session_id,
    }
  }
  return {
    title: existing.title || suppliedTitle || '',
    originSessionId: existing.origin_session_id ?? input.originSessionId,
  }
}

interface AddTaskCommentOptions {
  /** Who wrote it: the admitted actor, or the agent that asked. */
  by: Attribution
  source?: TaskComment['source']
  externalId?: string | null
  originSessionId?: string | null
  /** Caller-supplied comment id (an outbox op id, so a redelivered op inserts
   *  the same row and `INSERT OR IGNORE` makes the write idempotent). Omitted
   *  for ordinary comments, which mint their own ULID. */
  id?: string
  /** Queue this local-first comment for the linked external ticket. */
  pushToExternal?: boolean
}

interface TaskUpdateOptions {
  /** External pulls must not immediately mark the fields dirty again. */
  markSyncDirty?: boolean
}

export interface TaskPullRequestInput {
  number: number
  title?: string
  url?: string | null
  targetScope: string
  originSessionId?: string | null
  /** Solus made the link by itself, so it is recorded as the system's. */
  automatic?: boolean
}

export interface TaskLinkOptions {
  title?: string
  url?: string | null
  originSessionId?: string | null
  automatic?: boolean
  /** Pin this link, or unpin it. Omitted leaves the current pin alone. */
  pinned?: boolean
}

/** One task in Solus: its fields, and everything you can do to it.
 *
 * `TaskRecord` is the same shape as the wire and the row, and this class
 * implements it — a Task *is* a task, not a handle wrapped around one. Methods
 * do not survive serialization, so anything crossing RPC returns `record()`,
 * never the instance.
 *
 * Collection- and session-scoped work (`listTasks`, `createTask`,
 * `tasksForSession`, `prepareSessionTask`,
 * `onTasksChanged`) is not about one task and stays as free functions in
 * `task-store.ts` / `task-sessions.ts`.
 */
export class Task implements TaskRecord {
  id!: string
  providerId!: TaskRecord['providerId']
  organizationId!: string
  shortId?: number
  projectKey?: string | null
  title!: string
  titleSource?: TaskTitleSource
  body!: string
  status!: TaskStatus
  url!: string | null
  assignee?: string
  assigneeUserId?: string
  labels!: string[]
  epic?: TaskRecord['epic']
  dueDate?: string
  priority?: TaskPriority
  pr?: TaskRecord['pr']
  canEditPlanningFields?: boolean
  source?: TaskSource
  originSessionId?: string
  originAutomationId?: string
  createdAt?: number
  updatedAt!: TaskRecord['updatedAt']
  triagedAt?: number
  doneAt?: number
  raw?: unknown
  /** The organization every write to this task and its child rows lands in
   * (organization-scope R10). Set from the row, never from the caller: a
   * caller names the scope it may read, and the row names where it lives. */
  readonly #organizationId: string

  private constructor(row: TaskRow) {
    this.#organizationId = row.organization_id
    this.hydrate(taskFromRow(row))
  }

  /** Replace the fields wholesale rather than merging: `taskFromRow` omits an
   * absent optional instead of setting it null, so a plain assign would leave a
   * cleared `doneAt` or `dueDate` standing from the previous read. */
  private hydrate(record: TaskRecord): void {
    for (const key of Object.keys(this)) {
      if (!(key in record)) Reflect.deleteProperty(this, key)
    }
    Object.assign(this, record)
  }

  /** Loads the row inside `scope`. Throws when the id is unknown there — the
   * `requireTask` contract, now with the operations attached. */
  static async byId(scope: RecordScope, id: string): Promise<Task> {
    return new Task(await requireTask(scope, id))
  }

  /** Resolve the task that owns a session before invoking task-owned domain
   * operations such as `linkPullRequest`. */
  static async forSession(scope: RecordScope, sessionId: string): Promise<Task | null> {
    const parsed = taskIdRowSchema.safeParse(await database().get(sql`
      SELECT task_id
      FROM ${taskSessionLinks}
      WHERE ${scopeClause(scope, sql`task_session_links.organization_id`)}
        AND task_session_links.session_id = ${sessionId}
      ORDER BY CASE task_session_links.role WHEN 'working' THEN 0 ELSE 1 END,
        task_session_links.linked_at DESC
      LIMIT 1
    `))
    if (!parsed.success) {
      // A task-free session is ordinary, so this is not a warning. It is the
      // only trace a missed artifact link leaves, so it must be greppable.
      log.debug('task_for_session_unresolved', { sessionId })
      return null
    }
    return Task.byId(scope, parsed.data.task_id)
  }

  /**
   * Show what a session made on the task the session works on
   * (docs/plans/session-outputs.md). The link follows the session: it leaves
   * the task when the session does. A session with no task is left alone, and
   * the item waits until the session joins one. A session that a task only
   * references brings nothing. Accepts either session id, as `forSession`.
   */
  static async linkSessionOutput(
    scope: RecordScope,
    sessionId: string,
    input: Omit<TaskLinkInput, 'automatic' | 'originSessionId'>,
  ): Promise<TaskDetails | null> {
    const owner = z.object({ task_id: z.string(), session_id: z.string() }).nullish().parse(await database().get(sql`
      SELECT task_id, session_id
      FROM ${taskSessionLinks}
      WHERE ${scopeClause(scope, sql`task_session_links.organization_id`)}
        AND task_session_links.session_id = ${sessionId}
        AND task_session_links.role <> 'referenced'
      ORDER BY task_session_links.linked_at DESC
      LIMIT 1
    `))
    if (!owner) {
      log.debug('task_for_session_unresolved', { sessionId })
      return null
    }
    const task = await Task.byId(scope, owner.task_id)
    return task.linkWorkspaceObject(
      { ...input, originSessionId: sessionId, outputOfSessionId: owner.session_id },
      agentAttribution(sessionId),
    )
  }

  /** The plain serializable shape. Everything crossing RPC returns this. */
  record(): TaskRecord {
    return structuredClone(this)
  }

  private async refresh(): Promise<this> {
    this.hydrate(taskFromRow(await requireTask(this.#organizationId, this.id)))
    return this
  }

  async details(): Promise<TaskDetails> {
    const db = database()
    const externalLink = await externalLinkForTask(this.id, db)
    const details: TaskDetails = {
      task: this.record(),
      comments: await commentsForTask(this.id, db),
      links: await readTaskLinks(db, this.#organizationId, this.id),
      activity: await activityFor(this.#organizationId, { kind: 'task', id: this.id }, { limit: TASK_ACTIVITY_LIMIT, db }),
    }
    if (externalLink) details.externalLink = externalLink
    return details
  }

  async links(): Promise<TaskLink[]> {
    return readTaskLinks(database(), this.#organizationId, this.id)
  }

  async update(
    patch: TaskUpdatePatch,
    by: Attribution,
    options: TaskUpdateOptions = {},
  ): Promise<this> {
    let syncDirty = false
    let wasFinished = false
    let isFinished = false
    await database().transaction(async (db) => {
      const existing = await requireTask(this.#organizationId, this.id, db)
      const now = Math.max(Date.now(), existing.updated_at + 1)
      const projectKey = patch.projectKey === undefined
        ? existing.project_key
        : normalizedOptional(patch.projectKey)
      const title = patch.title === undefined ? existing.title : patch.title.trim()
      if (!title) throw new Error('Task title cannot be empty.')
      const status = patch.status ?? existing.status
      assertTaskStatus(status)
      if (patch.assigneeUserId !== undefined) assertTaskAssignee(this.#organizationId, normalizedOptional(patch.assigneeUserId))
      const triagedAt = status === 'inbox' && projectKey === null
        ? null
        : existing.triaged_at ?? now
      const doneAt = status === 'done' ? existing.done_at ?? now : null
      wasFinished = isFinishedStatus(existing.status)
      isFinished = isFinishedStatus(status)

      await db.run(sql`
        UPDATE ${tasks} SET
          project_key = ${projectKey}, title = ${title},
          title_source = ${patch.title === undefined ? existing.title_source : 'manual'},
          body = ${patch.body ?? existing.body},
          status = ${status},
          assignee = ${patch.assignee === undefined ? existing.assignee : normalizedOptional(patch.assignee)},
          assignee_user_id = ${patch.assigneeUserId === undefined ? existing.assignee_user_id : normalizedOptional(patch.assigneeUserId)},
          due_date = ${patch.dueDate === undefined ? existing.due_date : normalizedOptional(patch.dueDate)},
          priority = ${patch.priority === undefined ? existing.priority : patch.priority},
          labels = ${patch.labels === undefined ? existing.labels : JSON.stringify(patch.labels)},
          updated_at = ${now},
          triaged_at = ${triagedAt}, done_at = ${doneAt}
        WHERE id = ${this.id}
      `)

      // One diff of the whole row is the only place field history is produced,
      // so no field can be changed here and silently go unrecorded.
      const updated = await requireTask(this.#organizationId, this.id, db)
      await diffTaskActivity(db, this.#organizationId, this.id, existing, updated, by, now)
      await notifyTaskAssignment(db, this.#organizationId, updated, existing.assignee_user_id, updated.assignee_user_id, by, now)
      if (options.markSyncDirty !== false) {
        const provider = (await externalLinkForTask(this.id, db))?.provider ?? null
        const changedFields: string[] = []
        if (existing.title !== updated.title) changedFields.push('title')
        if (existing.body !== updated.body && !blockedAssetReferences(updated.body, provider).length) {
          changedFields.push('body')
        }
        if (existing.status !== updated.status) changedFields.push('status')
        if (existing.labels !== updated.labels) changedFields.push('labels')
        if (existing.priority !== updated.priority) changedFields.push('priority')
        if (existing.assignee !== updated.assignee) changedFields.push('assignee')
        syncDirty = await markTaskFieldsDirty(db, this.id, changedFields)
      }
    })
    emitChanged(this.id)
    if (syncDirty) notifyTaskSyncDirty(this.#organizationId, this.id)
    if (wasFinished !== isFinished) await this.#settleSessions(isFinished)
    return this.refresh()
  }

  /**
   * Link a pull request that a session of this task works on. The session
   * owns that link and the task reads it
   * (docs/plans/session-pull-requests.md). Returns false for a session that
   * does not work on this task: the link then belongs on the task itself.
   */
  async linkWorkingSessionPullRequest(sessionId: string, input: { url: string; title?: string }, by: Attribution): Promise<boolean> {
    const works = ((await taskSessions(this.#organizationId, this.id))[this.id] ?? []).some((link) =>
      link.role !== 'referenced' && link.sessionId === sessionId)
    if (!works) return false
    await linkSessionPullRequest(sessionId, { ...input, source: 'agent', by })
    return true
  }

  /**
   * A finished task ends the work of its sessions, so each one is settled
   * unless another task that is not finished still holds it. Reopening the
   * task makes the sessions it settled active again.
   */
  async #settleSessions(isFinished: boolean): Promise<void> {
    const working = ((await taskSessions(this.#organizationId, this.id))[this.id] ?? [])
      .filter((link) => link.role !== 'referenced')
      .map((link) => link.sessionId)
    if (!isFinished) {
      await reopenSessionsSettledByTask(working)
      return
    }
    for (const sessionId of working) {
      const heldByLiveTask = z.object({ id: z.string() }).nullish().parse(await database().get(sql`
        SELECT tasks.id FROM ${taskSessionLinks}
        JOIN ${tasks} ON tasks.id = task_session_links.task_id
        WHERE task_session_links.session_id = ${sessionId} AND task_session_links.role <> 'referenced'
          AND tasks.id <> ${this.id} AND ${TASK_HERE} AND tasks.status NOT IN ('done', 'dropped')
        LIMIT 1
      `))
      if (!heldByLiveTask) await settleSession(sessionId, 'task')
    }
  }

  async comment(body: string, options: AddTaskCommentOptions): Promise<TaskDetails> {
    const text = body.trim()
    if (!text) throw new Error('Task comment cannot be empty.')
    const existing = await requireTask(this.#organizationId, this.id)
    const autoPush = existing.project_key
      ? (await loadProjectConfig(existing.project_key))?.tasksAutoPushComments === true
      : false
    const link = await externalLinkForTask(this.id)
    const shouldPush = link !== null
      && (options.pushToExternal === true || autoPush)
      && !blockedAssetReferences(text, link.provider).length
    await database().transaction(async (db) => {
      await requireTask(this.#organizationId, this.id, db)
      const now = Date.now()
      // A redelivered outbox op inserts under the same id, so the conflict is a no-op.
      await db.run(sql`
        INSERT INTO ${taskComments}(
          id, task_id, author, source, external_id, origin_session_id, body,
          created_at, dirty, organization_id
        ) VALUES (
          ${options.id ?? ulid(now)}, ${this.id}, ${attributionJson(options.by)},
          ${options.source ?? 'local'}, ${normalizedOptional(options.externalId)},
          ${normalizedOptional(options.originSessionId)}, ${text}, ${now}, ${shouldPush ? 1 : 0},
          ${this.#organizationId}
        )
        ON CONFLICT DO NOTHING
      `)
      // No mirrored event: task_comments already is that log, and a second row
      // would be one more thing to keep in sync.
      await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${this.id}`)
    })
    emitChanged(this.id)
    if (shouldPush) notifyTaskSyncDirty(this.#organizationId, this.id)
    await this.refresh()
    return this.details()
  }

  /**
   * Delete one unpublished comment. An editor may comment, but only the person
   * who wrote a comment, or a moderator (the task's owner or a host admin), may
   * delete it: the same rule a work's threads follow (`mayChangeThread`).
   */
  async deleteComment(commentId: string, actor: { by: Attribution; canModerate: boolean }): Promise<TaskDetails> {
    const deleted = await database().transaction(async (db) => {
      await requireTask(this.#organizationId, this.id, db)
      const comment = commentSourceRowSchema.nullish().parse(await db.get(sql`
        SELECT source, external_id, author FROM ${taskComments} WHERE id = ${commentId} AND task_id = ${this.id}
      `))
      if (!comment) throw new Error('This task comment no longer exists.')
      if (comment.source !== 'local' || comment.external_id !== null) {
        throw new Error('Only unpublished local task comments can be deleted in Solus.')
      }
      if (!mayDeleteComment(parseStoredAttribution(comment.author), actor)) {
        throw new Error('Only the person who wrote a comment or the task owner may delete it.')
      }
      const removed = (await db.run(sql`
        DELETE FROM ${taskComments} WHERE id = ${commentId} AND task_id = ${this.id}
      `)).changes > 0
      if (removed) await db.run(sql`UPDATE ${tasks} SET updated_at = ${Date.now()} WHERE id = ${this.id}`)
      return removed
    })
    if (deleted) emitChanged(this.id)
    await this.refresh()
    return this.details()
  }

  /**
   * Send comments upstream that were written while auto-posting was off.
   *
   * Queueing is the whole action: the sync engine owns the exchange itself, so
   * this marks the rows and wakes it rather than posting inline. A task with no
   * linked ticket has nowhere to send them and says so instead of silently
   * marking rows that nothing will ever read.
   */
  async publishComments(commentIds: string[]): Promise<TaskDetails> {
    await requireTask(this.#organizationId, this.id)
    const link = await externalLinkForTask(this.id)
    if (!link) {
      throw new Error('This task is not linked to an upstream ticket.')
    }
    const details = await this.details()
    const blocked = details.comments
      .filter((comment) => commentIds.includes(comment.id))
      .flatMap((comment) => blockedAssetReferences(comment.body, link.provider))
    if (blocked.length) {
      throw new Error(
        `${link.provider} cannot host .${blocked[0].extension} attachments. `
        + 'Add the file with the provider composer before publishing this comment.',
      )
    }
    const queued = await database().transaction((db) => markCommentsDirty(db, this.id, commentIds))
    if (queued) {
      emitChanged(this.id)
      notifyTaskSyncDirty(this.#organizationId, this.id)
    }
    return this.details()
  }

  /** `by` is who linked it: the admitted actor, or the agent that asked. */
  async link(input: TaskLinkInput, by: Attribution): Promise<TaskDetails> {
    const options: TaskLinkOptions = {
      title: input.title,
      url: input.url,
      originSessionId: input.originSessionId,
      automatic: input.automatic,
      pinned: input.pinned,
    }
    // A deliberate link: `TaskLinkInput` cannot name a session's output.
    switch (input.kind) {
      case 'work':
        return this.linkWork(input.targetKey, by, options)
      case 'plan':
        return this.linkPlan(input.targetScope ?? '', input.targetKey, by, options)
      case 'automation':
        return this.linkAutomation(input.targetKey, by, options)
      case 'pr':
        return this.linkPullRequest({
          number: Number(input.targetKey),
          targetScope: input.targetScope ?? '',
          ...options,
        }, by)
    }
  }

  async linkWork(workId: string, by: Attribution, options: TaskLinkOptions = {}): Promise<TaskDetails> {
    return this.linkWorkspaceObject({ kind: 'work', targetKey: workId, ...options }, by)
  }

  async linkPlan(planSessionId: string, planToolUseId: string, by: Attribution, options: TaskLinkOptions = {}): Promise<TaskDetails> {
    return this.linkWorkspaceObject({
      kind: 'plan',
      targetScope: planSessionId,
      targetKey: planToolUseId,
      ...options,
    }, by)
  }

  async linkAutomation(automationId: string, by: Attribution, options: TaskLinkOptions = {}): Promise<TaskDetails> {
    return this.linkWorkspaceObject({ kind: 'automation', targetKey: automationId, ...options }, by)
  }

  /** Shared persistence for the three workspace-owned link kinds. Their public
   * methods keep target identity explicit instead of exposing storage keys. */
  private async linkWorkspaceObject(input: TaskLinkWrite, by: Attribution): Promise<TaskDetails> {
    const changed = await database().transaction(async (db) => {
      await requireTask(this.#organizationId, this.id, db)
      const target = {
        kind: input.kind,
        targetScope: input.targetScope ?? '',
        targetKey: input.targetKey,
      }
      const existing = await db.get(sql`
        SELECT 1 AS present FROM ${taskLinks}
        WHERE task_id = ${this.id} AND kind = ${target.kind}
          AND target_scope = ${target.targetScope} AND target_key = ${target.targetKey}
      `)
      // Already linked: the only thing left to say is which artifact the page
      // opens with, and that is a pin, not a second link. A deliberate link
      // of a session's output also makes the link stay when the session leaves.
      if (existing) {
        const claimed = input.outputOfSessionId ? false : await claimSessionOutputLink(db, this.id, target)
        const pinChanged = input.pinned === undefined
          ? false
          : await setTaskLinkPin(db, this.id, target, input.pinned)
        return claimed || pinChanged
      }
      await writeTaskLink(db, this.#organizationId, this.id, input, by)
      return true
    })
    if (changed) {
      emitChanged(this.id)
      await this.refresh()
    }
    return this.details()
  }

  /** Link a pull request to the task itself and keep the task/session's compact
   * PR capture in sync for sidebar rendering. Idempotent. A pull request that a
   * session works on is that session's link (`linkSessionPullRequest`), which
   * the task reads and does not copy. */
  async linkPullRequest(
    input: TaskPullRequestInput,
    by: Attribution,
  ): Promise<TaskDetails> {
    if (!Number.isSafeInteger(input.number) || input.number <= 0) {
      throw new Error('A task pull request needs a positive integer number.')
    }
    const taskLog = log.child({ taskId: this.id, prNumber: input.number })
    const suppliedUrl = input.url?.trim() || null
    taskLog.info('task_pr_link_requested', {
      hasSuppliedUrl: !!suppliedUrl,
      projectKey: this.projectKey ?? null,
    })
    const lookupCwd = this.projectKey ?? input.targetScope.trim()
    if (!suppliedUrl && !lookupCwd) {
      throw new Error(`Task pull request #${input.number} needs a project before Solus can resolve its URL.`)
    }
    const resolvedUrl = suppliedUrl ?? await resolvePullRequestUrl(lookupCwd, input.number)
    const parsedUrl = parseGitHubPullRequestUrl(resolvedUrl)
    if (!parsedUrl || parsedUrl.number !== input.number) {
      taskLog.error('task_pr_link_url_invalid', { url: resolvedUrl })
      throw new Error(`Task pull request #${input.number} needs its full GitHub pull request URL.`)
    }
    const url = parsedUrl.url
    // A project path is only where Solus discovered the PR. The repository is
    // the PR's durable identity, so every entry point must persist one scope.
    const targetScope = [
      parsedUrl.baseRepo.host,
      parsedUrl.baseRepo.owner,
      parsedUrl.baseRepo.repo,
    ].join('/').toLowerCase()
    const targetKey = String(input.number)
    const originSessionId = normalizedOptional(input.originSessionId)
    const changed = await database().transaction(async (db) => {
      const task = await requireTask(this.#organizationId, this.id, db)
      const existingLink = existingPrLinkRowSchema.nullish().parse(await db.get(sql`
        SELECT target_scope, url, title, origin_session_id
        FROM ${taskLinks}
        WHERE task_id = ${this.id} AND kind = 'pr' AND target_key = ${targetKey}
          AND (LOWER(target_scope) = LOWER(${targetScope}) OR LOWER(url) = LOWER(${url}))
        LIMIT 1
      `))

      const captured = JSON.stringify({ number: input.number, url })
      let needsCapturedPr = task.pr !== captured
      if (originSessionId) {
        const parsedAttempt = taskPrRowSchema.safeParse(await db.get(sql`
          SELECT pr FROM ${taskSessionLinks}
          WHERE task_id = ${this.id} AND session_id = ${originSessionId}
        `))
        if (parsedAttempt.success && parsedAttempt.data.pr !== captured) {
          needsCapturedPr = true
          await db.run(sql`
            UPDATE ${taskSessionLinks} SET pr = ${captured}
            WHERE task_id = ${this.id} AND session_id = ${originSessionId}
          `)
        }
      }
      if (task.pr !== captured) await db.run(sql`UPDATE ${tasks} SET pr = ${captured} WHERE id = ${this.id}`)
      if (existingLink) {
        const { title, originSessionId: nextOriginSessionId } = nextPrLinkIdentity(existingLink, {
          title: input.title,
          originSessionId,
          claimsRow: !input.automatic,
        })
        const needsLinkUpdate = existingLink.target_scope !== targetScope
          || existingLink.url !== url
          || existingLink.title !== title
          || existingLink.origin_session_id !== nextOriginSessionId
        if (needsLinkUpdate) {
          await db.run(sql`
            UPDATE ${taskLinks}
            SET target_scope = ${targetScope}, url = ${url}, title = ${title}, origin_session_id = ${nextOriginSessionId}
            WHERE task_id = ${this.id} AND kind = 'pr' AND target_scope = ${existingLink.target_scope} AND target_key = ${targetKey}
          `)
        }
        return needsCapturedPr || needsLinkUpdate
      }

      await writeTaskLink(db, this.#organizationId, this.id, {
        kind: 'pr',
        targetScope,
        targetKey,
        title: input.title?.trim() || undefined,
        url,
        automatic: input.automatic,
        originSessionId,
      }, by)
      return true
    })
    if (changed) {
      emitChanged(this.id)
      await this.refresh()
      taskLog.info('task_pr_linked', { targetScope, url: parsedUrl.url })
    } else {
      taskLog.debug('task_pr_link_unchanged', { targetScope })
    }
    return this.details()
  }

  async unlink(
    kind: TaskLinkKind,
    targetKey: string,
    targetScope: string,
    by: Attribution,
  ): Promise<TaskDetails> {
    let removed = await database().transaction(async (db) => {
      await requireTask(this.#organizationId, this.id, db)
      return deleteTaskLink(db, this.#organizationId, this.id, kind, targetKey, targetScope, by)
    })
    // A pull request the task reads through its sessions has no row here:
    // removing it from the task removes it from each session that owns it.
    const number = Number(targetKey)
    if (!removed && kind === 'pr' && Number.isSafeInteger(number)) {
      const owners = (await taskSessions(this.#organizationId, this.id))[this.id] ?? []
      for (const owner of owners) {
        if (owner.role === 'referenced') continue
        if (await unlinkSessionPullRequest(owner.sessionId, targetScope, number)) removed = true
      }
    }
    if (removed) {
      emitChanged(this.id)
      await this.refresh()
    }
    return this.details()
  }

  /** Explicitly attach this task to one session attempt. */
  async linkSession(
    sessionId: string,
    role: TaskSessionRole = 'working',
    details: SessionLinkDetails = {},
  ): Promise<void> {
    const isNewLink = await database().transaction((db) => writeSessionLink(db, this.#organizationId, this.id, sessionId, role, details, Date.now()))
    // A session that joins the task brings what it made. Only a first link
    // does this, so an output that a person removed from the task stays removed.
    if (isNewLink && role !== 'referenced') await this.#adoptSessionOutputs(sessionId)
    emitChanged(this.id)
    await this.refresh()
  }

  async #adoptSessionOutputs(sessionId: string): Promise<void> {
    for (const output of await readSessionOutputs(this.#organizationId, sessionId)) {
      await this.linkWorkspaceObject(
        { ...output, originSessionId: sessionId, outputOfSessionId: sessionId },
        agentAttribution(sessionId),
      ).catch((error) => {
        log.warn('task_session_output_link_failed', {
          taskId: this.id,
          sessionId,
          kind: output.kind,
          targetKey: output.targetKey,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  /** The reverse of `linkSession`: drop the relationship and record it. */
  async unlinkSession(
    sessionId: string,
    by: Attribution,
  ): Promise<void> {
    const removed = await database().transaction((db) => deleteSessionLink(db, this.#organizationId, this.id, sessionId, by))
    if (removed) {
      emitChanged(this.id)
      await this.refresh()
    }
  }

  /**
   * Keep only where the task went (cloud-sharing.md §3a): the organization's copy
   * is now the only copy, so the body, comments, ticket link, history, and
   * notifications go. The row, its title, and its links stay, so a session or a
   * work that names the task here is answered with its location.
   */
  async moveTo(location: TaskLocation): Promise<void> {
    await database().transaction(async (db) => {
      await requireTask(this.#organizationId, this.id, db)
      for (const table of [taskComments, taskExternalLinks]) {
        await db.run(sql`DELETE FROM ${table} WHERE task_id = ${this.id}`)
      }
      await deleteActivityFor({ kind: 'task', id: this.id }, db)
      await removeNotificationsFor(db, this.#organizationId, { kind: 'task', taskId: this.id })
      await db.run(sql`
        UPDATE ${tasks} SET body = '', location = ${JSON.stringify(location)}
        WHERE id = ${this.id} AND organization_id = ${this.#organizationId}
      `)
    })
    emitChanged()
  }

  async delete(): Promise<boolean> {
    const deleted = await database().transaction(async (db) => {
      const removed = (await db.run(sql`
        DELETE FROM ${tasks} WHERE id = ${this.id} AND organization_id = ${this.#organizationId}
      `)).changes > 0
      // The task's history goes with it, as `task_events` did by its foreign key.
      if (removed) await deleteActivityFor({ kind: 'task', id: this.id }, db)
      if (removed) await removeNotificationsFor(db, this.#organizationId, { kind: 'task', taskId: this.id })
      return removed
    })
    if (deleted) emitChanged()
    return deleted
  }
}

/** Assemble the serializable state a dispatched prompt carries — what
 * `read_task` on the execution host answers from, read on the task's own host
 * (docs/plans/dispatch-parity.md). The RPC layer attaches linked-item content
 * (`attachLinkedContent`) before shipping, so this stays a pure store read. */
export async function taskSnapshot(scope: RecordScope, taskId: string): Promise<TaskSnapshot> {
  const details = await (await Task.byId(scope, taskId)).details()
  return { details, sessions: (await taskSessions(scope, taskId))[taskId] ?? [] }
}
