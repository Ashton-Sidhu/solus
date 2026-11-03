import { z } from 'zod'
import { HOST_LIST_MAX_ENTRIES, hostListingSchema, type HostListing } from '@solus/contracts/host-list'
import { getDb } from '../db'
import { createLogger } from '../logger'

const log = createLogger('main', 'host-list')

/**
 * The hosts the owner connected to themselves, as this host keeps them while
 * they are signed out (plans/031 D7). A client reads and writes the list through
 * `hostListRead`, `hostListPut`, and `hostListRemove`; signed in, it uses the
 * account document instead. A row holds no credential.
 */

const rowSchema = z.object({ id: z.string(), listing: z.string() })

/** Every listing, the most recently connected first. A row that no longer parses is left out. */
export function readHostList(): HostListing[] {
  const rows = rowSchema.array().parse(getDb().prepare('SELECT id, listing FROM host_list ORDER BY last_connected DESC, id').all())
  return rows.flatMap((row) => {
    const parsed = hostListingSchema.safeParse(JSON.parse(row.listing))
    if (parsed.success) return [parsed.data]
    log.warn('host_listing_unreadable', { hostId: row.id })
    return []
  })
}

export class HostListFullError extends Error {
  constructor() {
    super(`The host list holds at most ${HOST_LIST_MAX_ENTRIES} hosts. Remove one first.`)
  }
}

/** Adds a host, or replaces the listing with the same id. */
export function putHostListing(listing: HostListing): void {
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM host_list WHERE id = ?').get(listing.id)
  if (!exists) {
    const { count } = z.object({ count: z.number() }).parse(db.prepare('SELECT COUNT(*) AS count FROM host_list').get())
    if (count >= HOST_LIST_MAX_ENTRIES) throw new HostListFullError()
  }
  db.prepare(`
    INSERT INTO host_list (id, listing, last_connected) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET listing = excluded.listing, last_connected = excluded.last_connected
  `).run(listing.id, JSON.stringify(listing), listing.lastConnected)
}

/** Removes a host; false when the list did not hold it. */
export function removeHostListing(id: string): boolean {
  return getDb().prepare('DELETE FROM host_list WHERE id = ?').run(id).changes > 0
}
