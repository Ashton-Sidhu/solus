import { sql } from 'drizzle-orm'

/**
 * Give the next test an empty database on either engine
 * (docs/plans/cloud-service-model.md). On SQLite the caller deletes the file
 * after this; on Postgres the file is not the store, so the ported tables are
 * truncated instead. The handles are closed either way, so a test that reopens
 * sees a fresh connection and the migrations run again (a no-op once applied).
 *
 * Imported lazily: the suites set `SOLUS_DATA_DIR` and mock `node:sqlite`
 * before they load the server modules, and this helper must not load them first.
 */
export async function resetTestDatabase(): Promise<void> {
  const [{ closeDb }, { getDatabase, closeDatabase }, { PORTED_TABLES }] = await Promise.all([
    import('@solus/server/db'),
    import('@solus/server/db/database'),
    import('@solus/server/db/schema'),
  ])
  const db = getDatabase()
  if (db.engine === 'postgres') {
    await db.run(sql`TRUNCATE ${sql.join(PORTED_TABLES.map((table) => sql`${table}`), sql`, `)} CASCADE`)
  }
  await closeDatabase()
  closeDb()
}
