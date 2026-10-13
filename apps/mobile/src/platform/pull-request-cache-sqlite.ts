// Adapted from T3 Code apps/mobile/src/persistence/mobile-database.ts (MIT, see UPSTREAM.md).
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite'
import type { PullRequestCacheDatabase } from '../features/prs/pull-request-cache'

/**
 * The pull request cache in the app's own SQLite file. The bounds are not
 * here: `PullRequestCache` reads the entries and names the records to remove,
 * so the same rules run under test with the memory database.
 */
export function sqlitePullRequestCache(name = 'solus-pull-requests.db'): PullRequestCacheDatabase {
  let opened: Promise<SQLiteDatabase> | null = null
  const open = async () => {
    const db = await openDatabaseAsync(name)
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pull_request_cache (
        host_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, kind, cache_key)
      ) WITHOUT ROWID;
    `)
    return db
  }
  const database = () => {
    if (opened) return opened
    const attempt = open()
    opened = attempt
    // A failed open is not kept: a later call tries to open the file again.
    attempt.then(undefined, () => { if (opened === attempt) opened = null })
    return attempt
  }
  return {
    get: async (kind, hostId, key) => {
      const row = await (await database()).getFirstAsync<{ payload: string; updated_at: number }>(
        'SELECT payload, updated_at FROM pull_request_cache WHERE host_id = ? AND kind = ? AND cache_key = ?',
        hostId, kind, key,
      )
      return row ? { payload: row.payload, updatedAt: row.updated_at } : null
    },
    put: async (kind, hostId, entry) => {
      await (await database()).runAsync(
        `INSERT INTO pull_request_cache (host_id, kind, cache_key, payload, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (host_id, kind, cache_key) DO UPDATE SET
           payload = excluded.payload, bytes = excluded.bytes, updated_at = excluded.updated_at`,
        hostId, kind, entry.key, entry.payload, entry.bytes, entry.updatedAt,
      )
    },
    delete: async (kind, hostId, keys) => {
      const db = await database()
      for (const key of keys) {
        await db.runAsync('DELETE FROM pull_request_cache WHERE host_id = ? AND kind = ? AND cache_key = ?', hostId, kind, key)
      }
    },
    entries: async (kind, hostId) => {
      const rows = await (await database()).getAllAsync<{ cache_key: string; bytes: number; updated_at: number }>(
        'SELECT cache_key, bytes, updated_at FROM pull_request_cache WHERE host_id = ? AND kind = ?',
        hostId, kind,
      )
      return rows.map((row) => ({ key: row.cache_key, bytes: row.bytes, updatedAt: row.updated_at }))
    },
    deleteHost: async (hostId) => {
      await (await database()).runAsync('DELETE FROM pull_request_cache WHERE host_id = ?', hostId)
    },
  }
}
