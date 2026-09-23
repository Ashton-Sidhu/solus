import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  encodePathAsFolder,
  isSolusWorktreePath,
  SOLUS_WORKTREE_ENCODED_MARKER,
  type AgentId,
  type SessionRecord,
  type SessionRecordStatus,
  type SessionRecordUpsert,
  type SessionStatus,
} from '@solus/contracts/types'
import { getDatabase, type Db } from '../db/database'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { sessionRecords } from './schema'

/**
 * The collaboration plane's session records
 * (docs/plans/cloud-service-model.md). On a host the transcript indexer and the
 * control plane write them in-process as they learn about sessions; in the
 * cloud a runner reports them over `sessionRecordUpsert`. Every read and write
 * names the organization.
 */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
const statusSchema = z.enum(['idle', 'running', 'interrupted'])
const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const recordRowSchema = z.object({
  session_id: z.string(),
  owner_user_id: z.string().nullable(),
  provider: agentIdSchema,
  project_path: z.string(),
  project_remote: z.string().nullable(),
  runner_host_id: z.string().nullable(),
  title: z.string().nullable(),
  custom_title: z.string().nullable(),
  status: statusSchema,
  model: z.string().nullable(),
  reasoning_effort: reasoningEffortSchema.nullable().catch(null),
  parent_session_id: z.string().nullable(),
  root_session_id: z.string().nullable(),
  created_at: z.number(),
  last_activity_at: z.number(),
  size: z.number(),
})

type RecordRow = z.infer<typeof recordRowSchema>

const RECORD_COLUMNS = sql`
  session_id, owner_user_id, provider, project_path, project_remote, runner_host_id, title, custom_title,
  status, model, reasoning_effort, parent_session_id, root_session_id, created_at, last_activity_at, size
`

function recordFromRow(row: RecordRow): SessionRecord {
  return {
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    projectPath: row.project_path,
    projectRemote: row.project_remote,
    runnerHostId: row.runner_host_id,
    title: row.title,
    customTitle: row.custom_title,
    status: row.status,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    size: row.size,
  }
}

async function readRecord(db: Db, organizationId: string, sessionId: string): Promise<SessionRecord | null> {
  const row = recordRowSchema.nullish().parse(await db.get(sql`
    SELECT ${RECORD_COLUMNS} FROM ${sessionRecords}
    WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
  `))
  return row ? recordFromRow(row) : null
}

export async function getSessionRecord(organizationId: string, sessionId: string): Promise<SessionRecord | null> {
  return readRecord(getDatabase(), organizationId, sessionId)
}

/**
 * Writes to one record apply in the order they were asked for. A start report is
 * a read-merge-write while a status change is one update; without this, a
 * turn that settles quickly could see its start report land after its settle
 * and leave the record `running`.
 */
const inFlight = new Map<string, Promise<unknown>>()

function serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(sessionId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  inFlight.set(sessionId, next)
  void next.catch(() => undefined).finally(() => {
    if (inFlight.get(sessionId) === next) inFlight.delete(sessionId)
  })
  return next
}

type SessionRecordListener = (record: SessionRecord) => void
const changedListeners = new Set<SessionRecordListener>()

/**
 * Hear every change this host makes to one of its own (`local`) records, with
 * the whole record as stored: how the runner delivery mirrors them to the
 * workspace service (docs/plans/cloud-service-model.md §16). Never fired for a
 * record another organization owns; a runner reporting into the service is not
 * this host's own fact to forward again.
 */
