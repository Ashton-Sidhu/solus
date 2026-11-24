import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  PERSON_HISTORY_KINDS,
  PERSON_HISTORY_LIMIT,
  personHistoryKindOf,
  type PersonHistoryEntry,
} from '@solus/contracts/person-history'
import { afterDatabaseCommit, getDatabase } from '../../db/database'
import { personalResourceState } from './schema'

/**
 * A person's history in this home (docs/plans/person-state.md §4): when they
 * last opened each record, the `opened_at` of their `personal_resource_state`
 * rows. `scope` is where the rows live: `local` on a host, `person:<accountId>`
 * on the Solus API. A row is the record key split at its first colon: the kind
 * in `resource_kind`, the rest in `resource_id`. The person comes from the
 * connection, never from the request, so nobody reads or writes another
 * person's history.
 */

/** Whose history changed, and the times now held, so only that person's connections hear it. */
export interface PersonHistoryChange {
  scope: string
  personKey: string
  entries: PersonHistoryEntry[]
}

type ChangeListener = (change: PersonHistoryChange) => void
const listeners = new Set<ChangeListener>()

/** Hear each committed change to one person's history. */
export function onPersonHistoryChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const rowSchema = z.object({ resource_kind: z.string(), resource_id: z.string(), opened_at: z.coerce.number() })

/** The record key as `resource_kind` and `resource_id`. */
const KEY_COLUMNS = sql.raw(`resource_kind || ':' || resource_id`)

/**
 * Record the opens of one person. A time is capped at server time, so a client
 * with a fast clock cannot put an entry ahead of every later open, and the later
 * of the stored and the new time is kept, so a retry, a batch, or a late event
 * never moves a time back. The person keeps the newest `PERSON_HISTORY_LIMIT`.
 */
export async function recordPersonHistory(scope: string, personKey: string, entries: readonly PersonHistoryEntry[]): Promise<void> {
  const now = Date.now()
  const latest = new Map<string, number>()
  for (const entry of entries) {
    if (!personHistoryKindOf(entry.key)) continue
    const openedAt = Math.min(entry.openedAt, now)
    if (openedAt > (latest.get(entry.key) ?? -1)) latest.set(entry.key, openedAt)
  }
  if (latest.size === 0) return
  await getDatabase().transaction(async (db) => {
    for (const [key, openedAt] of latest) {
      const kind = personHistoryKindOf(key)!
      await db.run(sql`
        INSERT INTO ${personalResourceState} (organization_id, resource_kind, resource_id, created_by, opened_at)
        VALUES (${scope}, ${kind}, ${key.slice(kind.length + 1)}, ${personKey}, ${openedAt})
        ON CONFLICT (organization_id, resource_kind, resource_id, created_by) DO UPDATE SET
          opened_at = CASE WHEN personal_resource_state.opened_at IS NULL OR excluded.opened_at > personal_resource_state.opened_at
            THEN excluded.opened_at ELSE personal_resource_state.opened_at END
      `)
    }
    // The newest entries stay. An older row leaves the history; a row that holds
    // nothing else then goes, and one that holds other state keeps it.
    await db.run(sql`
      UPDATE ${personalResourceState} SET opened_at = NULL
      WHERE organization_id = ${scope} AND created_by = ${personKey} AND opened_at IS NOT NULL AND ${KEY_COLUMNS} NOT IN (
        SELECT ${KEY_COLUMNS} FROM ${personalResourceState}
        WHERE organization_id = ${scope} AND created_by = ${personKey} AND opened_at IS NOT NULL
        ORDER BY opened_at DESC, resource_kind, resource_id
        LIMIT ${PERSON_HISTORY_LIMIT}
      )
    `)
    await db.run(sql`
      DELETE FROM ${personalResourceState}
      WHERE organization_id = ${scope} AND created_by = ${personKey}
        AND resource_kind IN (${sql.join(PERSON_HISTORY_KINDS.map((kind) => sql`${kind}`), sql`, `)})
        AND opened_at IS NULL AND settled_at IS NULL AND archived_at IS NULL AND snoozed_until IS NULL AND snooze_note IS NULL
        AND viewed_at IS NULL AND pinned_at IS NULL AND pin_order_key IS NULL AND active_order_key IS NULL
    `)
  })
  const change: PersonHistoryChange = { scope, personKey, entries: [...latest].map(([key, openedAt]) => ({ key, openedAt })) }
  void afterDatabaseCommit(async () => {
    for (const listener of listeners) listener(change)
  })
}

/** One person's history in `scope`, newest open first. */
export async function readPersonHistory(scope: string, personKey: string): Promise<PersonHistoryEntry[]> {
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT resource_kind, resource_id, opened_at FROM ${personalResourceState}
    WHERE organization_id = ${scope} AND created_by = ${personKey} AND opened_at IS NOT NULL
    ORDER BY opened_at DESC, resource_kind, resource_id
    LIMIT ${PERSON_HISTORY_LIMIT}
  `))
  return rows.map((row) => ({ key: `${row.resource_kind}:${row.resource_id}`, openedAt: row.opened_at }))
}
