import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { HostOwnerIdentity } from '@solus/contracts/uplink'
import { userKey } from '@solus/contracts/user'
import type { PlanComment } from '@solus/contracts/types'
import { moveCommentUser, readStoredComments, type StoredThread } from '../annotations/stored-comments'
import type { Db } from '../db/database'
import { createLogger } from '../logger'
import { LOCAL_ORGANIZATION_ID } from './host-category'
import { currentHostUser, hostUser, hostUserKey, useHostUser } from './host-user'
import { setHostUserSettings, type HostUserSettings } from './settings'

const log = createLogger('main', 'host-user')

/** The key rows written before plan 012 stage 1 held for the host's owner; read only by the one-time move. */
const LEGACY_HOST_OWNER_KEY = 'host-owner'

/**
 * Where the host's user is stored, and moving it (plans/012-user-actor-and-activity.md
 * §1, U5): the boot migration from the host-owner sentinel, the link that moves the
 * `local` user's rows to the owner's account, and the unlink that moves them back.
 * The columns that hold a user key are listed once, here, so the three cannot
 * disagree about which rows name a person.
 */

/** The organizations a move reaches: every one, or Local only. */
type MoveScope = 'all' | 'local'

/**
 * Every column that holds a user key, rewritten from one key to another in one
 * transaction. A grant the target already holds on the same resource wins over
 * the source's, so the move cannot break the one-grant-per-subject index.
 */
