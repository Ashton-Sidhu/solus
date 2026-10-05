import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  hubNotificationSchema,
  NOTIFICATION_COUNT_CAP,
  notificationFactsSchema,
  notificationListRequestSchema,
  notificationResourceSchema,
  notificationSetArchivedSchema,
  notificationSetReadSchema,
  notificationSummarySchema,
  OTHER_PERSON_KINDS,
  type HubNotification,
  type NotificationCount,
  type NotificationFacts,
  type NotificationFilter,
  type NotificationListRequest,
  type NotificationPage,
  type NotificationResource,
  type NotificationSetArchived,
  type NotificationSetRead,
  type NotificationStateResult,
  type NotificationSummary,
} from '@solus/contracts/notification-hub'
import { ulid } from '@solus/contracts/ulid'
import { userKey, type Attribution } from '@solus/contracts/user'
import { afterDatabaseCommit, getDatabase, type Db } from '../../db/database'
import { isAnyOrganization, type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { attributionJson, hostAttribution, parseStoredAttribution } from '../stored-attribution'
import { notifications } from './schema'

/**
 * The notifications hub's store and producer SDK (plans/015-notifications-hub.md §4).
 *
 * One table at each record home. A producer calls `recordNotification` inside
 * the transaction of the change that caused it, so the row commits or rolls
 * back with that change. Recipients are user keys at this home; the SDK drops
 * duplicates and a person's own action toward themselves. A read is answered to
 * one recipient, the person the caller's principal names, and never by a
 * client-supplied user id. Clients learn of a change by `notifications.changed`
 * and read the first page again; there is no change journal.
 */

// ─── Producer SDK ───

export interface NotificationInput {
  organizationId: string
  /** The producer's stable event id: one occurrence. A replay passes the same one; a new request a new one. */
  eventId: string
  /** User keys at this home. */
  recipients: readonly string[]
  facts: NotificationFacts
  resource: NotificationResource
  by: Attribution
  summary: NotificationSummary
  activityId?: string
  createdAt?: number
}

/** A committed change to one recipient's feed. */
export interface NotificationsChangedEvent {
  organizationId: string
  recipientKey: string
}

type ChangedListener = (change: NotificationsChangedEvent) => void
const listeners = new Set<ChangedListener>()

/** Subscribe to every committed change of a recipient's feed. */
export function onNotificationsChanged(listener: ChangedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Tell each recipient's clients their feed changed. Call it after the change has
 * committed: inside a `Db` transaction it waits for the commit; a legacy
 * `withTx` caller calls it once `withTx` has returned.
 */
export function announceNotifications(organizationId: string, recipientKeys: Iterable<string>): void {
  const changes = [...new Set(recipientKeys)].map((recipientKey) => ({ organizationId, recipientKey }))
  if (changes.length === 0) return
  void afterDatabaseCommit(async () => {
    for (const change of changes) for (const listener of listeners) listener(change)
  })
}

/** The person an attribution acted as or for, if any. */
function personKeyOf(by: Attribution): string | null {
  if (by.kind === 'user') return userKey(by.user.id)
  if ((by.kind === 'agent' || by.kind === 'automation') && by.for) return userKey(by.for.id)
  return null
}

/** The resource key rows about one resource share, so its deletion removes them. */
function resourceKeyOf(resource: NotificationResource): string {
  switch (resource.kind) {
    case 'work': return `work:${resource.workId}`
    case 'task': return `task:${resource.taskId}`
    case 'pr': return `pr:${prKey(resource.pr)}`
    case 'automation': return `automation:${resource.automationId}`
    case 'review_job': return `review_job:${resource.job}:${prKey(resource.pr)}`
  }
}

function prKey(pr: { host: string; owner: string; repo: string; number: number }): string {
  return `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()
}

/** One row to insert, validated once for the async and the synchronous path. */
interface NotificationRow {
  id: string
  organization_id: string
  recipient_key: string
  event_id: string
  activity_id: string | null
  kind: string
  resource_key: string
  facts: string
  resource: string
  by: string
  summary: string
  created_at: number
}

/** The rows one event writes: its recipients, without repeats, without the actor toward themselves. */
function rowsFor(input: NotificationInput): NotificationRow[] {
  const facts = notificationFactsSchema.parse(input.facts)
  const resource = notificationResourceSchema.parse(input.resource)
  const summary = notificationSummarySchema.parse(input.summary)
  const actor = personKeyOf(input.by)
  const createdAt = input.createdAt ?? Date.now()
  const rows: NotificationRow[] = []
  for (const recipientKey of new Set(input.recipients)) {
    if (!recipientKey) continue
    if (OTHER_PERSON_KINDS.has(facts.kind) && recipientKey === actor) continue
    rows.push({
      id: ulid(createdAt), organization_id: input.organizationId, recipient_key: recipientKey, event_id: input.eventId,
      activity_id: input.activityId ?? null, kind: facts.kind, resource_key: resourceKeyOf(resource),
      facts: JSON.stringify(facts), resource: JSON.stringify(resource), by: attributionJson(input.by),
      summary: JSON.stringify(summary), created_at: createdAt,
    })
  }
  return rows
}

/**
 * Record one event for its recipients, in the caller's transaction. Answers the
 * ids of the rows it created; a replay of the same event creates none.
 */
export async function recordNotification(tx: Db, input: NotificationInput): Promise<string[]> {
  const created: NotificationRow[] = []
  for (const row of rowsFor(input)) {
    const inserted = await tx.run(sql`
      INSERT INTO ${notifications} (id, organization_id, recipient_key, event_id, activity_id, kind, resource_key, facts, resource, by, summary, created_at)
      VALUES (
        ${row.id}, ${row.organization_id}, ${row.recipient_key}, ${row.event_id}, ${row.activity_id}, ${row.kind},
        ${row.resource_key}, ${row.facts}, ${row.resource}, ${row.by}, ${row.summary}, ${row.created_at}
      )
      ON CONFLICT (organization_id, recipient_key, event_id) DO NOTHING
    `)
    if (inserted.changes > 0) created.push(row)
  }
  announceNotifications(input.organizationId, created.map((row) => row.recipient_key))
  return created.map((row) => row.id)
}

/**
 * The same write for a store that still uses the synchronous `withTx`: the
 * automation store. It runs on the host's one SQLite connection inside the
 * caller's open transaction, so the row commits or rolls back with the run.
 * Valid only where the hub's table lives in that file (the SQLite engine). The
 * caller announces the answered recipients after `withTx` returns.
 */
export function recordNotificationSync(sqlite: DatabaseSync, input: NotificationInput): string[] {
  const statement = sqlite.prepare(`
    INSERT INTO notifications (id, organization_id, recipient_key, event_id, activity_id, kind, resource_key, facts, resource, by, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, recipient_key, event_id) DO NOTHING
  `)
  const recipients: string[] = []
  for (const row of rowsFor(input)) {
    const result = statement.run(row.id, row.organization_id, row.recipient_key, row.event_id, row.activity_id, row.kind,
      row.resource_key, row.facts, row.resource, row.by, row.summary, row.created_at)
    if (Number(result.changes) > 0) recipients.push(row.recipient_key)
  }
  return recipients
}

/** Remove every row about a resource: it was deleted, or moved to another home. */
export async function removeNotificationsFor(tx: Db, organizationId: string, resource: NotificationResource): Promise<void> {
  await removeWhere(tx, organizationId, sql`resource_key = ${resourceKeyOf(resource)}`)
}

async function removeWhere(tx: Db, organizationId: string, where: SQL): Promise<void> {
  const recipients = z.array(z.object({ recipient_key: z.string() })).parse(await tx.all(sql`
    DELETE FROM ${notifications} WHERE organization_id = ${organizationId} AND ${where} RETURNING recipient_key
  `))
  announceNotifications(organizationId, recipients.map((row) => row.recipient_key))
}

// ─── Reads ───

/**
 * The person and home a read is for. `recipientKey` comes from the admitted
 * principal; `mayOpen` is the source's current resource access check, applied
 * before page and count semantics.
 */
export interface NotificationReader {
  scope: RecordScope
  recipientKey: string
  mayOpen?: (notification: HubNotification) => Promise<boolean>
}

const rowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  event_id: z.string(),
  activity_id: z.string().nullable(),
  facts: z.string(),
  resource: z.string(),
  by: z.string(),
  summary: z.string(),
  created_at: z.coerce.number(),
  read_at: z.coerce.number().nullable(),
  archived_at: z.coerce.number().nullable(),
})
type Row = z.infer<typeof rowSchema>

const COLUMNS = sql.raw('id, organization_id, event_id, activity_id, facts, resource, by, summary, created_at, read_at, archived_at')

/** One row as a notification; null for a shape this host cannot read, so one row never hides the rest. */
function fromRow(row: Row): HubNotification | null {
  try {
    const candidate = {
      id: row.id,
      eventId: row.event_id,
      activityId: row.activity_id ?? undefined,
      organizationId: row.organization_id,
      facts: JSON.parse(row.facts),
      resource: JSON.parse(row.resource),
      by: parseStoredAttribution(row.by) ?? hostAttribution(),
      createdAt: row.created_at,
      summary: JSON.parse(row.summary),
      readAt: row.read_at,
      archivedAt: row.archived_at,
    }
    if (candidate.activityId === undefined) delete candidate.activityId
    const parsed = hubNotificationSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A parenthesized parameter list for `IN`. The caller never passes an empty list. */
function inList(values: readonly string[]): SQL {
  return sql`(${sql.join(values.map((value) => sql`${value}`), sql`, `)})`
}

function viewClause(filter: NotificationFilter): SQL {
  const view = filter.view === 'unread'
    ? sql`read_at IS NULL AND archived_at IS NULL`
    : filter.view === 'archived' ? sql`archived_at IS NOT NULL` : sql`archived_at IS NULL`
  return filter.kinds?.length ? sql`${view} AND kind IN ${inList(filter.kinds)}` : view
}

function scopeKey(scope: RecordScope): string {
  return isAnyOrganization(scope) ? '*' : `org:${scope}`
}

/** A short digest that ties a cursor to the recipient, home, and filter it was read for. */
function binding(reader: NotificationReader, filter: NotificationFilter): string {
  const parts = [reader.recipientKey, scopeKey(reader.scope), JSON.stringify([filter.view, [...(filter.kinds ?? [])].sort()])]
  return createHash('sha256').update(parts.join('\n')).digest('base64url').slice(0, 22)
}

export class NotificationCursorError extends Error {
  constructor() {
    super('This notification cursor belongs to another reader or filter.')
  }
}

const pageCursorSchema = z.object({ b: z.string(), at: z.number(), id: z.string() })

function encodeCursor(value: z.infer<typeof pageCursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(cursor: string): z.infer<typeof pageCursorSchema> {
  try {
    return pageCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new NotificationCursorError()
  }
}

async function visible(reader: NotificationReader, rows: readonly Row[]): Promise<HubNotification[]> {
  const parsed = rows.map(fromRow).filter((item): item is HubNotification => item !== null)
  if (!reader.mayOpen) return parsed
  const allowed = await Promise.all(parsed.map((item) => reader.mayOpen!(item)))
  return parsed.filter((_, index) => allowed[index])
}

/**
 * One page of the recipient's notifications, newest first. Rows the reader may
 * not open are dropped before the page is cut, so a short page is the end.
 */
export async function listNotifications(reader: NotificationReader, input: NotificationListRequest, db: Db = getDatabase()): Promise<NotificationPage> {
  const request = notificationListRequestSchema.parse(input)
  const bound = binding(reader, request.filter)
  const after = request.cursor ? decodeCursor(request.cursor) : null
  if (after && after.b !== bound) throw new NotificationCursorError()
  const items: HubNotification[] = []
  let from = after
  let exhausted = false
  const batch = request.limit + 1
  while (items.length <= request.limit && !exhausted) {
    const rows = z.array(rowSchema).parse(await db.all(sql`
      SELECT ${COLUMNS} FROM ${notifications}
      WHERE recipient_key = ${reader.recipientKey} AND ${scopeClause(reader.scope)} AND ${viewClause(request.filter)}
        ${from ? sql`AND (created_at < ${from.at} OR (created_at = ${from.at} AND id < ${from.id}))` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${batch}
    `))
    exhausted = rows.length < batch
    const last = rows.at(-1)
    if (last) from = { b: bound, at: last.created_at, id: last.id }
    items.push(...await visible(reader, rows))
  }
  const page = items.slice(0, request.limit)
  const tail = page.at(-1)
  return {
    items: page,
    cursor: items.length > request.limit && tail ? encodeCursor({ b: bound, at: tail.createdAt, id: tail.id }) : null,
  }
}

/** Unread, unarchived rows the reader may open. The count stops at the cap instead of checking every row. */
export async function countNotifications(reader: NotificationReader, db: Db = getDatabase()): Promise<NotificationCount> {
  const rows = z.array(rowSchema).parse(await db.all(sql`
    SELECT ${COLUMNS} FROM ${notifications}
    WHERE recipient_key = ${reader.recipientKey} AND ${scopeClause(reader.scope)} AND read_at IS NULL AND archived_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ${NOTIFICATION_COUNT_CAP + 1}
  `))
  const counted = await visible(reader, rows)
  return { unread: Math.min(counted.length, NOTIFICATION_COUNT_CAP), isCapped: rows.length > NOTIFICATION_COUNT_CAP }
}

/** One of the recipient's rows by id, if they may open it. */
export async function getNotification(reader: NotificationReader, id: string, db: Db = getDatabase()): Promise<HubNotification | null> {
  const row = rowSchema.optional().parse(await db.get(sql`
    SELECT ${COLUMNS} FROM ${notifications} WHERE id = ${id} AND recipient_key = ${reader.recipientKey} AND ${scopeClause(reader.scope)}
  `))
  if (!row) return null
  return (await visible(reader, [row]))[0] ?? null
}

// ─── State writes ───

/**
 * Set the read fact, never toggle it. Accepted writes apply in server order; a
 * read write never touches the archive fact. Setting it to what it already is
 * keeps its time.
 */
export function setNotificationRead(reader: NotificationReader, input: NotificationSetRead, db: Db = getDatabase()): Promise<NotificationStateResult> {
  const request = notificationSetReadSchema.parse(input)
  return setState(reader, request.id, request.read ? sql`read_at = COALESCE(read_at, ${Date.now()})` : sql`read_at = NULL`, db)
}

export function setNotificationArchived(reader: NotificationReader, input: NotificationSetArchived, db: Db = getDatabase()): Promise<NotificationStateResult> {
  const request = notificationSetArchivedSchema.parse(input)
  return setState(reader, request.id, request.archived ? sql`archived_at = COALESCE(archived_at, ${Date.now()})` : sql`archived_at = NULL`, db)
}

async function setState(reader: NotificationReader, id: string, assignment: SQL, db: Db): Promise<NotificationStateResult> {
  return db.transaction(async (tx) => {
    // Access is checked before the write: a row the reader can no longer open is not theirs to change.
    const current = await getNotification(reader, id, tx)
    if (!current) return { ok: false, reason: 'not_found' }
    await tx.run(sql`UPDATE ${notifications} SET ${assignment} WHERE id = ${id} AND recipient_key = ${reader.recipientKey}`)
    const updated = await getNotification(reader, id, tx)
    if (!updated) return { ok: false, reason: 'not_found' }
    announceNotifications(updated.organizationId, [reader.recipientKey])
    return { ok: true, notification: updated }
  })
}
