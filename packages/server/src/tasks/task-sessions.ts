import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { stableSessionIdForProviderThread } from '../sessions/session-lineage'
import { getDb, withTx } from '../db'
import { persistRemoteSessionStart } from '../db/session-indexer'
import { appendTaskEvent, diffTaskEvents, type EventActor } from './task-events'
import {
  database,
  emitChanged,
  jsonValue,
  listTaskChildren,
  loadTaskRecord,
  normalizedOptional,
  requireTask,
  taskPrSchema,
  taskFromRow,
  writeTask,
} from './task-store'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type {
  SessionExecutionHost,
  Task,
  TaskForSessionResult,
  TaskSessionLink,
  TaskSessionRole,
} from '@solus/contracts/task-types'

/** The session↔task binding store: attempt rows in `task_session_links`, the
 * session-born minting path, and the session-keyed reads the sidebar and
 * breadcrumb hydrate from. */

const MAX_PROMPT_TITLE_LENGTH = 80

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
const taskSessionRoleSchema = z.enum(['working', 'referenced'])
const taskSessionLinkRowSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  role: taskSessionRoleSchema,
  branch: z.string().nullable(),
  /** Legacy capture — populated by earlier versions, read-only today. */
  pr: z.string().nullable(),
  linked_at: z.number(),
  /** Joined from `sessions` by `LINK_SELECT`, which is the only way links are
   *  read. Null when the session is not in the index yet. */
  session_title: z.string().nullable(),
  session_provider: z.string().nullable(),
  session_server_id: z.string().nullable(),
  session_is_worktree: z.number().nullable(),
  session_started_at: z.number().nullable(),
  last_activity_at: z.number().nullable(),
})
const rekeySessionLinkRowSchema = z.object({
  task_id: z.string(),
  role: taskSessionRoleSchema,
  pr: z.string().nullable(),
  linked_at: z.number(),
})
const taskIdRowSchema = z.object({ task_id: z.string() })
const previousOwnerRowSchema = z.object({
  task_id: z.string(),
  source: z.string(),
  origin_session_id: z.string().nullable(),
})
const generatedMetadataTaskRowSchema = z.object({
  id: z.string(),
  title_source: z.enum(['prompt', 'generated', 'manual']),
  body: z.string(),
})

type TaskSessionLinkRow = z.infer<typeof taskSessionLinkRowSchema>
interface TaskSessionsByTask {
  [taskId: string]: TaskSessionLink[]
}

function linkFromRow(row: TaskSessionLinkRow): TaskSessionLink {
  const link: TaskSessionLink = {
    taskId: row.task_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? null,
    provider: row.session_provider ?? null,
    startedAt: row.session_started_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    // Execution facts are projected from the session row. The relationship
    // itself owns no host or checkout metadata.
    executionServerId: row.session_server_id,
    role: row.role,
    linkedAt: row.linked_at,
  }
  if (row.branch !== null) link.branch = row.branch
  if (row.session_is_worktree !== null) link.isolatedCheckout = row.session_is_worktree === 1
  const pr = jsonValue(row.pr, taskPrSchema)
  if (pr) link.pr = pr
  return link
}

export interface SessionLinkDetails {
  /** Present only for a dispatch. This host is the *task's*, so the agent ran on
   * a machine it never saw and the client is the only party that can say which. */
  execution?: SessionExecutionHost | null
  /** Stamps a session-born task whose provider session id was not available
   * when its pre-launch row was minted. Existing provenance is never replaced. */
  originSessionId?: string | null
}

/** Writes the attempt row and task provenance. Runs inside the
 * caller's transaction. The public write is the `Task` object's `linkSession`. */
export function writeSessionLink(
  db: DatabaseSync,
  taskId: string,
  sessionId: string,
  role: TaskSessionRole,
  details: SessionLinkDetails,
  now: number,
): void {
  requireTask(taskId, db)
  const execution = details.execution ?? null
  const executionServerId = normalizedOptional(execution?.serverId)
  // The session record is what later reads ask, so a machine this host cannot
  // see still gets a row here. It is written before the link so a link is never
  // visible ahead of the session it joins to.
  if (executionServerId) {
    const parsedProvider = agentIdSchema.safeParse(execution?.provider)
    persistRemoteSessionStart(
      sessionId,
      parsedProvider.success ? parsedProvider.data : 'claude-code',
      executionServerId,
      normalizedOptional(execution?.projectRoot),
    )
  }
  // Re-linking an existing attempt is bookkeeping, not history — only a genuine
  // first binding is a session start.
  const isNewLink = !db.prepare('SELECT 1 FROM task_session_links WHERE task_id = ? AND session_id = ?')
    .get(taskId, sessionId)
  if (role === 'working') transferSessionOwnership(db, taskId, sessionId, now)
  db.prepare(`
    INSERT INTO task_session_links(task_id, session_id, role, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      role = excluded.role
  `).run(taskId, sessionId, role, now)
  db.prepare(`
    UPDATE tasks SET
      origin_session_id = COALESCE(origin_session_id, ?),
      updated_at = ?
    WHERE id = ?
  `).run(normalizedOptional(details.originSessionId) ?? sessionId, now, taskId)

  if (isNewLink) {
    appendTaskEvent(db, taskId, {
      kind: 'session_started',
      actor: 'agent',
      targetKind: 'session',
      targetKey: sessionId,
    }, now)
  }
}