export function onSessionRecordChanged(listener: SessionRecordListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(organizationId: string, record: SessionRecord | null): void {
  if (organizationId !== LOCAL_ORGANIZATION_ID || !record) return
  for (const listener of changedListeners) listener(record)
}

/** The stored record after a partial write, handed to the listeners. */
async function emitStored(organizationId: string, sessionId: string): Promise<void> {
  if (organizationId !== LOCAL_ORGANIZATION_ID || changedListeners.size === 0) return
  emitChanged(organizationId, await getSessionRecord(organizationId, sessionId))
}

/**
 * Write what the caller knows. A field left out keeps the stored value, so the
 * indexer's sweep and the control plane's status report never erase each
 * other's facts; a field given as null clears it.
 */
/** The reported value when one was given (null included), else what is stored, else nothing. */
function reported<T>(next: T | null | undefined, stored: T | null | undefined): T | null {
  if (next !== undefined) return next
  return stored ?? null
}

/** A session the plane has not seen: every fact absent, born at the report's own time. */
function firstRecord(input: SessionRecordUpsert): SessionRecord {
  return {
    sessionId: input.sessionId,
    ownerUserId: null,
    provider: input.provider,
    projectPath: input.projectPath,
    projectRemote: null,
    runnerHostId: null,
    title: null,
    customTitle: null,
    status: 'idle',
    model: null,
    reasoningEffort: null,
    parentSessionId: null,
    rootSessionId: null,
    createdAt: input.createdAt ?? input.lastActivityAt,
    lastActivityAt: 0,
    size: 0,
  }
}

function mergeRecord(existing: SessionRecord | null, input: SessionRecordUpsert): SessionRecord {
  const stored = existing ?? firstRecord(input)
  return {
    sessionId: input.sessionId,
    ownerUserId: reported(input.ownerUserId, stored.ownerUserId),
    provider: input.provider,
    projectPath: input.projectPath,
    projectRemote: reported(input.projectRemote, stored.projectRemote),
    runnerHostId: reported(input.runnerHostId, stored.runnerHostId),
    title: reported(input.title, stored.title),
    customTitle: reported(input.customTitle, stored.customTitle),
    status: input.status ?? stored.status,
    model: reported(input.model, stored.model),
    reasoningEffort: reported(input.reasoningEffort, stored.reasoningEffort),
    parentSessionId: reported(input.parentSessionId, stored.parentSessionId),
    rootSessionId: reported(input.rootSessionId, stored.rootSessionId),
    createdAt: stored.createdAt,
    lastActivityAt: Math.max(input.lastActivityAt, stored.lastActivityAt),
    size: input.size ?? stored.size,
  }
}

export function upsertSessionRecord(organizationId: string, input: SessionRecordUpsert): Promise<SessionRecord> {
  return serialized(input.sessionId, () => upsertSessionRecordNow(organizationId, input))
}

async function upsertSessionRecordNow(organizationId: string, input: SessionRecordUpsert): Promise<SessionRecord> {
  const merged = await getDatabase().transaction(async (db) => {
    const merged = mergeRecord(await readRecord(db, organizationId, input.sessionId), input)
    await db.run(sql`
      INSERT INTO ${sessionRecords} (
        session_id, organization_id, owner_user_id, provider, project_path, project_remote, runner_host_id,
        title, custom_title, status, model, reasoning_effort, parent_session_id, root_session_id,
        created_at, last_activity_at, size
      ) VALUES (
        ${merged.sessionId}, ${organizationId}, ${merged.ownerUserId}, ${merged.provider}, ${merged.projectPath},
        ${merged.projectRemote}, ${merged.runnerHostId}, ${merged.title}, ${merged.customTitle}, ${merged.status},
        ${merged.model}, ${merged.reasoningEffort}, ${merged.parentSessionId}, ${merged.rootSessionId},
        ${merged.createdAt}, ${merged.lastActivityAt}, ${merged.size}
      )
      ON CONFLICT(session_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        provider = excluded.provider,
        project_path = excluded.project_path,
        project_remote = excluded.project_remote,
        runner_host_id = excluded.runner_host_id,
        title = excluded.title,
        custom_title = excluded.custom_title,
        status = excluded.status,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        parent_session_id = excluded.parent_session_id,
        root_session_id = excluded.root_session_id,
        created_at = excluded.created_at,
        last_activity_at = excluded.last_activity_at,
        size = excluded.size
      WHERE session_records.organization_id = excluded.organization_id
    `)
    return merged
  })
  emitChanged(organizationId, merged)
  return merged
}

/** The transcript is gone from the runner and nothing else holds the session: the record goes with it. */
export function deleteSessionRecord(organizationId: string, sessionId: string): Promise<void> {
  return serialized(sessionId, async () => {
    await getDatabase().run(sql`
      DELETE FROM ${sessionRecords} WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    `)
  })
}

/** The record's status as the control plane reports it; a session with no record yet is left for its start to write. */
export function setSessionRecordStatus(organizationId: string, sessionId: string, status: SessionRecordStatus): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET status = ${status}, last_activity_at = ${Date.now()}
      WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(organizationId, sessionId)
  })
}

export function setSessionRecordTitle(organizationId: string, sessionId: string, customTitle: string | null): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET custom_title = ${customTitle}
      WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(organizationId, sessionId)
  })
}

/**
 * At boot, a record this host reported as `running` names a turn its previous
 * process never settled. Only the host's own records: a record another runner
 * reported is that runner's to settle.
 */
export async function markOwnRunningSessionRecordsInterrupted(organizationId: string): Promise<number> {
  const result = await getDatabase().run(sql`
    UPDATE ${sessionRecords} SET status = 'interrupted'
    WHERE organization_id = ${organizationId} AND status = 'running' AND runner_host_id IS NULL
  `)
  return result.changes
}

/** What a control-plane status means to the record: a turn open, or not. */
export function sessionRecordStatusOf(status: SessionStatus): SessionRecordStatus {
  switch (status) {
    case 'connecting':
    case 'running':
    case 'awaiting_input':
    case 'awaiting_plan':
    case 'rate_limited':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'idle':
    case 'completed':
    case 'background':
    case 'failed':
    case 'dead':
      return 'idle'
  }
}

export interface SessionRecordQuery {
  provider?: AgentId
  /** Exact provider project folder keys. */
  projectPaths?: string[]
  /** One plain project path; encoded here as the provider spells it. */
  projectPath?: string
  /** With `projectPath`: the project's worktree folders too, unless the path is itself a worktree. */
  includeWorktrees?: boolean
  limit?: number
}

/** Newest activity first, with the picker's filters. */
export async function listSessionRecords(organizationId: string, query: SessionRecordQuery = {}): Promise<SessionRecord[]> {
  const clauses: SQL[] = [sql`organization_id = ${organizationId}`]
  if (query.provider) clauses.push(sql`provider = ${query.provider}`)
  if (query.projectPaths) {
    if (query.projectPaths.length === 0) return []
    clauses.push(sql`project_path IN (${sql.join(query.projectPaths.map((path) => sql`${path}`), sql`, `)})`)
  }
  if (query.projectPath !== undefined) {
    const normalized = query.projectPath.replace(/\/$/, '')
    const encoded = encodePathAsFolder(normalized)
    const withWorktrees = query.includeWorktrees === true && !isSolusWorktreePath(normalized)
    clauses.push(withWorktrees
      ? sql`(project_path = ${encoded} OR project_path LIKE ${`${encoded}${SOLUS_WORKTREE_ENCODED_MARKER}%`})`
      : sql`project_path = ${encoded}`)
  }
  const limit = query.limit === undefined ? sql`` : sql`LIMIT ${query.limit}`
  const rows = recordRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_COLUMNS} FROM ${sessionRecords}
    WHERE ${sql.join(clauses, sql` AND `)}
    ORDER BY last_activity_at DESC, session_id
    ${limit}
  `))
  return rows.map(recordFromRow)
}
