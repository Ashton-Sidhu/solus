import type { AgentId } from '@solus/contracts/types'
import { attributionSchema, parseUserKey, userKey, type Attribution, type User } from '@solus/contracts/user'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import type { Db } from '../db/database'
import { currentHostUser, hostUser, hostUserKey, isHostUserKey } from '../host/host-user'
import { sessionOwner } from './links/resource-links'

/**
 * Who did something, as a row stores it (plans/012-user-actor-and-activity.md §2):
 * an `Attribution` as JSON in the row's text column. Rows written before stage 4
 * hold a label (`'user'`, `'agent'`, `'You'`) or an older object; each domain
 * reads those through its own legacy mapping here, at read time, so old rows need
 * no migration.
 */

export function attributionJson(attribution: Attribution): string {
  return JSON.stringify(attribution)
}

/** The stored attribution in a column, or null when the column holds something older. */
export function parseStoredAttribution(value: string | null): Attribution | null {
  if (!value?.startsWith('{')) return null
  try {
    const parsed = attributionSchema.safeParse(JSON.parse(value))
    return parsed.success ? followHostUser(parsed.data) : null
  } catch {
    return null
  }
}

/**
 * The host's user for an old row that names them only by label: the host's
 * user, or Solus itself where there is none (the Solus API).
 */
export function hostAttribution(): Attribution {
  const user = hostUser()
  return user ? { kind: 'user', user } : { kind: 'system' }
}

/**
 * The user an old row names by key and name. The legacy host-owner key and the
 * host's own key are the host's user as they are now; any other key keeps the
 * name the row saved.
 */
export function userOfStoredKey(key: string, displayName: string): User {
  if (isHostUserKey(key)) return hostUser() ?? { id: parseUserKey(key), displayName }
  return { id: parseUserKey(key), displayName }
}

/**
 * The host's `local` user in a row written before the host linked its account
 * is that account now (U5): comment threads and owner rows move at link time,
 * and attribution columns follow here, on read.
 */
export function followHostUser(attribution: Attribution): Attribution {
  const settings = currentHostUser()
  if (!settings?.account) return attribution
  const follow = (user: User): User => user.id.kind === 'local' && user.id.localId === settings.localId ? hostUser() ?? user : user
  if (attribution.kind === 'user') return { kind: 'user', user: follow(attribution.user) }
  if ((attribution.kind === 'agent' || attribution.kind === 'automation') && attribution.for) return { ...attribution, for: follow(attribution.for) }
  return attribution
}

/** An agent's session as the doer, when all a record knows is its session. An op with no session keeps an empty id. */
export function agentAttribution(sessionId: string | null | undefined, provider?: AgentId): Attribution {
  const agent: Attribution = { kind: 'agent', sessionId: sessionId ?? '' }
  if (provider) agent.provider = provider
  return agent
}

const creatorRowSchema = z.object({ created_by: z.string() })

/**
 * The signed-in person an attribution acts for (plans/029 decision 2): the user
 * themselves; the person an agent or automation names with `for`; else an
 * agent's session owner or an automation's creator; else the host's user, on
 * whose behalf the host acts. Never null: every row names a person.
 */
export async function actingPersonKey(by: Attribution, db: Db): Promise<string> {
  if (by.kind === 'user') return userKey(by.user.id)
  if ((by.kind === 'agent' || by.kind === 'automation') && by.for) return userKey(by.for.id)
  if (by.kind === 'agent') return (await sessionOwner(db, by.sessionId)) ?? hostUserKey()
  if (by.kind === 'automation') {
    // SAFETY: the statement selects one text column of the host table.
    const row = creatorRowSchema.nullish().parse(getDb().prepare('SELECT created_by FROM automations WHERE id = ?').get(by.automationId))
    return row?.created_by ?? hostUserKey()
  }
  return hostUserKey()
}
