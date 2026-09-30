import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { activityKindSchema, type Activity, type ActivityKind, type ActivitySubject } from '@solus/contracts/activity'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { ulid } from '@solus/contracts/ulid'
import { userKey, type Attribution, type UserId } from '@solus/contracts/user'
import { getDatabase, type Db } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { attributionJson, hostAttribution, parseStoredAttribution } from '../stored-attribution'
import { activity as activityTable } from './schema'

/**
 * The activity record (plans/012-user-actor-and-activity.md §5): one row per
 * thing that happened to a session, a task or a work that people read. Plain
 * functions, like `session-records.ts`. Tasks write inside the transaction of
 * the change that caused the row; sessions write through
 * `SessionRuntime.recordActivity`, which also sends the row live.
 */

/** A new activity, stamped now. */
export function newActivity(subject: ActivitySubject, by: Attribution, kind: ActivityKind, at = Date.now()): Activity {
  return { ...kind, id: ulid(at), subject, at, by }
}

/** Append one activity. Pass the caller's transaction when the row must commit with the change that caused it. */
export async function appendActivity(organizationId: string, activity: Activity, db: Db = getDatabase()): Promise<void> {
  await insertActivity(organizationId, activity, db, sql``)
}

/**
 * Store one activity a runner mirrored (plans/012 §5, stage 8), in the runner's
 * organization. The id makes a redelivery write nothing new. A session's rows are
 * named by the id its transcript is mirrored under, which a provider handoff
 * changes; the row then follows the newest copy, within its organization only.
 */
export async function storeMirroredActivity(organizationId: string, activity: Activity, db: Db = getDatabase()): Promise<void> {
  await insertActivity(organizationId, activity, db, sql`
    ON CONFLICT (id) DO UPDATE SET subject_id = excluded.subject_id
    WHERE ${activityTable}.organization_id = excluded.organization_id AND ${activityTable}.subject_kind = excluded.subject_kind
  `)
}

async function insertActivity(organizationId: string, activity: Activity, db: Db, onConflict: SQL): Promise<void> {
  const { id, subject, at, by, turnId, ...kind } = activity
  const target = targetUserOf(kind)
  await db.run(sql`
    INSERT INTO ${activityTable} (id, organization_id, subject_kind, subject_id, at, turn_id, kind, by_kind, by_user_key, target_user_key, by, data)
    VALUES (
      ${id}, ${organizationId}, ${subject.kind}, ${subject.id}, ${at}, ${turnId ?? null}, ${kind.kind},
      ${by.kind}, ${by.kind === 'user' ? userKey(by.user.id) : null}, ${target ? userKey(target) : null},
      ${attributionJson(by)}, ${JSON.stringify(kind)}
    )
    ${onConflict}
  `)
}

/** The person an activity is aimed at, not by: who was mentioned, or shared with. */
function targetUserOf(kind: ActivityKind): UserId | null {
  if (kind.kind === 'mentioned') return kind.userId
  if (kind.kind === 'shared') return kind.userId ?? null
  return null
}

/** Who an activity read is about: what they did (`userId`), or what was aimed at them (`targetUserId`: a mention of them, a share with them). */
export type ActivityUserQuery = { userId: UserId; since: number } | { targetUserId: UserId; since: number }

/** A subject's activity, oldest first. With `limit`, the newest `limit` rows. */
export function activityFor(scope: RecordScope, subject: ActivitySubject, options?: { limit?: number; db?: Db }): Promise<Activity[]>
/** What one user did, or what was aimed at them, since `since`, oldest first (the notifications hub, D15). */
export function activityFor(scope: RecordScope, query: ActivityUserQuery, options?: { limit?: number; db?: Db }): Promise<Activity[]>
export async function activityFor(
  scope: RecordScope,
  target: ActivitySubject | ActivityUserQuery,
  options: { limit?: number; db?: Db } = {},
): Promise<Activity[]> {
  const where = 'userId' in target
    ? sql`by_user_key = ${userKey(target.userId)} AND at >= ${target.since}`
    : 'targetUserId' in target
      ? sql`target_user_key = ${userKey(target.targetUserId)} AND at >= ${target.since}`
      : sql`subject_kind = ${target.kind} AND subject_id = ${target.id}`
  const limit = options.limit ? sql`LIMIT ${options.limit}` : sql``
  const rows = z.array(activityRowSchema).parse(await (options.db ?? getDatabase()).all(sql`
    SELECT id, subject_kind, subject_id, at, turn_id, by, data FROM ${activityTable}
    WHERE ${where} AND ${scopeClause(scope)}
    ORDER BY at DESC, id DESC
    ${limit}
  `))
  const activity: Activity[] = []
  for (let index = rows.length - 1; index >= 0; index--) {
    const read = activityFromRow(rows[index])
    if (read) activity.push(read)
  }
  return activity
}