async function moveUserRows(db: Db, fromKey: string, toKey: string, scope: MoveScope): Promise<number> {
  const inScope = (column: SQL): SQL => (scope === 'local' ? sql` AND ${column} = ${LOCAL_ORGANIZATION_ID}` : sql``)
  let moved = 0
  moved += (await db.run(sql`
    DELETE FROM share_grant
    WHERE subject_kind = 'user' AND subject_id = ${fromKey}${inScope(sql`organization_id`)}
      AND EXISTS (
        SELECT 1 FROM share_grant AS kept
        WHERE kept.resource_kind = share_grant.resource_kind AND kept.resource_id = share_grant.resource_id
          AND kept.subject_kind = 'user' AND kept.subject_id = ${toKey}
      )
  `)).changes
  moved += (await db.run(sql`UPDATE share_grant SET subject_id = ${toKey} WHERE subject_kind = 'user' AND subject_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  moved += (await db.run(sql`UPDATE share_grant SET granted_by_user_id = ${toKey} WHERE granted_by_user_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  moved += (await db.run(sql`UPDATE resource_owner SET owner_user_id = ${toKey} WHERE owner_user_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  moved += (await db.run(sql`UPDATE session_records SET owner_user_id = ${toKey} WHERE owner_user_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  moved += (await db.run(sql`UPDATE session_admissions SET owner_user_id = ${toKey} WHERE owner_user_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  return moved
}

const planCommentsRowSchema = z.object({ session_id: z.string(), plan_tool_use_id: z.string(), comments: z.string().nullable() })
const workAnnotationsRowSchema = z.object({ work_id: z.string(), data: z.string().nullable() })

/** Every stored comment thread, rewritten by `rewrite`; a row it leaves as it was is not written. */
async function rewriteComments(db: Db, scope: MoveScope, rewrite: (threads: StoredThread[]) => PlanComment[]): Promise<number> {
  const where = scope === 'local' ? sql`WHERE organization_id = ${LOCAL_ORGANIZATION_ID}` : sql``
  let rewritten = 0
  const plans = planCommentsRowSchema.array().parse(await db.all(sql`SELECT session_id, plan_tool_use_id, comments FROM plan_annotations ${where}`))
  for (const row of plans) {
    if (!row.comments) continue
    // SAFETY: plan annotations are the sole writer of this column and store `StoredThread[]`.
    const before = JSON.parse(row.comments) as StoredThread[]
    const after = JSON.stringify(rewrite(before))
    if (after === row.comments) continue
    await db.run(sql`UPDATE plan_annotations SET comments = ${after} WHERE session_id = ${row.session_id} AND plan_tool_use_id = ${row.plan_tool_use_id}`)
    rewritten++
  }
  const works = workAnnotationsRowSchema.array().parse(await db.all(sql`SELECT work_id, data FROM work_annotations ${where}`))
  for (const row of works) {
    if (!row.data) continue
    // SAFETY: work annotations are the sole writer of this column and store their comments as `StoredThread[]`.
    const annotations = JSON.parse(row.data) as { comments?: StoredThread[] }
    if (!annotations.comments) continue
    const after = JSON.stringify({ ...annotations, comments: rewrite(annotations.comments) })
    if (after === row.data) continue
    await db.run(sql`UPDATE work_annotations SET data = ${after} WHERE work_id = ${row.work_id}`)
    rewritten++
  }
  return rewritten
}

/**
 * Boot, once per host (plans/012 §1, migration steps 2 and 4): rows that name the
 * owner by the host-owner sentinel move to the host's user, and every stored
 * comment gets an attribution in place of `'you'` or `'solus'`. A `'you'` with no
 * stamped person was the host's user: on a personal host that is right, on a
 * shared one it is a guess. Rows, then the mark in host settings, so a crash
 * between them only repeats a move that is already done.
 */
export async function adoptHostUser(db: Db, settings: HostUserSettings): Promise<HostUserSettings> {
  useHostUser(settings)
  const user = hostUser()
  if (settings.adoptedAt !== undefined || !user) return settings
  const toKey = userKey(user.id)
  const counts = await db.transaction(async (tx) => ({
    rows: await moveUserRows(tx, LEGACY_HOST_OWNER_KEY, toKey, 'all'),
    threads: await rewriteComments(tx, 'all', (threads) => readStoredComments(threads, user)),
  }))
  const adopted: HostUserSettings = { ...settings, adoptedAt: Date.now() }
  setHostUserSettings(adopted)
  useHostUser(adopted)
  log.info('host_user_adopted', { userKey: toKey, ...counts, note: "a 'you' comment with no person became the host's user" })
  return adopted
}

let following: Promise<void> = Promise.resolve()

/**
 * The owner's account, as the host's standing names it, or null once the link is
 * gone (U5). Linking moves every row of the host's user to the account; unlinking
 * moves the Local ones back to the `local` user. An organization's records keep
 * their account: the organization knows its people by account. Moves run one at
 * a time, in the order the link changed; rows, then host settings, as in
 * `adoptHostUser`.
 */
export function followHostAccount(db: Db, owner: HostOwnerIdentity | null): Promise<void> {
  following = following
    .then(() => moveToAccount(db, owner))
    .catch((error) => log.warn('host_user_move_failed', { error: error instanceof Error ? error.message : String(error) }))
  return following
}

async function moveToAccount(db: Db, owner: HostOwnerIdentity | null): Promise<void> {
  const current = currentHostUser()
  if (!current) return
  const next: HostUserSettings = { localId: current.localId }
  if (current.adoptedAt !== undefined) next.adoptedAt = current.adoptedAt
  if (owner) {
    next.account = { accountId: owner.userId }
    if (owner.name) next.account.displayName = owner.name
    if (owner.email) next.account.email = owner.email
  }
  if (JSON.stringify(next.account) === JSON.stringify(current.account)) return
  const previous = current
  const previousUser = hostUser()
  const fromKey = hostUserKey()
  useHostUser(next)
  const to = hostUser()
  if (!to) return
  const toKey = userKey(to.id)
  const scope: MoveScope = owner ? 'all' : 'local'
  let counts: { rows: number; threads: number }
  try {
    counts = await db.transaction(async (tx) => ({
      rows: fromKey === toKey ? 0 : await moveUserRows(tx, fromKey, toKey, scope),
      threads: await rewriteComments(tx, scope, (threads) => moveCommentUser(readStoredComments(threads, previousUser), fromKey, to)),
    }))
  } catch (error) {
    // The rows did not move, so new rows keep the key the old ones hold.
    useHostUser(previous)
    throw error
  }
  setHostUserSettings(next)
  log.info(owner ? 'host_user_linked' : 'host_user_unlinked', { fromKey, toKey, ...counts })
}
