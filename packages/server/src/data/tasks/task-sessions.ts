import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import { persistRemoteSessionStart } from '../../db/session-indexer'
import type { Attribution } from '@solus/contracts/user'
import { taskChanged } from './task-activity'
import { appendActivity } from '../activity/activity'
import { agentAttribution, attributionJson, parseStoredAttribution } from '../stored-attribution'
import { sessionRecordsFor, sessionTitleFor, type SessionRecord } from './host-records'
import { resourceLinks } from '../links/schema'
import { creatorOf, provenanceOf } from '../links/resource-links'
import { deleteSessionOutputLinks } from './task-links'
import { assertTaskKey, emitChanged, loadTask, normalizedOptional } from './task-store'
import { scopeClause } from '../scope'
import { sessionIdOfThread } from '../sessions/session-lineage'
import { sessionIdentityOf } from '../sessions/session-identity'
import type { RecordScope } from '../../admission/principal'
import type {
  SessionExecutionHost,
  TaskForSessionResult,
  TaskSessionLink,
  TaskSessionRole,
} from '@solus/contracts/task-types'

/** The session↔task binding store: the task→session edges of `resource_links`
 * (`works-on`, or `reference` for a session the task only mentions) and the
 * session-keyed reads the sidebar and breadcrumb hydrate from. A session link
 * is an attachment: it keys on the task key and needs no row in `tasks`
 * (docs/plans/provider-owned-tasks.md §4.3). Its organization is the
 * session's. */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode', 'replay'])
const relationSchema = z.enum(['works-on', 'reference'])
const taskSessionLinkRowSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  relation: relationSchema,
  created_at: z.number(),
  author: z.string().nullable(),
})
const taskIdRowSchema = z.object({ task_id: z.string() })
const edgeOrganizationRowSchema = z.object({ organization_id: z.string() })

type TaskSessionLinkRow = z.infer<typeof taskSessionLinkRowSchema>
interface TaskSessionsByTask {
  [taskId: string]: TaskSessionLink[]
}

/** A task's session edge. */
const TASK_SESSION = sql`resource_links.source_kind = 'task' AND resource_links.target_kind = 'session'`
const ROW_COLUMNS = sql`resource_links.source_id AS task_id, resource_links.target_key AS session_id, resource_links.relation, resource_links.created_at, resource_links.author`

function relationOf(role: TaskSessionRole): 'works-on' | 'reference' {
  return role === 'referenced' ? 'reference' : 'works-on'
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
    role: row.relation === 'reference' ? 'referenced' : 'working',
    linkedAt: row.created_at,
  }
  const startedBy = parseStoredAttribution(row.author)
  if (startedBy) link.startedBy = startedBy
  if (session.agent_session_id && session.agent_session_id !== row.session_id) link.agentSessionId = session.agent_session_id
  if (session.branch !== null) link.branch = session.branch
  if (session.checkout_path) link.checkoutPath = session.checkout_path
  if (session.session_is_worktree !== null) link.isolatedCheckout = session.session_is_worktree === 1
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
  /** Who started the session. Kept from the first writer that knew it. */
  startedBy?: Attribution | null
}

/**
 * Writes the attempt edge. Runs inside the caller's transaction; the public
 * write is `linkTaskSession`. The edge is in the session's organization;
 * `organizationId` is the caller's, for a session that has no record yet.
 * Answers whether the link is new.
 */
