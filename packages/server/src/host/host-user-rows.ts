import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { HostOwnerIdentity } from '@solus/contracts/uplink'
import { userKey } from '@solus/contracts/user'
import type { PlanComment } from '@solus/contracts/types'
import { moveCommentUser, readStoredComments, type StoredThread } from '../annotations/stored-comments'
import type { Db } from '../db/database'
import { createLogger } from '../logger'
import { vault } from '../vault/vault'
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
 * The resource tables whose rows have an owner (docs/plans/access-model.md §2.2),
 * with the kind their ACL entries name and their id column. One list, so a new
 * resource cannot be forgotten on link and unlink.
 */
const OWNED_RESOURCES = [
  { table: 'session_records', kind: 'session', id: 'session_id' },
  { table: 'works', kind: 'work', id: 'id' },
  { table: 'tasks', kind: 'task', id: 'id' },
  { table: 'automations', kind: 'automation', id: 'id' },
  { table: 'workspace_projects', kind: 'project', id: 'id' },
] as const

/*
 * Not moved: `browser_profiles` and `browser_profile_defaults`. A profile's jar
 * is named by its person key (docs/plans/member-isolation.md §6) and the jar
 * cannot move, so a moved row would name an empty jar. After a link or an
 * unlink the host's user starts with no named profiles; the old ones come back
 * with their jars if the key returns.
 */

/** Other columns that hold a person key and move as they are. */
const PERSON_COLUMNS = [
  { table: 'session_admissions', column: 'owner_key' },
  { table: 'acl_entry', column: 'granted_by_user_id' },
] as const

/**
 * Every column that holds a user key, rewritten from one key to another in one
 * transaction: the owner of every resource, the subject of every ACL entry, and
 * the other person columns. An entry for a resource the target now owns would
 * repeat the owner and is dropped; an entry the target already holds on the same
 * resource wins over the source's, so the move cannot break the one-entry-per-subject index.
 */
