import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import { persistRemoteSessionStart } from '../../db/session-indexer'
import type { Attribution } from '@solus/contracts/user'
import { diffTaskActivity, taskChanged } from './task-activity'
import { appendActivity } from '../activity/activity'
import { agentAttribution, attributionJson, parseStoredAttribution } from '../stored-attribution'
import { sessionRecordsFor, sessionTitleFor, type SessionRecord } from './host-records'
import { taskSessionLinks, tasks } from './schema'
import { deleteSessionOutputLinks } from './task-links'
import {
  database,
  emitChanged,
  jsonValue,
  loadTaskRecord,
  normalizedOptional,
  requireTask,
  TASK_HERE,
  taskPrSchema,
  taskFromRow,
} from './task-store'
import { scopeClause } from '../scope'
import type { RecordScope } from '../../admission/principal'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type {
  SessionExecutionHost,
  Task,
  TaskForSessionResult,
  TaskSessionLink,
  TaskSessionRole,
} from '@solus/contracts/task-types'

/** The session↔task binding store: attempt rows in `task_session_links`, the
 * first-dispatch bind, and the session-keyed reads the sidebar and breadcrumb
 * hydrate from. */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
const taskSessionRoleSchema = z.enum(['lead', 'working', 'referenced'])
const taskSessionLinkRowSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  role: taskSessionRoleSchema,
  /** Legacy capture — populated by earlier versions, read-only today. */
  pr: z.string().nullable(),
  linked_at: z.number(),
  started_by: z.string().nullable(),
})
const taskIdRowSchema = z.object({ task_id: z.string() })
const sessionIdRowSchema = z.object({ session_id: z.string() })

type TaskSessionLinkRow = z.infer<typeof taskSessionLinkRowSchema>
interface TaskSessionsByTask {
  [taskId: string]: TaskSessionLink[]
}

/** A link whose session is not indexed yet reads as a session with nothing known about it. */
const UNINDEXED_SESSION: SessionRecord = {
  session_id: '',
  agent_session_id: null,
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
  const startedBy = parseStoredAttribution(row.started_by)
  if (startedBy) link.startedBy = startedBy
  if (session.agent_session_id && session.agent_session_id !== row.session_id) link.agentSessionId = session.agent_session_id
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
  /** Stamps a task that has no origin session yet. Existing provenance is
   * never replaced. */
  originSessionId?: string | null
  /** Who started the session. Kept from the first writer that knew it. */
  startedBy?: Attribution | null
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
): Promise<boolean> {
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
  if (role === 'lead') await requireNoOtherLead(db, taskId, sessionId)
  // A lead owns its session exactly as a working attempt does.
  if (role !== 'referenced') await transferSessionOwnership(db, organizationId, taskId, sessionId, now)
  await db.run(sql`
    INSERT INTO ${taskSessionLinks}(task_id, session_id, role, linked_at, started_by, organization_id)
    VALUES (${taskId}, ${sessionId}, ${role}, ${now}, ${details.startedBy ? attributionJson(details.startedBy) : null}, ${organizationId})
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      role = excluded.role,
      started_by = COALESCE(task_session_links.started_by, excluded.started_by)
  `)
  await db.run(sql`
    UPDATE ${tasks} SET
      origin_session_id = COALESCE(origin_session_id, ${normalizedOptional(details.originSessionId) ?? sessionId}),
      updated_at = ${now}
    WHERE id = ${taskId}
  `)

  if (isNewLink) {
    await appendActivity(organizationId, taskChanged(taskId, agentAttribution(sessionId), 'session_started', {
      target: { kind: 'session', key: sessionId },
    }, now), db)
  }
  return isNewLink
}

/**
 * A task has at most one lead (docs/plans/task-conversation.md). There is no
 * promotion or release: only a session started as lead is lead, and a second
 * one is refused rather than demoting the first, so the task page's
 * conversation never changes hands underneath the person reading it.
 */
async function requireNoOtherLead(db: Db, taskId: string, sessionId: string): Promise<void> {
  const lead = sessionIdRowSchema.nullish().parse(await db.get(sql`
    SELECT session_id FROM ${taskSessionLinks}
    WHERE task_id = ${taskId} AND role = 'lead' AND session_id <> ${sessionId}
    LIMIT 1
  `))
  if (lead) throw new Error('This task already has a lead session.')
}

