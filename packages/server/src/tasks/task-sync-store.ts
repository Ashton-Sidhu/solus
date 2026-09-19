import { sql } from 'drizzle-orm'
import type {
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskExternalLink,
  TaskSyncState,
} from '@solus/contracts/task-types'
import { getDatabase, type Db } from '../db/database'
import { taskComments, taskExternalLinks } from './schema'
import { z } from 'zod'

const syncFieldSchema = z.enum(['title', 'body', 'status', 'labels', 'priority', 'assignee'])

const externalLinkRowSchema = z.object({
  task_id: z.string(),
  provider: z.enum(['github', 'jira']),
  external_key: z.string(),
  external_id: z.string(),
  url: z.string(),
  external_updated_at: z.string().nullable(),
  snapshot: z.string().nullable(),
  dirty_fields: z.string(),
  sync_state: z.enum(['ok', 'dirty', 'error', 'auth_error']),
  sync_error: z.string().nullable(),
  last_synced_at: z.number().nullable(),
  retry_at: z.number().nullable(),
  failure_count: z.number(),
  organization_id: z.string(),
})

const dirtyCommentRowSchema = z.object({ id: z.string(), body: z.string() })
const externalIdRowSchema = z.object({ external_id: z.string() })
const adoptableCommentRowSchema = z.object({ id: z.string(), external_id: z.string() })

type ExternalLinkRow = z.infer<typeof externalLinkRowSchema>

interface DirtyCommentRow {
  id: string
  body: string
}

type SyncField = TaskExternalLink['dirtyFields'][number]
type DirtyListener = (organizationId: string, taskId: string) => void
const dirtyListeners = new Set<DirtyListener>()

/** A link with the organization it belongs to: what the background poll, which
 * walks every organization's links, hands to the per-task sync. */
export interface ExternalLinkRecord {
  organizationId: string
  link: TaskExternalLink
}

export function onTaskSyncDirty(listener: DirtyListener): () => void {
  dirtyListeners.add(listener)
  return () => dirtyListeners.delete(listener)
}

export function notifyTaskSyncDirty(organizationId: string, taskId: string): void {
  for (const listener of dirtyListeners) listener(organizationId, taskId)
}

