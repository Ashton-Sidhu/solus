import type { DatabaseSync } from 'node:sqlite'
import type {
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskExternalLink,
  TaskSyncState,
} from '../../shared/task-types'
import { getDb } from '../db'

const SYNC_FIELDS = new Set(['title', 'body', 'status', 'labels'])

interface ExternalLinkRow {
  task_id: string
  provider: TaskExternalLink['provider']
  external_key: string
  external_id: string
  url: string
  external_updated_at: string | null
  snapshot: string | null
  dirty_fields: string
  sync_state: TaskSyncState
  sync_error: string | null
  last_synced_at: number | null
  retry_at: number | null
  failure_count: number
}

interface DirtyCommentRow {
  id: string
  body: string
}

type SyncField = TaskExternalLink['dirtyFields'][number]
type DirtyListener = (taskId: string) => void
const dirtyListeners = new Set<DirtyListener>()

export function onTaskSyncDirty(listener: DirtyListener): () => void {
  dirtyListeners.add(listener)
  return () => dirtyListeners.delete(listener)
}

export function notifyTaskSyncDirty(taskId: string): void {
  for (const listener of dirtyListeners) listener(taskId)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
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
    snapshot: parseJson(row.snapshot, undefined),
    dirtyFields: parseJson<SyncField[]>(row.dirty_fields, [])
      .filter((field): field is SyncField => SYNC_FIELDS.has(field)),
    syncState: row.sync_state,
    syncError: row.sync_error,
    lastSyncedAt: row.last_synced_at,
    retryAt: row.retry_at,
    failureCount: row.failure_count,
  }
}

export function externalLinkForTask(
  taskId: string,
  db: DatabaseSync = getDb(),
): TaskExternalLink | null {
  const row = db.prepare('SELECT * FROM task_external_links WHERE task_id = ?')
    .get(taskId) as unknown as ExternalLinkRow | undefined
  return row ? linkFromRow(row) : null
}

export function externalLinkForTicket(
  ref: Pick<ExternalTicketRef, 'provider' | 'externalKey' | 'externalId'>,
  db: DatabaseSync = getDb(),
): TaskExternalLink | null {
  const row = db.prepare(`
    SELECT * FROM task_external_links
    WHERE provider = ? AND external_key = ? AND external_id = ?
  `).get(ref.provider, ref.externalKey, ref.externalId) as unknown as ExternalLinkRow | undefined
  return row ? linkFromRow(row) : null
}

export function listExternalLinks(
  taskId?: string,
  db: DatabaseSync = getDb(),
): TaskExternalLink[] {
  const rows = taskId
    ? db.prepare('SELECT * FROM task_external_links WHERE task_id = ?').all(taskId)
    : db.prepare('SELECT * FROM task_external_links ORDER BY task_id').all()
  return (rows as unknown as ExternalLinkRow[]).map(linkFromRow)
}

export function writeExternalLink(
  db: DatabaseSync,
  taskId: string,
  ticket: NormalizedTicket,
  now = Date.now(),
): TaskExternalLink {
  db.prepare(`
    INSERT INTO task_external_links(
      task_id, provider, external_key, external_id, url,
      external_updated_at, snapshot, dirty_fields, sync_state, sync_error,
      last_synced_at, retry_at, failure_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'ok', NULL, ?, NULL, 0)
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
  `).run(
    taskId,
    ticket.provider,
    ticket.externalKey,
    ticket.externalId,
    ticket.url,
    ticket.externalUpdatedAt,
    ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot),
    now,
  )
  insertExternalComments(db, taskId, ticket.comments)
  return externalLinkForTask(taskId, db)!
}

export function markTaskFieldsDirty(
  db: DatabaseSync,
  taskId: string,
  fields: Iterable<string>,
): boolean {
  const link = externalLinkForTask(taskId, db)
  if (!link) return false
  const next = new Set(link.dirtyFields)
  for (const field of fields) {
    if (SYNC_FIELDS.has(field)) next.add(field as SyncField)
  }
  if (next.size === link.dirtyFields.length) return false
  db.prepare(`
    UPDATE task_external_links
    SET dirty_fields = ?, sync_state = 'dirty', sync_error = NULL, retry_at = NULL
    WHERE task_id = ?
  `).run(JSON.stringify([...next]), taskId)
  return true
}