/** Remove a subject's activity, with the subject. */
export async function deleteActivityFor(subject: ActivitySubject, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`DELETE FROM ${activityTable} WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}`)
}

const activityRowSchema = z.object({
  id: z.string(),
  subject_kind: z.enum(['session', 'task', 'work']),
  subject_id: z.string(),
  at: z.coerce.number(),
  turn_id: z.string().nullable(),
  by: z.string(),
  data: z.string(),
})

/**
 * One row as an activity; null for a kind this host cannot read (a newer host
 * wrote it), so one row never hides the rest. A `by` that is not an attribution
 * is a task event copied from before plan 012 stage 4 that named someone in the
 * app by label: the host's user, as `legacyTaskActor` reads it.
 */
function activityFromRow(row: z.infer<typeof activityRowSchema>): Activity | null {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch {
    return null
  }
  const kind = activityKindSchema.safeParse(data)
  if (!kind.success) return null
  const read: Activity = {
    ...kind.data,
    id: row.id,
    subject: { kind: row.subject_kind, id: row.subject_id },
    at: row.at,
    by: parseStoredAttribution(row.by) ?? hostAttribution(),
  }
  if (row.turn_id) read.turnId = row.turn_id
  return read
}

/** The id prefix of an `agent_switched` row the lineage read rebuilds (`lineageSwitchDivider`). */
export const LINEAGE_SWITCH_ID_PREFIX = 'handoff:'

/**
 * A session's history with its activity in place (§5): each activity goes
 * before the first message that happened after it, so a stop or an answer made
 * inside a turn stays inside that turn. Both lists are in time order, so this is
 * one pass. A switch the lineage rebuilt gives way to the recorded one for the
 * same handoff (recorded at the lineage member's start), which names who
 * switched; the recorded one takes the models the lineage knows.
 */
export function mergeSessionActivity(messages: WireSessionLoadMessage[], activity: Activity[]): WireSessionLoadMessage[] {
  if (!activity.length) return messages
  const recordedSwitches = new Map<string, Extract<Activity, { kind: 'agent_switched' }>>()
  for (const entry of activity) {
    if (entry.kind === 'agent_switched') recordedSwitches.set(`${entry.at}:${entry.provider}`, entry)
  }
  const merged: WireSessionLoadMessage[] = []
  let next = 0
  for (const message of messages) {
    while (next < activity.length && activity[next].at < message.timestamp) merged.push(activityMessage(activity[next++]))
    const rebuilt = message.activity?.kind === 'agent_switched' && message.activity.id.startsWith(LINEAGE_SWITCH_ID_PREFIX) ? message.activity : null
    const recorded = rebuilt ? recordedSwitches.get(`${rebuilt.at}:${rebuilt.provider}`) : undefined
    if (rebuilt && recorded) {
      recorded.model ??= rebuilt.model
      recorded.fromModel ??= rebuilt.fromModel
      continue
    }
    merged.push(message)
  }
  while (next < activity.length) merged.push(activityMessage(activity[next++]))
  return merged
}

/**
 * A history window with its activity (§5): a window cut to its newest rows
 * holds the activity from its first message on; a whole history holds all of it.
 */
export function mergeWindowActivity(history: WireSessionLoadMessage[], activity: Activity[], isCut: boolean): WireSessionLoadMessage[] {
  const from = isCut && history.length ? history[0].timestamp : -Infinity
  return mergeSessionActivity(history, activity.filter((entry) => entry.at >= from))
}

/** The client's opaque history cursor: the history's own, and where the newer page's activity began. */
const activityPageCursorSchema = z.object({ before: z.string(), at: z.number() })

/** A history page cursor as a client sent it back: the history's own cursor, and where the newer page's activity began. */
export interface ActivityPageCursor {
  before?: string
  at: number
}

/** Reads a cursor `mergePageActivity` wrote. */
export function readActivityPageCursor(before: string | undefined): ActivityPageCursor {
  if (before === undefined) return { at: Infinity }
  return activityPageCursorSchema.parse(JSON.parse(before))
}

/**
 * A history page with its activity (§5). A page holds the activity from its first
 * message (from the start when it is the oldest) up to where the newer page began
 * (`newerPageAt`), so each activity lands in exactly one page; the cursor it
 * answers carries where this page began.
 */
export function mergePageActivity(page: SessionHistoryPage, activity: Activity[], newerPageAt: number): SessionHistoryPage {
  const from = page.before !== null && page.messages.length ? page.messages[0].timestamp : -Infinity
  return {
    messages: mergeSessionActivity(page.messages, activity.filter((entry) => entry.at >= from && entry.at < newerPageAt)),
    before: page.before === null ? null : JSON.stringify({ before: page.before, at: Number.isFinite(from) ? from : 0 }),
  }
}

function activityMessage(activity: Activity): WireSessionLoadMessage {
  return { messageId: `activity:${activity.id}`, role: 'system', content: '', activity, timestamp: activity.at }
}