function parseSnapshot(value: string | null): TaskExternalLink['snapshot'] {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function parseDirtyFields(value: string): SyncField[] {
  try {
    const parsed = z.array(syncFieldSchema).safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function linkFromRow(row: ExternalLinkRow): TaskExternalLink {
  return {
    taskId: row.task_id,
    provider: row.provider,
    externalKey: row.external_key,
    externalId: row.external_id,
    url: row.url,
    externalUpdatedAt: row.external_updated_at,
    snapshot: parseSnapshot(row.snapshot),
    dirtyFields: parseDirtyFields(row.dirty_fields),
    syncState: row.sync_state,
    syncError: row.sync_error,
    lastSyncedAt: row.last_synced_at,
    retryAt: row.retry_at,
    failureCount: row.failure_count,
  }
}

export async function externalLinkForTask(
  taskId: string,
  db: Db = getDatabase(),
): Promise<TaskExternalLink | null> {
  const row = externalLinkRowSchema.safeParse(await db.get(sql`SELECT * FROM ${taskExternalLinks} WHERE task_id = ${taskId}`))
  return row.success ? linkFromRow(row.data) : null
}

export async function externalLinkForTicket(
  organizationId: string,
  ref: Pick<ExternalTicketRef, 'provider' | 'externalKey' | 'externalId'>,
  db: Db = getDatabase(),
): Promise<TaskExternalLink | null> {
  const row = externalLinkRowSchema.safeParse(await db.get(sql`
    SELECT * FROM ${taskExternalLinks}
    WHERE organization_id = ${organizationId}
      AND provider = ${ref.provider} AND external_key = ${ref.externalKey} AND external_id = ${ref.externalId}
  `))
  return row.success ? linkFromRow(row.data) : null
}

export async function listExternalLinks(
  organizationId: string,
  taskId?: string,
  db: Db = getDatabase(),
): Promise<TaskExternalLink[]> {
  const rows = taskId
    ? await db.all(sql`SELECT * FROM ${taskExternalLinks} WHERE organization_id = ${organizationId} AND task_id = ${taskId}`)
    : await db.all(sql`SELECT * FROM ${taskExternalLinks} WHERE organization_id = ${organizationId} ORDER BY task_id`)
  return rows.flatMap((row) => {
    const parsed = externalLinkRowSchema.safeParse(row)
    return parsed.success ? [linkFromRow(parsed.data)] : []
  })
}

/** Every link in the database with its organization: the poll's list. */
export async function listExternalLinksForPoll(db: Db = getDatabase()): Promise<ExternalLinkRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${taskExternalLinks} ORDER BY organization_id, task_id`)
  return rows.flatMap((row) => {
    const parsed = externalLinkRowSchema.safeParse(row)
    return parsed.success ? [{ organizationId: parsed.data.organization_id, link: linkFromRow(parsed.data) }] : []
  })
}

/** Which tickets in one repository a native task already mirrors. The upstream
 *  list reads this to leave those tickets out: a published or imported issue is
 *  the same work as the task that owns it, not a second item beside it. */
export async function linkedExternalIds(
  organizationId: string,
  provider: string,
  externalKey: string,
  db: Db = getDatabase(),
): Promise<Set<string>> {
  const rows = await db.all(sql`
    SELECT external_id FROM ${taskExternalLinks}
    WHERE organization_id = ${organizationId} AND provider = ${provider} AND external_key = ${externalKey}
  `)
  return new Set(rows.flatMap((row) => {
    const parsed = externalIdRowSchema.safeParse(row)
    return parsed.success ? [parsed.data.external_id] : []
  }))
}

export async function writeExternalLink(
  db: Db,
  organizationId: string,
  taskId: string,
  ticket: NormalizedTicket,
  now = Date.now(),
): Promise<TaskExternalLink> {
  await db.run(sql`
    INSERT INTO ${taskExternalLinks}(
      task_id, provider, external_key, external_id, url,
      external_updated_at, snapshot, dirty_fields, sync_state, sync_error,
      last_synced_at, retry_at, failure_count, organization_id
    ) VALUES (
      ${taskId}, ${ticket.provider}, ${ticket.externalKey}, ${ticket.externalId}, ${ticket.url},
      ${ticket.externalUpdatedAt}, ${ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot)},
      '[]', 'ok', NULL, ${now}, NULL, 0, ${organizationId}
    )
    ON CONFLICT(task_id) DO UPDATE SET
      provider = excluded.provider,
      external_key = excluded.external_key,
      external_id = excluded.external_id,
      url = excluded.url,
      external_updated_at = excluded.external_updated_at,
      snapshot = excluded.snapshot,
      dirty_fields = '[]',
      sync_state = 'ok',
      sync_error = NULL,
      last_synced_at = excluded.last_synced_at,
      retry_at = NULL,
      failure_count = 0
  `)
  await insertExternalComments(db, organizationId, taskId, ticket.comments)
  const link = await externalLinkForTask(taskId, db)
  if (!link) throw new Error(`Failed to persist external link for task ${taskId}`)
  return link
}

export async function markTaskFieldsDirty(
  db: Db,
  taskId: string,
  fields: Iterable<string>,
): Promise<boolean> {
  const link = await externalLinkForTask(taskId, db)
  if (!link) return false
  const next = new Set(link.dirtyFields)
  for (const field of fields) {
    const parsed = syncFieldSchema.safeParse(field)
    if (parsed.success) next.add(parsed.data)
  }
  if (next.size === link.dirtyFields.length) return false
  await db.run(sql`
    UPDATE ${taskExternalLinks}
    SET dirty_fields = ${JSON.stringify([...next])}, sync_state = 'dirty', sync_error = NULL, retry_at = NULL
    WHERE task_id = ${taskId}
  `)
  return true
}

export async function updateExternalLinkAfterSync(
  db: Db,
  taskId: string,
  ticket: NormalizedTicket,
  now = Date.now(),
): Promise<void> {
  await db.run(sql`
    UPDATE ${taskExternalLinks} SET
      url = ${ticket.url}, external_updated_at = ${ticket.externalUpdatedAt},
      snapshot = ${ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot)}, dirty_fields = '[]',
      sync_state = 'ok', sync_error = NULL, last_synced_at = ${now}, retry_at = NULL,
      failure_count = 0
    WHERE task_id = ${taskId}
  `)
}

/** Record provider truth after a push without erasing edits that arrived while
 * the request was in flight. Only fields whose pushed value still matches the
 * local row are acknowledged. */
export async function acknowledgeExternalPush(
  db: Db,
  taskId: string,
  ticket: NormalizedTicket,
  acknowledgedFields: SyncField[],
  now = Date.now(),
): Promise<void> {
  const link = await externalLinkForTask(taskId, db)
  if (!link) return
  const acknowledged = new Set(acknowledgedFields)
  const remaining = link.dirtyFields.filter((field) => !acknowledged.has(field))
  const pendingComment = await db.get(sql`
    SELECT 1 AS present FROM ${taskComments} WHERE task_id = ${taskId} AND dirty = 1 LIMIT 1
  `)
  const isDirty = remaining.length > 0 || Boolean(pendingComment)
  await db.run(sql`
    UPDATE ${taskExternalLinks} SET
      url = ${ticket.url}, external_updated_at = ${ticket.externalUpdatedAt},
      snapshot = ${ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot)},
      dirty_fields = ${JSON.stringify(remaining)},
      sync_state = ${isDirty ? 'dirty' : 'ok'}, sync_error = NULL, last_synced_at = ${now}, retry_at = NULL,
      failure_count = 0
    WHERE task_id = ${taskId}
  `)
}

export async function markExternalLinkError(
  db: Db,
  taskId: string,
  state: Extract<TaskSyncState, 'error' | 'auth_error'>,
  message: string,
  now = Date.now(),
): Promise<void> {
  const link = await externalLinkForTask(taskId, db)
  if (!link) return
  const failures = link.failureCount + 1
  const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(failures - 1, 6)))
  await db.run(sql`
    UPDATE ${taskExternalLinks} SET
      sync_state = ${state}, sync_error = ${message},
      retry_at = ${state === 'auth_error' ? null : now + delay}, failure_count = ${failures}
    WHERE task_id = ${taskId}
  `)
}

export async function dirtyCommentsForTask(
  taskId: string,
  db: Db = getDatabase(),
): Promise<DirtyCommentRow[]> {
  const rows = await db.all(sql`
    SELECT id, body FROM ${taskComments}
    WHERE task_id = ${taskId} AND dirty = 1
    ORDER BY created_at, id
  `)
  return rows.flatMap((row) => {
    const parsed = dirtyCommentRowSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * Queue comments that were held back at the time they were written.
 *
 * Only local comments that have never been posted are eligible: one already
 * carrying an external id is upstream's copy, and re-queueing it would post a
 * duplicate. Returns how many were newly queued, so a no-op does not announce
 * itself as a push.
 */
export async function markCommentsDirty(
  db: Db,
  taskId: string,
  commentIds: string[],
): Promise<number> {
  if (!commentIds.length) return 0
  const result = await db.run(sql`
    UPDATE ${taskComments} SET dirty = 1
    WHERE task_id = ${taskId}
      AND source = 'local'
      AND external_id IS NULL
      AND dirty = 0
      AND id IN (${sql.join(commentIds.map((id) => sql`${id}`), sql`, `)})
  `)
  return result.changes
}

export async function markCommentSynced(
  db: Db,
  commentId: string,
  externalId: string,
): Promise<void> {
  await db.run(sql`
    UPDATE ${taskComments} SET external_id = ${externalId}, dirty = 0 WHERE id = ${commentId}
  `)
}

export async function insertExternalComments(
  db: Db,
  organizationId: string,
  taskId: string,
  comments: NormalizedTaskComment[],
): Promise<number> {
  let changedCommentCount = 0
  for (const comment of comments) {
    // Comments posted before the adapter stamped node ids carry GitHub's REST
    // database id, which the GraphQL read never matches — so the pull used to
    // insert a second copy of our own comment. Adopt the node id onto that row
    // instead; the unique index then makes the insert below a no-op. Whether an
    // id is all digits is decided here: neither engine's pattern match is portable.
    const candidates = adoptableCommentRowSchema.array().parse(await db.all(sql`
      SELECT id, external_id FROM ${taskComments}
      WHERE task_id = ${taskId}
        AND source = 'local'
        AND external_id IS NOT NULL
        AND body = ${comment.body}
      ORDER BY created_at, id
    `))
    const adoptable = candidates.find((candidate) => /^[0-9]+$/.test(candidate.external_id))
    const adopted = adoptable
      ? await db.run(sql`UPDATE ${taskComments} SET external_id = ${comment.externalId} WHERE id = ${adoptable.id}`)
      : { changes: 0 }
    const inserted = await db.run(sql`
      INSERT INTO ${taskComments}(
        id, task_id, author, source, external_id, origin_session_id, body,
        created_at, dirty, organization_id
      ) VALUES (
        ${`external:${comment.externalId}`}, ${taskId}, ${comment.author ?? null}, 'external',
        ${comment.externalId}, NULL, ${comment.body}, ${comment.createdAt}, 0, ${organizationId}
      )
      ON CONFLICT DO NOTHING
    `)
    changedCommentCount += adopted.changes + inserted.changes
  }
  return changedCommentCount
}

export async function hasPendingSync(taskId: string, db: Db = getDatabase()): Promise<boolean> {
  const link = await externalLinkForTask(taskId, db)
  if (!link) return false
  return link.dirtyFields.length > 0 || (await dirtyCommentsForTask(taskId, db)).length > 0
}
