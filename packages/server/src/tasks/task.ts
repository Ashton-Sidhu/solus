import { withTx } from '../db'
import { ulid } from './ulid'
import { diffTaskEvents, readTaskEvents, type EventActor } from './task-events'
import { deleteTaskLink, readTaskLinks, writeTaskLink } from './task-links'
import {
  assertTaskStatus,
  commentsForTask,
  database,
  emitChanged,
  listTaskChildren,
  normalizedOptional,
  parentForChild,
  requireTask,
  taskFromRow,
} from './task-store'
import { deleteSessionLink, taskSessions, writeSessionLink, type SessionLinkDetails } from './task-sessions'
import { stableSessionIdForProviderThread } from '../sessions/session-lineage'
import { createLogger } from '../logger'
import { loadProjectConfig } from '../project-config/project-config'
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
  TaskEvent,
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
import { resolvePullRequestUrl } from '../providers/pull-request-url'
import { z } from 'zod'

const log = createLogger('main', 'task')
const taskIdRowSchema = z.object({ task_id: z.string() })
const taskPrRowSchema = z.object({ pr: z.string().nullable() })
const existingPrLinkRowSchema = z.object({
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
  author?: string | null
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
  createdBy?: TaskLinkInput['createdBy']
}

export interface TaskLinkOptions {
  title?: string
  url?: string | null
  originSessionId?: string | null
  createdBy?: TaskLinkInput['createdBy']
}

/** One task in Solus: its fields, and everything you can do to it.
 *
 * `TaskRecord` is the same shape as the wire and the row, and this class
 * implements it — a Task *is* a task, not a handle wrapped around one. Methods
 * do not survive serialization, so anything crossing RPC returns `record()`,
 * never the instance.
 *
 * Collection- and session-scoped work (`listTasks`, `createTask`,
 * `tasksForSession`, `prepareSessionTask`, `updateGeneratedMetadataForSession`,
 * `onTasksChanged`) is not about one task and stays as free functions in
 * `task-store.ts` / `task-sessions.ts`.
 */
export class Task implements TaskRecord {
  id!: string
  providerId!: TaskRecord['providerId']
  shortId?: number
  projectKey?: string | null
  kind!: TaskRecord['kind']
  title!: string
  titleSource?: TaskTitleSource
  body!: string
  status!: TaskStatus
  url!: string | null
  assignee?: string
  labels!: string[]
  parentId?: string
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

  private constructor(record: TaskRecord) {
    this.hydrate(record)
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

  /** Loads the row. Throws when the id is unknown — the `requireTask` contract,
   * now with the operations attached. */
  static async byId(id: string): Promise<Task> {
    return new Task(taskFromRow(requireTask(id)))
  }

  /** Resolve the task that owns a session before invoking task-owned domain
   * operations such as `linkPullRequest`. Accepts either session id: agent
   * tools carry the provider thread id, while the attempt row is keyed on the
   * stable Solus id once the session enters a lineage, so asking with the raw
   * id alone silently found nothing and the artifact stayed unlinked. */
  static async forSession(sessionId: string): Promise<Task | null> {
    const stableSessionId = stableSessionIdForProviderThread(sessionId) ?? sessionId
    const parsed = taskIdRowSchema.safeParse(database().prepare(`
      SELECT task_id
      FROM task_session_links
      WHERE task_session_links.session_id IN (?, ?)
      ORDER BY CASE task_session_links.role WHEN 'working' THEN 0 ELSE 1 END,
        task_session_links.linked_at DESC
      LIMIT 1
    `).get(sessionId, stableSessionId))
    if (!parsed.success) {
      // A task-free session is ordinary, so this is not a warning. It is the
      // only trace a missed artifact link leaves, so it must be greppable.
      log.debug('task_for_session_unresolved', { sessionId, stableSessionId })
      return null
    }
    return Task.byId(parsed.data.task_id)
  }

  /** Attach an object produced inside a session to that session's owning task.
   * Sessions without a task are intentionally left alone (for example, legacy
   * conversations that predate session-born tasks). */
  static async linkArtifactForSession(
    sessionId: string,
    input: Omit<TaskLinkInput, 'createdBy' | 'originSessionId'>,
  ): Promise<TaskDetails | null> {
    const task = await Task.forSession(sessionId)
    if (!task) return null
    return task.link({
      ...input,
      createdBy: 'agent',
      originSessionId: sessionId,
    }, { actor: 'agent', actorLabel: sessionId })
  }

  /** The plain serializable shape. Everything crossing RPC returns this. */
  record(): TaskRecord {
    return structuredClone(this)
  }

  private refresh(): this {
    this.hydrate(taskFromRow(requireTask(this.id)))
    return this
  }

  async details(): Promise<TaskDetails> {
    const db = database()
    const externalLink = externalLinkForTask(this.id, db)
    const details: TaskDetails = {
      task: this.record(),
      subtasks: listTaskChildren(this.id),
      comments: commentsForTask(this.id, db),
      links: readTaskLinks(db, this.id),
      events: readTaskEvents(db, this.id),
    }
    if (externalLink) details.externalLink = externalLink
    return details
  }

  async links(): Promise<TaskLink[]> {
    return readTaskLinks(database(), this.id)
  }

  async events(): Promise<TaskEvent[]> {
    return readTaskEvents(database(), this.id)
  }

  async update(
    patch: TaskUpdatePatch,
    actor: EventActor = { actor: 'user' },
    options: TaskUpdateOptions = {},
  ): Promise<this> {
    let syncDirty = false
    withTx(() => {
      const db = database()
      const existing = requireTask(this.id, db)
      const now = Date.now()
      let parentId = existing.parent_id
      let projectKey = existing.project_key

      if (patch.parentId !== undefined) {
        parentId = normalizedOptional(patch.parentId)
        if (parentId) {
          const parent = parentForChild(parentId, this.id, db)
          projectKey = parent.project_key
        }
      }
      if (patch.projectKey !== undefined) {
        const requestedProject = normalizedOptional(patch.projectKey)
        if (parentId && requestedProject !== projectKey) {
          throw new Error('A subtask must belong to the same project as its parent.')
        }
        projectKey = requestedProject
      }
      const title = patch.title === undefined ? existing.title : patch.title.trim()
      if (!title) throw new Error('Task title cannot be empty.')
      const status = patch.status ?? existing.status
      assertTaskStatus(status)
      const triagedAt = status === 'inbox' && projectKey === null
        ? null
        : existing.triaged_at ?? now
      const doneAt = status === 'done' ? existing.done_at ?? now : null

      db.prepare(`
        UPDATE tasks SET
          project_key = ?, parent_id = ?, title = ?, title_source = ?, body = ?,
          status = ?, kind = ?, assignee = ?, due_date = ?, priority = ?,
          labels = ?, updated_at = ?,
          triaged_at = ?, done_at = ?
        WHERE id = ?
      `).run(
        projectKey,
        parentId,
        title,
        patch.title === undefined ? existing.title_source : 'manual',
        patch.body ?? existing.body,
        status,
        patch.kind ?? existing.kind,
        patch.assignee === undefined ? existing.assignee : normalizedOptional(patch.assignee),
        patch.dueDate === undefined ? existing.due_date : normalizedOptional(patch.dueDate),
        patch.priority === undefined ? existing.priority : patch.priority,
        patch.labels === undefined ? existing.labels : JSON.stringify(patch.labels),
        now,
        triagedAt,
        doneAt,
        this.id,
      )

      // One diff of the whole row is the only place field history is produced,
      // so no field can be changed here and silently go unrecorded.
      const updated = requireTask(this.id, db)
      diffTaskEvents(db, this.id, existing, updated, actor, now)
      if (options.markSyncDirty !== false) {
        const provider = externalLinkForTask(this.id)?.provider ?? null
        const changedFields: string[] = []
        if (existing.title !== updated.title) changedFields.push('title')
        if (existing.body !== updated.body && !blockedAssetReferences(updated.body, provider).length) {
          changedFields.push('body')
        }
        if (existing.status !== updated.status) changedFields.push('status')
        if (existing.labels !== updated.labels) changedFields.push('labels')
        if (existing.priority !== updated.priority) changedFields.push('priority')
        if (existing.assignee !== updated.assignee) changedFields.push('assignee')
        syncDirty = markTaskFieldsDirty(db, this.id, changedFields)
      }
    })
    emitChanged()
    if (syncDirty) notifyTaskSyncDirty(this.id)
    return this.refresh()
  }

  async comment(body: string, options: AddTaskCommentOptions = {}): Promise<TaskDetails> {
    const text = body.trim()
    if (!text) throw new Error('Task comment cannot be empty.')
    const existing = requireTask(this.id)
    const autoPush = existing.project_key
      ? (await loadProjectConfig(existing.project_key))?.tasksAutoPushComments === true
      : false
    const link = externalLinkForTask(this.id)
    const shouldPush = link !== null
      && (options.pushToExternal === true || autoPush)
      && !blockedAssetReferences(text, link.provider).length
    withTx(() => {
      const db = database()
      requireTask(this.id, db)
      const now = Date.now()
      db.prepare(`
        INSERT OR IGNORE INTO task_comments(
          id, task_id, author, source, external_id, origin_session_id, body,
          created_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        options.id ?? ulid(now),
        this.id,
        options.author === undefined ? 'You' : options.author,
        options.source ?? 'local',
        normalizedOptional(options.externalId),
        normalizedOptional(options.originSessionId),
        text,
        now,
        shouldPush ? 1 : 0,
      )
      // No mirrored event: task_comments already is that log, and a second row
      // would be one more thing to keep in sync.
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, this.id)
    })
    emitChanged()
    if (shouldPush) notifyTaskSyncDirty(this.id)
    this.refresh()
    return this.details()
  }

  async deleteComment(commentId: string): Promise<TaskDetails> {
    const deleted = withTx(() => {
      const db = database()
      requireTask(this.id, db)
      // SAFETY: the query selects exactly these two columns from task_comments,
      // whose migration declares source as TEXT and external_id as nullable TEXT.
      const comment = db.prepare(`
        SELECT source, external_id FROM task_comments WHERE id = ? AND task_id = ?
      `).get(commentId, this.id) as { source: string; external_id: string | null } | undefined
      if (!comment) throw new Error('This task comment no longer exists.')
      if (comment.source !== 'local' || comment.external_id !== null) {
        throw new Error('Only unpublished local task comments can be deleted in Solus.')
      }
      const removed = db.prepare('DELETE FROM task_comments WHERE id = ? AND task_id = ?').run(commentId, this.id).changes > 0
      if (removed) db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), this.id)
      return removed
    })
    if (deleted) emitChanged()
    this.refresh()
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
    requireTask(this.id)
    const link = externalLinkForTask(this.id)
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
    let queued = 0
    withTx(() => {
      queued = markCommentsDirty(database(), this.id, commentIds)
    })
    if (queued) {
      emitChanged()
      notifyTaskSyncDirty(this.id)
    }
    return this.details()
  }

  async link(input: TaskLinkInput, actor: EventActor = { actor: 'user' }): Promise<TaskDetails> {
    const options: TaskLinkOptions = {
      title: input.title,
      url: input.url,
      originSessionId: input.originSessionId,
      createdBy: input.createdBy,
    }
    switch (input.kind) {
      case 'work':
        return this.linkWork(input.targetKey, options, actor)
      case 'plan':
        return this.linkPlan(input.targetScope ?? '', input.targetKey, options, actor)
      case 'automation':
        return this.linkAutomation(input.targetKey, options, actor)
      case 'pr':
        return this.linkPullRequest({
          number: Number(input.targetKey),
          targetScope: input.targetScope ?? '',
          ...options,
        }, actor)
    }
  }

  async linkWork(
    workId: string,
    options: TaskLinkOptions = {},
    actor: EventActor = { actor: options.createdBy ?? 'user' },
  ): Promise<TaskDetails> {
    return this.linkWorkspaceObject({ kind: 'work', targetKey: workId, ...options }, actor)
  }

  async linkPlan(
    planSessionId: string,
    planToolUseId: string,
    options: TaskLinkOptions = {},
    actor: EventActor = { actor: options.createdBy ?? 'user' },
  ): Promise<TaskDetails> {
    return this.linkWorkspaceObject({
      kind: 'plan',
      targetScope: planSessionId,
      targetKey: planToolUseId,
      ...options,
    }, actor)
  }

  async linkAutomation(
    automationId: string,
    options: TaskLinkOptions = {},
    actor: EventActor = { actor: options.createdBy ?? 'user' },
  ): Promise<TaskDetails> {
    return this.linkWorkspaceObject({ kind: 'automation', targetKey: automationId, ...options }, actor)
  }

  /** Shared persistence for the three workspace-owned link kinds. Their public
   * methods keep target identity explicit instead of exposing storage keys. */
  private async linkWorkspaceObject(input: TaskLinkInput, actor: EventActor): Promise<TaskDetails> {
    const changed = withTx(() => {
      const db = database()
      requireTask(this.id, db)
      const existing = db.prepare(`
        SELECT 1 FROM task_links
        WHERE task_id = ? AND kind = ? AND target_scope = ? AND target_key = ?
      `).get(this.id, input.kind, input.targetScope ?? '', input.targetKey)
      if (existing) return false
      writeTaskLink(db, this.id, input, actor)
      return true
    })
    if (changed) {
      emitChanged()
      this.refresh()
    }
    return this.details()
  }

  /** Link a pull request and keep the task/session's compact PR capture in
   * sync for sidebar rendering. Repeated discovery is deliberately idempotent. */
  async linkPullRequest(
    input: TaskPullRequestInput,
    actor: EventActor = { actor: input.createdBy ?? 'user' },
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
    const targetScope = input.targetScope.trim()
    const targetKey = String(input.number)
    const originSessionId = normalizedOptional(input.originSessionId)
    const changed = withTx(() => {
      const db = database()
      const task = requireTask(this.id, db)
      const removedStaleSystemLinks = input.createdBy === 'system' && originSessionId
        ? db.prepare(`
          DELETE FROM task_links
          WHERE task_id = ? AND kind = 'pr' AND created_by = 'system'
            AND origin_session_id = ?
            AND NOT (target_scope = ? AND target_key = ?)
        `).run(this.id, originSessionId, targetScope, targetKey).changes > 0
        : false
      const existingLink = existingPrLinkRowSchema.nullish().parse(db.prepare(`
        SELECT url, title, origin_session_id FROM task_links
        WHERE task_id = ? AND kind = 'pr' AND target_scope = ? AND target_key = ?
      `).get(this.id, targetScope, targetKey))

      let needsCapturedPr = false
      if (url) {
        const captured = JSON.stringify({ number: input.number, url })
        needsCapturedPr = task.pr !== captured
        if (originSessionId) {
          const parsedAttempt = taskPrRowSchema.safeParse(db.prepare(`
            SELECT pr FROM task_session_links
            WHERE task_id = ? AND session_id = ?
          `).get(this.id, originSessionId))
          if (parsedAttempt.success && parsedAttempt.data.pr !== captured) {
            needsCapturedPr = true
            db.prepare(`
              UPDATE task_session_links SET pr = ?
              WHERE task_id = ? AND session_id = ?
            `).run(captured, this.id, originSessionId)
          }
        }
        if (task.pr !== captured) db.prepare('UPDATE tasks SET pr = ? WHERE id = ?').run(captured, this.id)
      }
      if (existingLink) {
        const { title, originSessionId: nextOriginSessionId } = nextPrLinkIdentity(existingLink, {
          title: input.title,
          originSessionId,
          claimsRow: input.createdBy !== 'system',
        })
        const needsLinkUpdate = existingLink.url !== url
          || existingLink.title !== title
          || existingLink.origin_session_id !== nextOriginSessionId
        if (needsLinkUpdate) {
          db.prepare(`
            UPDATE task_links
            SET url = ?, title = ?, origin_session_id = ?
            WHERE task_id = ? AND kind = 'pr' AND target_scope = ? AND target_key = ?
          `).run(url, title, nextOriginSessionId, this.id, targetScope, targetKey)
        }
        return removedStaleSystemLinks || needsCapturedPr || needsLinkUpdate
      }

      writeTaskLink(db, this.id, {
        kind: 'pr',
        targetScope,
        targetKey,
        title: input.title?.trim() || undefined,
        url,
        createdBy: input.createdBy,
        originSessionId,
      }, actor)
      return true
    })
    if (changed) {
      emitChanged()
      this.refresh()
      taskLog.info('task_pr_linked', { targetScope, url: parsedUrl.url })
    } else {
      taskLog.debug('task_pr_link_unchanged', { targetScope })
    }
    return this.details()
  }

  async unlink(
    kind: TaskLinkKind,
    targetKey: string,
    targetScope = '',
    actor: EventActor = { actor: 'user' },
  ): Promise<TaskDetails> {
    const removed = withTx(() => {
      const db = database()
      requireTask(this.id, db)
      return deleteTaskLink(db, this.id, kind, targetKey, targetScope, actor)
    })
    if (removed) {
      emitChanged()
      this.refresh()
    }
    return this.details()
  }

  /** Explicitly attach this task to one session attempt. */
  async linkSession(
    sessionId: string,
    role: TaskSessionRole = 'working',
    details: SessionLinkDetails = {},
  ): Promise<void> {
    withTx(() => {
      const db = database()
      writeSessionLink(db, this.id, sessionId, role, details, Date.now())
    })
    emitChanged()
    this.refresh()
  }

  /** The reverse of `linkSession`: drop the relationship and record it. */
  async unlinkSession(
    sessionId: string,
    actor: EventActor = { actor: 'user' },
  ): Promise<void> {
    const removed = withTx(() => deleteSessionLink(database(), this.id, sessionId, actor))
    if (removed) {
      emitChanged()
      this.refresh()
    }
  }

  async delete(): Promise<boolean> {
    const deleted = withTx(() => database().prepare('DELETE FROM tasks WHERE id = ?').run(this.id).changes > 0)
    if (deleted) emitChanged()
    return deleted
  }
}

/** Assemble the serializable state a dispatched prompt carries — exactly what
 * `formatTaskContext` consumes, read on the task's own host
 * (docs/plans/dispatch-parity.md). The RPC layer attaches linked-item content
 * (`attachLinkedContent`) before shipping, so this stays a pure store read. */
export async function taskSnapshot(taskId: string): Promise<TaskSnapshot> {
  const details = await (await Task.byId(taskId)).details()
  const parent = details.task.parentId
    ? await (await Task.byId(details.task.parentId)).details()
    : null
  return { details, parent, sessions: taskSessions(taskId)[taskId] ?? [] }
}
