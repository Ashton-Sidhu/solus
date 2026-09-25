import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { stableSessionIdForProviderThread } from '../sessions/session-lineage'
import { getDatabase, type Db } from '../db/database'
import { persistRemoteSessionStart } from '../db/session-indexer'
import { appendTaskEvent, diffTaskEvents, type EventActor } from './task-events'
import { sessionRecordsFor, sessionTitleFor, type SessionRecord } from './host-records'
import { taskComments, taskLinks, taskSessionLinks, tasks } from './schema'
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
import { isUlid } from '@solus/contracts/ulid'
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
  /** Legacy capture — populated by earlier versions, read-only today. */
  pr: z.string().nullable(),
  linked_at: z.number(),
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

/** A link whose session is not indexed yet reads as a session with nothing known about it. */
const UNINDEXED_SESSION: SessionRecord = {
  session_id: '',
  session_title: null,
  session_provider: null,
  session_model: null,
  session_server_id: null,
  branch: null,
  checkout_path: null,
  session_is_worktree: null,
  session_started_at: null,
  last_activity_at: null,
}

/** A link row joined to its session's display metadata. Every link the
 * renderer sees comes through here: a second reader that skipped the session
 * record once already shipped a sidebar full of sessions named after their
 * parent task and a task panel full of raw session ids. */
function linkFromRow(row: TaskSessionLinkRow, session: SessionRecord = UNINDEXED_SESSION): TaskSessionLink {
  const link: TaskSessionLink = {
    taskId: row.task_id,
    sessionId: row.session_id,
    sessionTitle: session.session_title,
    provider: session.session_provider === 'claude' ? 'claude-code' : session.session_provider,
    model: session.session_model,
    startedAt: session.session_started_at,
    lastActivityAt: session.last_activity_at,
    // Execution facts are projected from the session row. The relationship
    // itself owns no host or checkout metadata.
    executionServerId: session.session_server_id,
    role: row.role,
    linkedAt: row.linked_at,
  }
  if (session.branch !== null) link.branch = session.branch
  if (session.checkout_path) link.checkoutPath = session.checkout_path
  if (session.session_is_worktree !== null) link.isolatedCheckout = session.session_is_worktree === 1
  const pr = jsonValue(row.pr, taskPrSchema)
  if (pr) link.pr = pr
  return link
}

