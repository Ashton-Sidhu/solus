import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { HostOwnerIdentity } from '@solus/contracts/uplink'
import type { Db } from '../db/database'
import { createLogger } from '../logger'
import { vault, type HostConnectionKey } from '../vault/vault'
import { currentHostUser, hostUserKey, useHostUser } from './host-user'
import { setHostUserSettings, type HostUserSettings } from './settings'

const log = createLogger('main', 'host-user')

/**
 * What a link to the owner's account changes on the host (plans/031 D1). The host's
 * user keeps one key, `local:<id>`, signed in or not, so no row is rewritten: every
 * record on the disk is the owner's either way (plans/031 rule 1), and the cloud
 * boundary names the linked account (D4). A link changes the host user's settings
 * and moves the person's credentials into the account; an unlink leaves the host
 * none of them (docs/plans/cloud-vault.md §2.5).
 */

const connectionRowSchema = z.object({ integration_id: z.string(), account_id: z.string() })

/** The connections the person holds, every account of each. */
async function connectedIntegrations(db: Db, userKey: string): Promise<HostConnectionKey[]> {
  return connectionRowSchema.array().parse(await db.all(sql`SELECT integration_id, account_id FROM integration_connection WHERE user_id = ${userKey}`))
    .map((row) => ({ integrationId: row.integration_id, accountId: row.account_id }))
}

let following: Promise<void> = Promise.resolve()

/**
 * The owner's account, as the host's standing names it, or null once the link is
 * gone (U5). Changes run one at a time, in the order the link changed.
 */
export function followHostAccount(db: Db, owner: HostOwnerIdentity | null): Promise<void> {
  following = following
    .then(() => followAccount(db, owner))
    .catch((error) => log.warn('host_user_link_failed', { error: error instanceof Error ? error.message : String(error) }))
  return following
}

async function followAccount(db: Db, owner: HostOwnerIdentity | null): Promise<void> {
  const current = currentHostUser()
  if (!current) return
  const next: HostUserSettings = { localId: current.localId }
  if (owner) {
    next.account = { accountId: owner.userId }
    if (owner.name) next.account.displayName = owner.name
    if (owner.email) next.account.email = owner.email
  }
  if (JSON.stringify(next.account) === JSON.stringify(current.account)) return
  const key = hostUserKey()
  setHostUserSettings(next)
  useHostUser(next)
  log.info(owner ? 'host_user_linked' : 'host_user_unlinked', { userKey: key })
  if (owner) {
    // The logins and the TypeSafe key go into the account; the reconcile moves the MCP credentials.
    await vault().settleLinked(key)
    return
  }
  const connected = await connectedIntegrations(db, key)
  await db.run(sql`DELETE FROM integration_connection WHERE user_id = ${key}`)
  vault().forgetPerson(key, connected)
}
