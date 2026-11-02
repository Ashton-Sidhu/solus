import type { DatabaseSync } from 'node:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationsFolder, type MigrationSchema } from './migration-files'

/**
 * Apply one schema's generated SQLite migrations to an open connection,
 * synchronously.
 *
 * This is the rule of `drizzle-orm/sqlite-proxy/migrator` — one bookkeeping
 * row per applied file, a file is due when it is newer than the last row — run
 * inline so the file is fully migrated the moment `getDb()` returns, and a
 * synchronous caller never sees half a schema. The host tables and the ported
 * records share `solus.db`, so each schema keeps its own bookkeeping table.
 *
 * There is no migration history: every schema is one generated baseline
 * (docs/database-schema.md). A file whose applied rows this folder does not
 * know was made by another version of the schema and cannot be opened; the
 * error names the file to delete.
 */
export function runSqliteSchemaMigrations(db: DatabaseSync, schema: MigrationSchema, fileName: string): void {
  const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder(schema) })
  const table = schema === 'sqlite' ? '__drizzle_migrations' : `__drizzle_migrations_${schema}`
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)`)
  // SAFETY: the statement selects the two columns of the table created above.
  const applied = db.prepare(`SELECT hash, created_at FROM "${table}" ORDER BY created_at`).all() as
    Array<{ hash: string; created_at: number | string }>
  const known = new Set(migrations.map((migration) => migration.hash))
  // SAFETY: the pragma always returns one row with this integer column.
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  // Files from before the baselines numbered their hand-written slots in `user_version`.
  if (userVersion !== 0 || applied.some((row) => !known.has(row.hash))) {
    throw new Error(`${fileName} was made by another version of the schema. Delete ${fileName} (and its -wal and -shm files) in the Solus data directory; it is recreated empty.`)
  }
  const appliedThrough = applied.length ? Number(applied[applied.length - 1]!.created_at) : -1
  // A generated migration that drops a column rebuilds the table: it copies the
  // rows to a new table and drops the old one. SQLite ignores its own
  // `PRAGMA foreign_keys=OFF` inside the transaction below, so with enforcement
  // on, that DROP would cascade and delete every row that references the table.
  // SAFETY: the pragma returns one integer column.
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const migration of migrations) {
      if (migration.folderMillis <= appliedThrough) continue
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const statement of migration.sql) db.exec(statement)
        db.prepare(`INSERT INTO "${table}" (hash, created_at) VALUES (?, ?)`).run(migration.hash, migration.folderMillis)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}