export async function writeSessionLink(
  db: Db,
  callerOrganizationId: string,
  taskId: string,
  sessionId: string,
  role: TaskSessionRole,
  details: SessionLinkDetails,
  now: number,
): Promise<boolean> {
  assertTaskKey(taskId)
  const organizationId = (await sessionIdentityOf(sessionId, db))?.organizationId ?? callerOrganizationId
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
    SELECT 1 AS present FROM ${resourceLinks} WHERE ${TASK_SESSION} AND resource_links.organization_id = ${organizationId}
      AND resource_links.source_id = ${taskId} AND resource_links.target_key = ${sessionId}
  `))
  if (role !== 'referenced') await transferSessionOwnership(db, organizationId, taskId, sessionId, now)
  const startedBy = details.startedBy ?? null
  const createdBy = await creatorOf(startedBy ?? { kind: 'system' }, async () => null)
  await db.run(sql`
    INSERT INTO ${resourceLinks}(organization_id, source_kind, source_id, target_kind, target_scope, target_key, relation, source, status, author, created_by, created_at)
    VALUES (${organizationId}, 'task', ${taskId}, 'session', '', ${sessionId}, ${relationOf(role)}, ${startedBy ? provenanceOf(startedBy) : 'system'}, 'active',
      ${startedBy ? attributionJson(startedBy) : null}, ${createdBy}, ${now})
    ON CONFLICT(organization_id, source_kind, source_id, target_kind, target_scope, target_key) DO UPDATE SET
      relation = excluded.relation,
      status = 'active',
      author = COALESCE(resource_links.author, excluded.author)
  `)
  if (isNewLink) {
    await appendActivity(organizationId, taskChanged(taskId, agentAttribution(sessionId), 'session_started', {
      target: { kind: 'session', key: sessionId },
    }, now), db)
  }
  return isNewLink
}

/**
 * A session has one owning task. Writing a `working` link elsewhere transfers
 * that ownership: every other task's working attempt on the session goes.
 *
 * This is the rule that keeps one conversation from projecting under two
 * sidebar rows, and it lives here so it holds for every writer of the row —
 * the client's first-dispatch bind, the agent's `link` with kind=session,
 * an automation. A `referenced` link is a relationship, not ownership, and is
 * left alone. The partial unique index `resource_links_working_owner` holds
 * what this transfers.
 */
async function transferSessionOwnership(
  db: Db,
  organizationId: string,
  taskId: string,
  sessionId: string,
  now: number,
): Promise<void> {
  const previousOwners = taskIdRowSchema.array().parse(await db.all(sql`
    SELECT resource_links.source_id AS task_id
    FROM ${resourceLinks}
    WHERE resource_links.organization_id = ${organizationId} AND ${TASK_SESSION} AND resource_links.target_key = ${sessionId}
      AND resource_links.relation = 'works-on' AND resource_links.status = 'active' AND resource_links.source_id <> ${taskId}
  `))
  for (const owner of previousOwners) {
    // Solus moves the session; nobody unlinked it by hand.
    await deleteSessionLink(db, organizationId, owner.task_id, sessionId, { kind: 'system' }, now)
  }
}

/** Returns false when there was nothing to unlink in `scope`, so the caller
 * can skip the change broadcast on a no-op. Runs inside the caller's
 * transaction; the public write is `unlinkTaskSession`. The history of the
 * unlink is in the organization of the link. */
export async function deleteSessionLink(
  db: Db,
  scope: RecordScope,
  taskId: string,
  sessionId: string,
  by: Attribution,
  now = Date.now(),
): Promise<boolean> {
  const edge = sql`${TASK_SESSION} AND resource_links.source_id = ${taskId} AND resource_links.target_key = ${sessionId}
    AND ${scopeClause(scope, sql`resource_links.organization_id`)}`
  const held = edgeOrganizationRowSchema.nullish().parse(await db.get(sql`
    SELECT resource_links.organization_id FROM ${resourceLinks} WHERE ${edge}
  `))
  if (!held) return false
  const organizationId = held.organization_id
  await db.run(sql`DELETE FROM ${resourceLinks} WHERE ${edge}`)
  // What the session made leaves the task with it (docs/plans/session-outputs.md).
  await deleteSessionOutputLinks(db, organizationId, taskId, sessionId)
  // Carries the session's display title so the feed still reads
  // "unlinked <name>" after the link is gone. Null when it was never indexed.
  const title = sessionTitleFor(sessionId)
  await appendActivity(organizationId, taskChanged(taskId, by, 'unlinked', {
    target: title ? { kind: 'session', key: sessionId, title } : { kind: 'session', key: sessionId },
  }, now), db)
  return true
}

/** Task-keyed attempts for the named tasks, or for each task key that has a
 *  session link in `scope`. A key needs no copy of its task on this host. */
export async function taskSessions(scope: RecordScope, taskIds?: string | readonly string[]): Promise<TaskSessionsByTask> {
  const ids = taskIds === undefined || Array.isArray(taskIds) ? taskIds : [taskIds]
  if (ids && !ids.length) return {}
  const onlyTasks = ids
    ? sql` AND resource_links.source_id IN (${sql.join(ids.map((taskId) => sql`${taskId}`), sql`, `)})`
    : sql``
  const rowValues = await getDatabase().all(sql`
    SELECT ${ROW_COLUMNS} FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_SESSION} AND resource_links.status = 'active'${onlyTasks}
    ORDER BY resource_links.created_at, resource_links.source_id, resource_links.target_key
  `)
  return linksFromRows(taskSessionLinkRowSchema.array().parse(rowValues))
}

/** The task a session works on: its owner first, a later `referenced` relationship never outranks it. */
export async function taskIdForSession(scope: RecordScope, sessionId: string): Promise<string | null> {
  const link = taskIdRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT resource_links.source_id AS task_id FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_SESSION} AND resource_links.status = 'active' AND resource_links.target_key = ${sessionId}
    ORDER BY CASE resource_links.relation WHEN 'reference' THEN 1 ELSE 0 END, resource_links.created_at DESC
    LIMIT 1
  `))
  return link?.task_id ?? null
}

/** The tasks linked to these sessions. An id may be a provider thread: its
 *  session is the one a link holds (docs/plans/task-snapshot-resume.md). */
export async function taskIdsForSessions(scope: RecordScope, sessionIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(sessionIds.flatMap((id) => [id, sessionIdOfThread(id)]))]
  if (!ids.length) return []
  const rows = taskIdRowSchema.array().parse(await getDatabase().all(sql`
    SELECT DISTINCT resource_links.source_id AS task_id FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_SESSION} AND resource_links.status = 'active'
      AND resource_links.target_key IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `))
  return rows.map((row) => row.task_id)
}

/** A session's title or branch shows on the attempt rows of every task linked
 * to it, and on no other task. Announce those tasks alone; a session with no
 * task changes no task. */
export async function emitSessionTasksChanged(scope: RecordScope, sessionId: string): Promise<void> {
  const rows = taskIdRowSchema.array().parse(await getDatabase().all(sql`
    SELECT DISTINCT resource_links.source_id AS task_id FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_SESSION} AND resource_links.target_key = ${sessionId}
  `))
  for (const row of rows) emitChanged(row.task_id)
}

/** Resolve a session into its task and every session attempt on that task,
 * without loading or starting any of those sessions. */
export async function tasksForSession(scope: RecordScope, sessionId: string): Promise<TaskForSessionResult | null> {
  const taskId = await taskIdForSession(scope, sessionId)
  return taskId ? taskWithAttempts(scope, taskId) : null
}

/** One task and the session attempts on it. Null when this host has no copy
 *  of the task: the session links of the key are still in `taskSessions`. */
export async function taskWithAttempts(scope: RecordScope, taskId: string): Promise<TaskForSessionResult | null> {
  const task = await loadTask(taskId)
  if (!task) return null
  return { task, attempts: (await taskSessions(scope, taskId))[taskId] ?? [] }
}
