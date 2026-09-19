import type { DatabaseSync } from 'node:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationsFolder } from './migration-files'

/**
 * Apply the generated SQLite migrations to an open connection, synchronously.
 *
 * This is the rule of `drizzle-orm/sqlite-proxy/migrator` — one
 * `__drizzle_migrations` row per applied file, a file is due when it is newer
 * than the last row — run inline so the file is fully migrated the moment
 * `getDb()` returns. The legacy hand-written migrations and the generated ones
 * share the connection, and a synchronous caller must never see half a schema.
 * The generated SQLite migrations use `IF NOT EXISTS`, so a database that
 * predates them, with the same tables created by hand, is left as it is.
 */
export function runSqliteSchemaMigrations(db: DatabaseSync): void {
  const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder('sqlite') })
  db.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)')
  // SAFETY: the statement selects one numeric column from the table created above.
  const last = db.prepare('SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1').get() as
    | { created_at: number | string }
    | undefined
  const appliedThrough = last ? Number(last.created_at) : -1
  for (const migration of migrations) {
    if (migration.folderMillis <= appliedThrough) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of migration.sql) db.exec(statement)
      db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