/**
 * A session has one owning task. Writing a `working` link elsewhere transfers
 * that ownership: every other task's working attempt on the session goes, and
 * a task that was minted for this session and now holds nothing goes with it.
 *
 * This is the rule that keeps one conversation from projecting under two
 * sidebar rows, and it lives here so it holds for every writer of the row —
 * the client's first-dispatch bind, the agent's `link_task_session`, an
 * automation, an older build. A `referenced` link is a relationship, not
 * ownership, and is left alone.
 */
function transferSessionOwnership(
  db: DatabaseSync,
  taskId: string,
  sessionId: string,
  now: number,
): void {
  const previousOwners = previousOwnerRowSchema.array().parse(db.prepare(`
    SELECT task_session_links.task_id, tasks.source, tasks.origin_session_id
    FROM task_session_links
    JOIN tasks ON tasks.id = task_session_links.task_id
    WHERE task_session_links.session_id = ?
      AND task_session_links.role = 'working'
      AND task_session_links.task_id <> ?
  `).all(sessionId, taskId))
  for (const owner of previousOwners) {
    deleteSessionLink(db, owner.task_id, sessionId, {}, now)
    if (owner.source !== 'session' || owner.origin_session_id !== sessionId) continue
    // The placeholder minted for this session is empty once the session leaves
    // it: nothing else links to it, nothing hangs under it, nobody wrote on it.
    // Anything more than that makes it a task in its own right, which stays.
    const stillHoldsSomething = db.prepare(`
      SELECT 1 FROM task_session_links WHERE task_id = ?
      UNION ALL SELECT 1 FROM tasks WHERE parent_id = ?
      UNION ALL SELECT 1 FROM task_comments WHERE task_id = ?
      UNION ALL SELECT 1 FROM task_links WHERE task_id = ?
      LIMIT 1
    `).get(owner.task_id, owner.task_id, owner.task_id, owner.task_id)
    if (!stillHoldsSomething) db.prepare('DELETE FROM tasks WHERE id = ?').run(owner.task_id)
  }
}

/** Returns false when there was nothing to unlink, so the caller can skip the
 * change broadcast on a no-op. Removes only the attempt row: the task's
 * origin capture stays put. Runs
 * inside the caller's transaction; the public write is the `Task` object's
 * `unlinkSession`. */
export function deleteSessionLink(
  db: DatabaseSync,
  taskId: string,
  sessionId: string,
  actor: EventActor = {},
  now = Date.now(),
): boolean {
  requireTask(taskId, db)
  const removed = db.prepare('DELETE FROM task_session_links WHERE task_id = ? AND session_id = ?')
    .run(taskId, sessionId).changes > 0
  if (!removed) return false
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
  // Carries the session's display title so the feed still reads
  // "unlinked <name>" after the link is gone. Null when it was never indexed.
  const titleRow = z.object({ title: z.string().nullable() }).nullish().parse(db.prepare(
    'SELECT COALESCE(custom_title, first_message) AS title FROM sessions WHERE session_id = ?',
  ).get(sessionId))
  appendTaskEvent(db, taskId, {
    ...actor,
    kind: 'unlinked',
    targetKind: 'session',
    targetKey: sessionId,
    targetTitle: titleRow?.title ?? null,
  }, now)
  return true
}

/** The one way session links are read. Every link the renderer sees comes from
 * here, joined to its session's display metadata: a second reader that skipped
 * the join once already shipped a sidebar full of sessions named after their
 * parent task and a task panel full of raw session ids. */