/**
 * A session has one owning task. Writing a `working` link elsewhere transfers
 * that ownership: every other task's working attempt on the session goes.
 *
 * This is the rule that keeps one conversation from projecting under two
 * sidebar rows, and it lives here so it holds for every writer of the row —
 * the client's first-dispatch bind, the agent's `link` with kind=session,
 * an automation. A `referenced` link is a relationship, not ownership, and is
 * left alone.
 */
async function transferSessionOwnership(
  db: Db,
  organizationId: string,
  taskId: string,
  sessionId: string,
  now: number,
): Promise<void> {
  const previousOwners = taskIdRowSchema.array().parse(await db.all(sql`
    SELECT task_session_links.task_id
    FROM ${taskSessionLinks}
    JOIN ${tasks} ON tasks.id = task_session_links.task_id
    WHERE tasks.organization_id = ${organizationId} AND ${TASK_HERE}
      AND task_session_links.session_id = ${sessionId}
      AND task_session_links.role <> 'referenced'
      AND task_session_links.task_id <> ${taskId}
  `))
  for (const owner of previousOwners) {
    // Solus moves the session; nobody unlinked it by hand.
    await deleteSessionLink(db, organizationId, owner.task_id, sessionId, { kind: 'system' }, now)
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
  by: Attribution,
  now = Date.now(),
): Promise<boolean> {
  await requireTask(organizationId, taskId, db)
  const removed = (await db.run(sql`
    DELETE FROM ${taskSessionLinks} WHERE task_id = ${taskId} AND session_id = ${sessionId}
  `)).changes > 0
  if (!removed) return false
  // What the session made leaves the task with it (docs/plans/session-outputs.md).
  await deleteSessionOutputLinks(db, taskId, sessionId)
  await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${taskId}`)
  // Carries the session's display title so the feed still reads
  // "unlinked <name>" after the link is gone. Null when it was never indexed.
  const title = sessionTitleFor(sessionId)
  await appendActivity(organizationId, taskChanged(taskId, by, 'unlinked', {
    target: title ? { kind: 'session', key: sessionId, title } : { kind: 'session', key: sessionId },
  }, now), db)
  return true
}

/** A moved task keeps its links as history on this host (cloud-sharing.md §3a);
 *  its sessions are listed by the organization's copy, not here. */
const ON_A_TASK_HERE = sql`EXISTS (SELECT 1 FROM ${tasks} WHERE tasks.id = task_session_links.task_id AND ${TASK_HERE})`

/** Task-keyed attempts for the named tasks, or for the complete global store. */
export async function taskSessions(scope: RecordScope, taskIds?: string | readonly string[]): Promise<TaskSessionsByTask> {
  const ids = typeof taskIds === 'string' ? [taskIds] : taskIds
  if (ids && !ids.length) return {}
  const rowValues = ids
    ? await getDatabase().all(sql`
        SELECT task_id, session_id, role, pr, linked_at, started_by FROM ${taskSessionLinks}
        WHERE ${scopeClause(scope)} AND ${ON_A_TASK_HERE} AND task_id IN (${sql.join(ids.map((taskId) => sql`${taskId}`), sql`, `)})
        ORDER BY linked_at, task_id, session_id
      `)
    : await getDatabase().all(sql`
        SELECT task_id, session_id, role, pr, linked_at, started_by FROM ${taskSessionLinks}
        WHERE ${scopeClause(scope)} AND ${ON_A_TASK_HERE}
        ORDER BY linked_at, task_id, session_id
      `)
  return linksFromRows(taskSessionLinkRowSchema.array().parse(rowValues))
}

/** The task a session works on: its owner first, a later `referenced` relationship never outranks it. */
export async function taskIdForSession(scope: RecordScope, sessionId: string): Promise<string | null> {
  const link = taskIdRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT task_id FROM ${taskSessionLinks}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    ORDER BY CASE role WHEN 'referenced' THEN 1 ELSE 0 END, linked_at DESC
    LIMIT 1
  `))
  return link?.task_id ?? null
}