export function updateExternalLinkAfterSync(
  db: DatabaseSync,
  taskId: string,
  ticket: NormalizedTicket,
  now = Date.now(),
): void {
  db.prepare(`
    UPDATE task_external_links SET
      url = ?, external_updated_at = ?, snapshot = ?, dirty_fields = '[]',
      sync_state = 'ok', sync_error = NULL, last_synced_at = ?, retry_at = NULL,
      failure_count = 0
    WHERE task_id = ?
  `).run(
    ticket.url,
    ticket.externalUpdatedAt,
    ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot),
    now,
    taskId,
  )
}

/** Record provider truth after a push without erasing edits that arrived while
 * the request was in flight. Only fields whose pushed value still matches the
 * local row are acknowledged. */
export function acknowledgeExternalPush(
  db: DatabaseSync,
  taskId: string,
  ticket: NormalizedTicket,
  acknowledgedFields: SyncField[],
  now = Date.now(),
): void {
  const link = externalLinkForTask(taskId, db)
  if (!link) return
  const acknowledged = new Set(acknowledgedFields)
  const remaining = link.dirtyFields.filter((field) => !acknowledged.has(field))
  const pendingComment = db.prepare(`
    SELECT 1 FROM task_comments WHERE task_id = ? AND dirty = 1 LIMIT 1
  `).get(taskId)
  const isDirty = remaining.length > 0 || Boolean(pendingComment)
  db.prepare(`
    UPDATE task_external_links SET
      url = ?, external_updated_at = ?, snapshot = ?, dirty_fields = ?,
      sync_state = ?, sync_error = NULL, last_synced_at = ?, retry_at = NULL,
      failure_count = 0
    WHERE task_id = ?
  `).run(
    ticket.url,
    ticket.externalUpdatedAt,
    ticket.snapshot === undefined ? null : JSON.stringify(ticket.snapshot),
    JSON.stringify(remaining),
    isDirty ? 'dirty' : 'ok',
    now,
    taskId,
  )
}

export function markExternalLinkError(
  db: DatabaseSync,
  taskId: string,
  state: Extract<TaskSyncState, 'error' | 'auth_error'>,
  message: string,
  now = Date.now(),
): void {
  const link = externalLinkForTask(taskId, db)
  if (!link) return
  const failures = link.failureCount + 1
  const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(failures - 1, 6)))
  db.prepare(`
    UPDATE task_external_links SET
      sync_state = ?, sync_error = ?, retry_at = ?, failure_count = ?
    WHERE task_id = ?
  `).run(state, message, state === 'auth_error' ? null : now + delay, failures, taskId)
}

export function dirtyCommentsForTask(
  taskId: string,
  db: DatabaseSync = getDb(),
): DirtyCommentRow[] {
  return db.prepare(`
    SELECT id, body FROM task_comments
    WHERE task_id = ? AND dirty = 1
    ORDER BY created_at, id
  `).all(taskId) as unknown as DirtyCommentRow[]
}

export function markCommentSynced(
  db: DatabaseSync,
  commentId: string,
  externalId: string,
): void {
  db.prepare(`
    UPDATE task_comments SET external_id = ?, dirty = 0 WHERE id = ?
  `).run(externalId, commentId)
}

export function insertExternalComments(
  db: DatabaseSync,
  taskId: string,
  comments: NormalizedTaskComment[],
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO task_comments(
      id, task_id, author, source, external_id, origin_session_id, body,
      created_at, dirty
    ) VALUES (?, ?, ?, 'external', ?, NULL, ?, ?, 0)
  `)
  for (const comment of comments) {
    insert.run(
      `external:${comment.externalId}`,
      taskId,
      comment.author ?? null,
      comment.externalId,
      comment.body,
      comment.createdAt,
    )
  }
}

export function hasPendingSync(taskId: string, db: DatabaseSync = getDb()): boolean {
  const link = externalLinkForTask(taskId, db)
  if (!link) return false
  return link.dirtyFields.length > 0 || dirtyCommentsForTask(taskId, db).length > 0
}