function linksFromRows(rows: TaskSessionLinkRow[]): TaskSessionsByTask {
  const sessions = sessionRecordsFor(rows.map((row) => row.session_id))
  const links: TaskSessionsByTask = {}
  for (const row of rows) (links[row.task_id] ??= []).push(linkFromRow(row, sessions.get(row.session_id)))
  return links
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
export async function writeSessionLink(
  db: Db,
  organizationId: string,
  taskId: string,
  sessionId: string,
  role: TaskSessionRole,
  details: SessionLinkDetails,
  now: number,
): Promise<void> {
  await requireTask(organizationId, taskId, db)
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
  const isNewLink = !(await db.get(sql`
    SELECT 1 AS present FROM ${taskSessionLinks} WHERE task_id = ${taskId} AND session_id = ${sessionId}
  `))
  if (role === 'working') await transferSessionOwnership(db, organizationId, taskId, sessionId, now)
  await db.run(sql`
    INSERT INTO ${taskSessionLinks}(task_id, session_id, role, linked_at, organization_id)
    VALUES (${taskId}, ${sessionId}, ${role}, ${now}, ${organizationId})
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      role = excluded.role
  `)
  await db.run(sql`
    UPDATE ${tasks} SET
      origin_session_id = COALESCE(origin_session_id, ${normalizedOptional(details.originSessionId) ?? sessionId}),
      updated_at = ${now}
    WHERE id = ${taskId}
  `)

  if (isNewLink) {
    await appendTaskEvent(db, organizationId, taskId, {
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
 * the client's first-dispatch bind, the agent's `link_task` with kind=session, an
 * automation, an older build. A `referenced` link is a relationship, not
 * ownership, and is left alone.
 */
async function transferSessionOwnership(
  db: Db,
  organizationId: string,
  taskId: string,
  sessionId: string,
  now: number,
): Promise<void> {
  const previousOwners = previousOwnerRowSchema.array().parse(await db.all(sql`
    SELECT task_session_links.task_id, tasks.source, tasks.origin_session_id
    FROM ${taskSessionLinks}
    JOIN ${tasks} ON tasks.id = task_session_links.task_id
    WHERE tasks.organization_id = ${organizationId}
      AND task_session_links.session_id = ${sessionId}
      AND task_session_links.role = 'working'
      AND task_session_links.task_id <> ${taskId}
  `))
  for (const owner of previousOwners) {
    await deleteSessionLink(db, organizationId, owner.task_id, sessionId, {}, now)
    if (owner.source !== 'session' || owner.origin_session_id !== sessionId) continue
    // The placeholder minted for this session is empty once the session leaves
    // it: nothing else links to it, nothing hangs under it, nobody wrote on it.
    // Anything more than that makes it a task in its own right, which stays.
    const stillHoldsSomething = await db.get(sql`
      SELECT 1 AS present FROM ${taskSessionLinks} WHERE task_id = ${owner.task_id}
      UNION ALL SELECT 1 AS present FROM ${tasks} WHERE parent_id = ${owner.task_id}
      UNION ALL SELECT 1 AS present FROM ${taskComments} WHERE task_id = ${owner.task_id}
      UNION ALL SELECT 1 AS present FROM ${taskLinks} WHERE task_id = ${owner.task_id}
      LIMIT 1
    `)
    if (!stillHoldsSomething) await db.run(sql`DELETE FROM ${tasks} WHERE id = ${owner.task_id}`)
  }
}

/** Returns false when there was nothing to unlink, so the caller can skip the
 * change broadcast on a no-op. Removes only the attempt row: the task's
 * origin capture stays put. Runs
 * inside the caller's transaction; the public write is the `Task` object's
 * `unlinkSession`. */
export async function deleteSessionLink(
  db: Db,
  organizationId: string,
  taskId: string,
  sessionId: string,
  actor: EventActor = {},
  now = Date.now(),
): Promise<boolean> {
  await requireTask(organizationId, taskId, db)
  const removed = (await db.run(sql`
    DELETE FROM ${taskSessionLinks} WHERE task_id = ${taskId} AND session_id = ${sessionId}
  `)).changes > 0
  if (!removed) return false
  await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${taskId}`)
  // Carries the session's display title so the feed still reads
  // "unlinked <name>" after the link is gone. Null when it was never indexed.
  await appendTaskEvent(db, organizationId, taskId, {
    ...actor,
    kind: 'unlinked',
    targetKind: 'session',
    targetKey: sessionId,
    targetTitle: sessionTitleFor(sessionId),
  }, now)
  return true
}

/** Move the existing task attempt onto the stable Solus id when that session
 * first enters a new handoff chain. Ordinary and older sessions are untouched. */
export async function rekeyTaskSessionLinks(
  organizationId: string,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  if (sourceSessionId === targetSessionId) return
  const changed = await database().transaction(async (db) => {
    const rows = rekeySessionLinkRowSchema.array().parse(await db.all(sql`
      SELECT task_id, role, pr, linked_at
      FROM ${taskSessionLinks}
      WHERE organization_id = ${organizationId} AND session_id = ${sourceSessionId}
    `))
    for (const row of rows) {
      await db.run(sql`
        INSERT INTO ${taskSessionLinks}(task_id, session_id, role, pr, linked_at, organization_id)
        VALUES (${row.task_id}, ${targetSessionId}, ${row.role}, ${row.pr}, ${row.linked_at}, ${organizationId})
        ON CONFLICT(task_id, session_id) DO UPDATE SET
          role = excluded.role,
          pr = COALESCE(excluded.pr, task_session_links.pr),
          linked_at = CASE
            WHEN excluded.linked_at < task_session_links.linked_at THEN excluded.linked_at
            ELSE task_session_links.linked_at
          END
      `)
    }
    if (rows.length) {
      await db.run(sql`
        DELETE FROM ${taskSessionLinks} WHERE organization_id = ${organizationId} AND session_id = ${sourceSessionId}
      `)
      await db.run(sql`
        UPDATE ${tasks} SET origin_session_id = ${targetSessionId}
        WHERE organization_id = ${organizationId} AND origin_session_id = ${sourceSessionId}
      `)
    }
    return rows.length > 0
  })
  if (changed) emitChanged()
}

/** Task-keyed attempts for either one task or the complete global store. */
export async function taskSessions(organizationId: string, taskId?: string): Promise<TaskSessionsByTask> {
  const rowValues = taskId
    ? await getDatabase().all(sql`
        SELECT task_id, session_id, role, pr, linked_at FROM ${taskSessionLinks}
        WHERE organization_id = ${organizationId} AND task_id = ${taskId}
        ORDER BY linked_at, session_id
      `)
    : await getDatabase().all(sql`
        SELECT task_id, session_id, role, pr, linked_at FROM ${taskSessionLinks}
        WHERE organization_id = ${organizationId}
        ORDER BY linked_at, task_id, session_id
      `)
  return linksFromRows(taskSessionLinkRowSchema.array().parse(rowValues))
}

/** The task a session works on: its owner first, a later `referenced` relationship never outranks it. */
export async function taskIdForSession(organizationId: string, sessionId: string): Promise<string | null> {
  const link = taskIdRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT task_id FROM ${taskSessionLinks}
    WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    ORDER BY CASE role WHEN 'working' THEN 0 ELSE 1 END, linked_at DESC
    LIMIT 1
  `))
  return link?.task_id ?? null
}

/** Resolve a session into the durable two-level task tree without loading or
 * starting any sibling sessions. */
export async function tasksForSession(organizationId: string, sessionId: string): Promise<TaskForSessionResult | null> {
  const taskId = await taskIdForSession(organizationId, sessionId)
  return taskId ? taskTree(organizationId, taskId) : null
}

/** The two-level tree `taskId` belongs to: the task, its root, the root's
 *  subtasks, and every session attempt on any of them. */
export async function taskTree(organizationId: string, taskId: string): Promise<TaskForSessionResult | null> {
  const task = await loadTaskRecord(organizationId, taskId)
  if (!task) return null
  const parent = task.parentId ? await loadTaskRecord(organizationId, task.parentId) : null
  const rootId = parent?.id ?? task.id
  const subtasks = await listTaskChildren(organizationId, rootId)
  const siblings = task.parentId ? subtasks.filter((subtask) => subtask.id !== task.id) : []
  const attemptsByTask = await taskSessions(organizationId)
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
  /** Mint the task under this client-minted ULID instead of a fresh one. */
  taskId?: string | null
  sessionId?: string
  projectKey?: string | null
  prompt?: string
  originSessionId?: string | null
}

/**
 * The id a new session-born task is written under. A client mints it when it
 * makes the session so the row it already shows keeps its identity, and one
 * id names one task: an id that already names a task is refused, never bound,
 * because two sessions arriving with one id is a client bug, not a retry.
 */
async function clientMintedTaskId(
  db: Db,
  organizationId: string,
  taskId: string | null,
): Promise<string | undefined> {
  if (!taskId) return undefined
  if (!isUlid(taskId)) throw new Error(`Task id ${taskId} is not a ULID.`)
  const existing = await db.get(sql`
    SELECT id FROM ${tasks} WHERE id = ${taskId} AND organization_id = ${organizationId}
  `)
  if (existing) throw new Error(`Task ${taskId} already exists.`)
  return taskId
}

/** First-dispatch boundary: mint a session-born task or bind an explicit
 * existing one, in a single transaction with the optional session link. Returns
 * null for a resumed provider session — the no-backfill rule — in which case no
 * read, write, notification, or repair happens. */
export async function prepareSessionTask(organizationId: string, input: PrepareSessionTaskInput): Promise<Task | null> {
  if (input.existingAgentSessionId) return null
  const task = await database().transaction(async (db) => {
    const now = Date.now()
    const existingTaskId = normalizedOptional(input.existingTaskId)
    const mintedTaskId = normalizedOptional(input.taskId)
    if (existingTaskId && mintedTaskId) {
      throw new Error('A session cannot bind an existing task and name a new one at the same time.')
    }
    // A session can execute inside a managed worktree, but its task still
    // belongs to the base project shown by the sidebar and project filters.
    const rawProjectKey = normalizedOptional(input.projectKey)
    const projectKey = rawProjectKey ? worktreeProjectRoot(rawProjectKey) : null
    let task: Task
    if (existingTaskId) {
      const existing = await requireTask(organizationId, existingTaskId, db)
      await db.run(sql`
        UPDATE ${tasks} SET
          project_key = COALESCE(project_key, ${projectKey}),
          status = CASE WHEN status IN ('inbox', 'todo') THEN 'in_progress' ELSE status END,
          triaged_at = CASE
            WHEN status IN ('inbox', 'todo') THEN COALESCE(triaged_at, ${now})
            ELSE triaged_at
          END,
          updated_at = ${now}
        WHERE id = ${existingTaskId}
      `)
      // This promotes inbox/todo straight to in_progress without going through
      // updateTask, so the diff has to happen here or the move is unrecorded.
      const updated = await requireTask(organizationId, existingTaskId, db)
      await diffTaskEvents(db, organizationId, existingTaskId, existing, updated, { actor: 'agent' }, now)
      task = taskFromRow(updated)
    } else {
      task = await writeTask(db, organizationId, {
        id: await clientMintedTaskId(db, organizationId, mintedTaskId),
        title: promptTitle(input.prompt),
        projectKey,
        status: 'in_progress',
        source: 'session',
        originSessionId: input.originSessionId ?? input.sessionId,
        titleSource: 'prompt',
        now,
      })
    }

    if (input.sessionId) {
      await writeSessionLink(db, organizationId, task.id, input.sessionId, 'working', {
        originSessionId: input.originSessionId,
      }, now)
      task = taskFromRow(await requireTask(organizationId, task.id, db))
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
  organizationId: string,
  sessionId: string,
  title: string,
  description: string,
): Promise<Task | null> {
  const generatedTitle = title.trim()
  const generatedDescription = description.trim()
  if (!generatedTitle || !generatedDescription) return null
  const task = await database().transaction(async (db) => {
    const taskSessionId = stableSessionIdForProviderThread(sessionId) ?? sessionId
    const row = generatedMetadataTaskRowSchema.nullish().parse(await db.get(sql`
      SELECT tasks.id, tasks.title_source, tasks.body
      FROM ${tasks}
      JOIN ${taskSessionLinks} ON task_session_links.task_id = tasks.id
      WHERE tasks.organization_id = ${organizationId}
        AND task_session_links.session_id = ${taskSessionId}
        AND task_session_links.role = 'working'
        AND tasks.source = 'session'
        AND tasks.origin_session_id = task_session_links.session_id
      ORDER BY task_session_links.linked_at DESC
      LIMIT 1
    `))
    if (!row) return null
    const canUpdateTitle = row.title_source === 'prompt'
    const canUpdateDescription = row.body.trim() === ''
    if (!canUpdateTitle && !canUpdateDescription) return null
    const now = Date.now()
    await db.run(sql`
      UPDATE ${tasks} SET
        title = CASE WHEN title_source = 'prompt' THEN ${generatedTitle} ELSE title END,
        title_source = CASE WHEN title_source = 'prompt' THEN 'generated' ELSE title_source END,
        body = CASE WHEN TRIM(body) = '' THEN ${generatedDescription} ELSE body END,
        updated_at = ${now}
      WHERE id = ${row.id}
    `)
    return taskFromRow(await requireTask(organizationId, row.id, db))
  })
  if (task) emitChanged()
  return task
}