/** Whether the session is the lead of a task. */
export async function sessionIsLead(scope: RecordScope, sessionId: string): Promise<boolean> {
  const link = taskIdRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT task_id FROM ${taskSessionLinks}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND role = 'lead'
    LIMIT 1
  `))
  return !!link
}

/** A session's title or branch shows on the attempt rows of every task linked
 * to it, and on no other task. Announce those tasks alone; a session with no
 * task changes no task. */
export async function emitSessionTasksChanged(scope: RecordScope, sessionId: string): Promise<void> {
  const rows = taskIdRowSchema.array().parse(await getDatabase().all(sql`
    SELECT DISTINCT task_id FROM ${taskSessionLinks}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
  `))
  for (const row of rows) emitChanged(row.task_id)
}

/** Resolve a session into its task and every session attempt on that task,
 * without loading or starting any of those sessions. */
export async function tasksForSession(scope: RecordScope, sessionId: string): Promise<TaskForSessionResult | null> {
  const taskId = await taskIdForSession(scope, sessionId)
  return taskId ? taskWithAttempts(scope, taskId) : null
}

/** One task and the session attempts on it. */
export async function taskWithAttempts(scope: RecordScope, taskId: string): Promise<TaskForSessionResult | null> {
  const task = await loadTaskRecord(scope, taskId)
  if (!task) return null
  return { task, attempts: (await taskSessions(scope, taskId))[taskId] ?? [] }
}

interface PrepareSessionTaskInput {
  /** A session that already has a provider conversation has passed its first
   * dispatch: its task is bound already. */
  existingAgentSessionId?: string | null
  /** The task the session joins. */
  taskId: string
  sessionId?: string
  projectKey?: string | null
  originSessionId?: string | null
  /** Start the session as the task's lead. Refused when the task has one. */
  role?: 'lead'
}

/** First-dispatch boundary: bind the task a session names, in a single
 * transaction with the optional session link. A session never makes a task of
 * its own (docs/plans/task-conversation.md, decision 8). Returns null for a
 * resumed provider session, in which case no read, write, notification, or
 * repair happens.
 *
 * `scope` is what the caller may read: the task is found inside it and its
 * link lands in that task's own organization. */
export async function prepareSessionTask(
  scope: RecordScope,
  input: PrepareSessionTaskInput,
): Promise<Task | null> {
  if (input.existingAgentSessionId) return null
  const task = await database().transaction(async (db) => {
    const now = Date.now()
    // A session can execute inside a managed worktree, but its task still
    // belongs to the base project shown by the sidebar and project filters.
    const rawProjectKey = normalizedOptional(input.projectKey)
    const projectKey = rawProjectKey ? worktreeProjectRoot(rawProjectKey) : null
    const existing = await requireTask(scope, input.taskId, db)
    const organizationId = existing.organization_id
    // Checked here, before the session exists, so the refusal reaches the
    // client that asked instead of a link write the run has already left
    // behind. The link write checks again for every other writer.
    if (input.role === 'lead') await requireNoOtherLead(db, input.taskId, input.sessionId ?? '')
    await db.run(sql`
      UPDATE ${tasks} SET
        project_key = COALESCE(project_key, ${projectKey}),
        status = CASE WHEN status IN ('inbox', 'todo') THEN 'in_progress' ELSE status END,
        triaged_at = CASE
          WHEN status IN ('inbox', 'todo') THEN COALESCE(triaged_at, ${now})
          ELSE triaged_at
        END,
        updated_at = ${now}
      WHERE id = ${input.taskId}
    `)
    // This promotes inbox/todo straight to in_progress without going through
    // updateTask, so the diff has to happen here or the move is unrecorded.
    const updated = await requireTask(scope, input.taskId, db)
    await diffTaskActivity(db, organizationId, input.taskId, existing, updated, agentAttribution(input.sessionId ?? input.originSessionId), now)
    if (!input.sessionId) return taskFromRow(updated)
    await writeSessionLink(db, organizationId, input.taskId, input.sessionId, input.role ?? 'working', {
      originSessionId: input.originSessionId,
    }, now)
    return taskFromRow(await requireTask(organizationId, input.taskId, db))
  })
  // A provider session id is not available during the usual pre-launch bind.
  // The later linkSession write emits once the task and session can be read as
  // one coherent sidebar snapshot.
  if (input.sessionId) emitChanged(task.id)
  return task
}