const LINK_SELECT = `
  SELECT
    task_session_links.task_id,
    task_session_links.session_id,
    task_session_links.role,
    task_session_links.pr,
    task_session_links.linked_at,
    COALESCE(sessions.custom_title, sessions.first_message) AS session_title,
    sessions.provider AS session_provider,
    sessions.server_id AS session_server_id,
    sessions.branch AS branch,
    sessions.is_worktree AS session_is_worktree,
    (
      SELECT MIN(started_at)
      FROM session_lineage_members
      WHERE session_id = task_session_links.session_id
    ) AS session_started_at,
    sessions.last_timestamp AS last_activity_at
  FROM task_session_links
  LEFT JOIN session_lineage_members AS active_lineage
    ON active_lineage.session_id = task_session_links.session_id
    AND active_lineage.position = (
      SELECT MAX(position)
      FROM session_lineage_members
      WHERE session_id = task_session_links.session_id
    )
  LEFT JOIN sessions
    ON sessions.session_id = COALESCE(active_lineage.provider_session_id, task_session_links.session_id)
`

/** Move the existing task attempt onto the stable Solus id when that session
 * first enters a new handoff chain. Ordinary and older sessions are untouched. */
export function rekeyTaskSessionLinks(sourceSessionId: string, targetSessionId: string): void {
  if (sourceSessionId === targetSessionId) return
  const changed = withTx(() => {
    const db = getDb()
    const rows = rekeySessionLinkRowSchema.array().parse(db.prepare(`
      SELECT task_id, role, pr, linked_at
      FROM task_session_links
      WHERE session_id = ?
    `).all(sourceSessionId))
    for (const row of rows) {
      db.prepare(`
        INSERT INTO task_session_links(task_id, session_id, role, pr, linked_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, session_id) DO UPDATE SET
          role = excluded.role,
          pr = COALESCE(excluded.pr, task_session_links.pr),
          linked_at = MIN(excluded.linked_at, task_session_links.linked_at)
      `).run(
        row.task_id,
        targetSessionId,
        row.role,
        row.pr,
        row.linked_at,
      )
    }
    if (rows.length) {
      db.prepare('DELETE FROM task_session_links WHERE session_id = ?').run(sourceSessionId)
      db.prepare('UPDATE tasks SET origin_session_id = ? WHERE origin_session_id = ?')
        .run(targetSessionId, sourceSessionId)
    }
    return rows.length > 0
  })
  if (changed) emitChanged()
}

/** Task-keyed attempts for either one task or the complete global store. */
export function taskSessions(taskId?: string): TaskSessionsByTask {
  const rowValues = taskId
    ? getDb().prepare(`${LINK_SELECT}
        WHERE task_session_links.task_id = ?
        ORDER BY task_session_links.linked_at, task_session_links.session_id
      `).all(taskId)
    : getDb().prepare(`${LINK_SELECT}
        ORDER BY task_session_links.linked_at, task_session_links.task_id, task_session_links.session_id
      `).all()
  const rows = taskSessionLinkRowSchema.array().parse(rowValues)
  const links: TaskSessionsByTask = {}
  for (const row of rows) (links[row.task_id] ??= []).push(linkFromRow(row))
  return links
}

/** Resolve a session into the durable two-level task tree without loading or
 * starting any sibling sessions. */
export async function tasksForSession(sessionId: string): Promise<TaskForSessionResult | null> {
  // The owner answers; a later `referenced` relationship must not outrank it.
  const link = taskIdRowSchema.nullish().parse(getDb().prepare(`
    SELECT task_id FROM task_session_links
    WHERE session_id = ?
    ORDER BY CASE role WHEN 'working' THEN 0 ELSE 1 END, linked_at DESC
    LIMIT 1
  `).get(sessionId))
  if (!link) return null

  const task = loadTaskRecord(link.task_id)
  if (!task) return null
  const parent = task.parentId ? loadTaskRecord(task.parentId) : null
  const rootId = parent?.id ?? task.id
  const subtasks = listTaskChildren(rootId)
  const siblings = task.parentId ? subtasks.filter((subtask) => subtask.id !== task.id) : []
  const attemptsByTask = taskSessions()
  const attempts = [rootId, ...subtasks.map((subtask) => subtask.id)]
    .flatMap((id) => attemptsByTask[id] ?? [])
  return { task, parent, subtasks, siblings, attempts }
}

function promptTitle(prompt?: string): string {
  const firstLine = (prompt?.split(/\r?\n/).find((line) => line.trim()) ?? '').trim()
  if (!firstLine) return 'Untitled task'
  return Array.from(firstLine).slice(0, MAX_PROMPT_TITLE_LENGTH).join('')
}

interface PrepareSessionTaskInput {
  /** A session that already has a provider conversation has passed its first
   * dispatch and is permanently outside automatic minting. */
  existingAgentSessionId?: string | null
  /** Bind this task instead of minting a new one. */
  existingTaskId?: string | null
  /** Mint the session-born task as a direct child of this task. */
  parentTaskId?: string | null
  sessionId?: string
  projectKey?: string | null
  prompt?: string
  originSessionId?: string | null
}