async function moveUserRows(db: Db, fromKey: string, toKey: string, scope: MoveScope): Promise<number> {
  const inScope = (column: SQL): SQL => (scope === 'local' ? sql` AND ${column} = ${LOCAL_ORGANIZATION_ID}` : sql``)
  let moved = 0
  for (const { table, kind, id } of OWNED_RESOURCES) {
    moved += (await db.run(sql`UPDATE ${sql.identifier(table)} SET owner_key = ${toKey} WHERE owner_key = ${fromKey}${inScope(sql`organization_id`)}`)).changes
    moved += (await db.run(sql`
      DELETE FROM acl_entry
      WHERE resource_kind = ${kind} AND subject_kind = 'user' AND subject_id IN (${fromKey}, ${toKey})${inScope(sql`organization_id`)}
        AND resource_id IN (SELECT ${sql.identifier(id)} FROM ${sql.identifier(table)} WHERE owner_key = ${toKey})
    `)).changes
  }
  moved += (await db.run(sql`
    DELETE FROM acl_entry
    WHERE subject_kind = 'user' AND subject_id = ${fromKey}${inScope(sql`organization_id`)}
      AND EXISTS (
        SELECT 1 FROM acl_entry AS kept
        WHERE kept.resource_kind = acl_entry.resource_kind AND kept.resource_id = acl_entry.resource_id
          AND kept.subject_kind = 'user' AND kept.subject_id = ${toKey}
      )
  `)).changes
  moved += (await db.run(sql`UPDATE acl_entry SET subject_id = ${toKey} WHERE subject_kind = 'user' AND subject_id = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  for (const { table, column } of PERSON_COLUMNS) {
    moved += (await db.run(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${toKey} WHERE ${sql.identifier(column)} = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  }
  // The person's notifications and their read state go with them (plans/015-notifications-hub.md);
  // a row the target already has for the same event wins.
  moved += (await db.run(sql`
    DELETE FROM notifications WHERE recipient_key = ${fromKey}${inScope(sql`organization_id`)} AND EXISTS (
      SELECT 1 FROM notifications AS kept WHERE kept.organization_id = notifications.organization_id
        AND kept.recipient_key = ${toKey} AND kept.event_id = notifications.event_id
    )
  `)).changes
  moved += (await db.run(sql`UPDATE notifications SET recipient_key = ${toKey} WHERE recipient_key = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  // The person's MCP servers and connections (docs/plans/mcp-integrations.md §4.1). A server
  // the target already has under the same slug, or a connection they already hold, wins.
  moved += (await db.run(sql`
    UPDATE integration SET owner_key = ${toKey} WHERE owner_key = ${fromKey}${inScope(sql`organization_id`)}
      AND NOT EXISTS (
        SELECT 1 FROM integration AS kept WHERE kept.organization_id = integration.organization_id
          AND kept.owner_key = ${toKey} AND kept.slug = integration.slug
      )
  `)).changes
  moved += (await db.run(sql`UPDATE integration SET created_by = ${toKey} WHERE created_by = ${fromKey}${inScope(sql`organization_id`)}`)).changes
  const connectionsInScope = scope === 'local' ? sql` AND integration_id IN (SELECT id FROM integration WHERE organization_id = ${LOCAL_ORGANIZATION_ID})` : sql``
  moved += (await db.run(sql`
    DELETE FROM integration_connection WHERE user_id = ${fromKey}${connectionsInScope} AND EXISTS (
      SELECT 1 FROM integration_connection AS kept WHERE kept.integration_id = integration_connection.integration_id AND kept.user_id = ${toKey}
    )
  `)).changes
  moved += (await db.run(sql`UPDATE integration_connection SET user_id = ${toKey} WHERE user_id = ${fromKey}${connectionsInScope}`)).changes
  return moved
}

const connectionRowSchema = z.object({ integration_id: z.string() })

/** The integrations whose connection the person holds, in the organizations a move reaches. */
async function connectedIntegrations(db: Db, userKey: string, scope: MoveScope): Promise<string[]> {
  const inScope = scope === 'local' ? sql` AND integration_id IN (SELECT id FROM integration WHERE organization_id = ${LOCAL_ORGANIZATION_ID})` : sql``
  return connectionRowSchema.array().parse(await db.all(sql`SELECT integration_id FROM integration_connection WHERE user_id = ${userKey}${inScope}`))
    .map((row) => row.integration_id)
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
 * their account: the organization knows its people by account. Credentials do
 * not stay with a link change (docs/plans/cloud-vault.md §2.5): at the link they
 * move into the account, and at the unlink the host keeps none of the person's,
 * so their Local MCP connections end. Moves run one at a time, in the order the
 * link changed; rows, then host settings, as in `adoptHostUser`.
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
  let counts: { dropped: number; rows: number; threads: number }
  const connected = fromKey === toKey ? [] : await connectedIntegrations(db, fromKey, scope)
  try {
    counts = await db.transaction(async (tx) => ({
      // Unlinked, the host keeps nothing for the person (docs/plans/cloud-vault.md §2.5): their Local connections end, they do not move.
      dropped: owner || fromKey === toKey ? 0 : await dropConnections(tx, fromKey),
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
  if (!owner) {
    vault().forgetPerson(fromKey, connected)
    return
  }
  // The tokens follow their rows, after the rows are saved: a token never names a person no row does.
  // The reconcile moves them into the account; the other logins go now (docs/plans/cloud-vault.md §2.5).
  vault().move(fromKey, toKey, connected)
  await vault().settleLinked(toKey)
}

/** The person's connection rows to the Local organization's integrations. */
async function dropConnections(db: Db, userKey: string): Promise<number> {
  return (await db.run(sql`
    DELETE FROM integration_connection WHERE user_id = ${userKey}
      AND integration_id IN (SELECT id FROM integration WHERE organization_id = ${LOCAL_ORGANIZATION_ID})
  `)).changes
}