/** First-dispatch boundary: mint a session-born task or bind an explicit
 * existing one, in a single transaction with the optional session link. Returns
 * null for a resumed provider session — the no-backfill rule — in which case no
 * read, write, notification, or repair happens. */
export async function prepareSessionTask(input: PrepareSessionTaskInput): Promise<Task | null> {
  if (input.existingAgentSessionId) return null
  const task = withTx(() => {
    const db = database()
    const now = Date.now()
    const existingTaskId = normalizedOptional(input.existingTaskId)
    const parentTaskId = normalizedOptional(input.parentTaskId)
    if (existingTaskId && parentTaskId) {
      throw new Error('A session cannot bind an existing task and create a subtask at the same time.')
    }
    // A session can execute inside a managed worktree, but its task still
    // belongs to the base project shown by the sidebar and project filters.
    const rawProjectKey = normalizedOptional(input.projectKey)
    const projectKey = rawProjectKey ? worktreeProjectRoot(rawProjectKey) : null
    let task: Task
    if (existingTaskId) {
      const existing = requireTask(existingTaskId, db)
      db.prepare(`
        UPDATE tasks SET
          project_key = COALESCE(project_key, ?),
          status = CASE WHEN status IN ('inbox', 'todo') THEN 'in_progress' ELSE status END,
          triaged_at = CASE
            WHEN status IN ('inbox', 'todo') THEN COALESCE(triaged_at, ?)
            ELSE triaged_at
          END,
          updated_at = ?
        WHERE id = ?
      `).run(projectKey, now, now, existingTaskId)
      // This promotes inbox/todo straight to in_progress without going through
      // updateTask, so the diff has to happen here or the move is unrecorded.
      const updated = requireTask(existingTaskId, db)
      diffTaskEvents(db, existingTaskId, existing, updated, { actor: 'agent' }, now)
      task = taskFromRow(updated)
    } else {
      task = writeTask(db, {
        title: promptTitle(input.prompt),
        projectKey,
        parentId: parentTaskId,
        status: 'in_progress',
        source: 'session',
        originSessionId: input.originSessionId ?? input.sessionId,
        titleSource: 'prompt',
        now,
      })
    }

    if (input.sessionId) {
      writeSessionLink(db, task.id, input.sessionId, 'working', {
        originSessionId: input.originSessionId,
      }, now)
      task = taskFromRow(requireTask(task.id, db))
    }
    return task
  })
  // A provider session id is not available during the usual pre-launch mint.
  // Publishing that half-finished record makes clients briefly render both the
  // durable task and its still-loose session. The later linkSession write emits
  // once the task and session can be read as one coherent sidebar snapshot.
  if (input.sessionId) emitChanged()
  return task
}

/** Name and describe the task minted for a session's opening turn. Each field
 * keeps its own race guard: a human title or body edit remains authoritative,
 * while an edit to one field does not prevent generated metadata filling the
 * other. Linked attempts cannot rename or describe an existing parent task. */
export async function updateGeneratedMetadataForSession(
  sessionId: string,
  title: string,
  description: string,
): Promise<Task | null> {
  const generatedTitle = title.trim()
  const generatedDescription = description.trim()
  if (!generatedTitle || !generatedDescription) return null
  const task = withTx(() => {
    const db = database()
    const taskSessionId = stableSessionIdForProviderThread(sessionId, db) ?? sessionId
    const row = generatedMetadataTaskRowSchema.nullish().parse(db.prepare(`
      SELECT tasks.id, tasks.title_source, tasks.body
      FROM tasks
      JOIN task_session_links ON task_session_links.task_id = tasks.id
      WHERE task_session_links.session_id = ?
        AND task_session_links.role = 'working'
        AND tasks.source = 'session'
        AND tasks.origin_session_id = task_session_links.session_id
      ORDER BY task_session_links.linked_at DESC
      LIMIT 1
    `).get(taskSessionId))
    if (!row) return null
    const canUpdateTitle = row.title_source === 'prompt'
    const canUpdateDescription = row.body.trim() === ''
    if (!canUpdateTitle && !canUpdateDescription) return null
    const now = Date.now()
    db.prepare(`
      UPDATE tasks SET
        title = CASE WHEN title_source = 'prompt' THEN ? ELSE title END,
        title_source = CASE WHEN title_source = 'prompt' THEN 'generated' ELSE title_source END,
        body = CASE WHEN TRIM(body) = '' THEN ? ELSE body END,
        updated_at = ?
      WHERE id = ?
    `).run(generatedTitle, generatedDescription, now, row.id)
    return taskFromRow(requireTask(row.id, db))
  })
  if (task) emitChanged()
  return task
}
