import type { DatabaseSync } from 'node:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationsFolder } from './migration-files'
import { PORTED_TABLES } from './schema'
import type { ColumnSpec } from './schema/define-table'

/**
 * Apply the generated SQLite migrations to an open connection, synchronously.
 *
 * This is the rule of `drizzle-orm/sqlite-proxy/migrator` — one
 * `__drizzle_migrations` row per applied file, a file is due when it is newer
 * than the last row — run inline so the file is fully migrated the moment
 * `getDb()` returns. The legacy hand-written migrations and the generated ones
 * share the connection, and a synchronous caller must never see half a schema.
 * The generated SQLite migrations use `IF NOT EXISTS`, so a database that
 * predates them, with the same tables created by hand, is left as it is —
 * and then brought up to the declared column list (see `addMissingColumns`).
 */
export function runSqliteSchemaMigrations(db: DatabaseSync): void {
  const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder('sqlite') })
  const rebuilt = setAsideShareTablesWithoutTaskKind(db)
  db.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)')
  // SAFETY: the statement selects one numeric column from the table created above.
  const last = db.prepare('SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1').get() as
    | { created_at: number | string }
    | undefined
  const appliedThrough = last ? Number(last.created_at) : -1
  // A file that never ran a generated migration may hold hand-made tables that
  // lack declared columns. A table rebuild copies every declared column, so
  // those columns must exist before the migrations run, not only after.
  if (!last) addMissingColumns(db)
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
        db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
  addMissingColumns(db)
  restoreSetAsideRows(db, rebuilt)
}

const SHARE_TABLES = ['resource_owner', 'share_grant']

/**
 * A share table made before tasks could be shared carries a CHECK that refuses
 * the kind, and SQLite cannot alter a constraint. Such a table is set aside
 * under a `_before_tasks` name so the generated migration makes the declared
 * one; `restoreSetAsideRows` then copies the rows over and drops the old table.
 * The generated tables carry no CHECK at all (the row schemas validate on read).
 */
function setAsideShareTablesWithoutTaskKind(db: DatabaseSync): string[] {
  const setAside: string[] = []
  for (const table of SHARE_TABLES) {
    // SAFETY: sqlite_master's `sql` is the text of the CREATE statement, one row per table.
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined
    if (!existing || existing.sql.includes("'task'") || !existing.sql.includes('CHECK')) continue
    db.exec(`ALTER TABLE "${table}" RENAME TO "${table}_before_tasks"`)
    // Its indexes keep their names and would make the generated ones skip.
    // SAFETY: sqlite_master's `name` is the index name; `sql` is null for automatic indexes.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(`${table}_before_tasks`) as Array<{ name: string }>
    for (const index of indexes) db.exec(`DROP INDEX "${index.name}"`)
    setAside.push(table)
  }
  return setAside
}

function restoreSetAsideRows(db: DatabaseSync, tables: string[]): void {
  for (const table of tables) {
    // SAFETY: pragma_table_info returns one `name` text column per table column.
    const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all(`${table}_before_tasks`) as Array<{ name: string }>)
      .map((column) => `"${column.name}"`)
      .join(', ')
    db.exec(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM "${table}_before_tasks"`)
    db.exec(`DROP TABLE "${table}_before_tasks"`)
  }
}

/**
 * A table the hand-written migrations created before its domain was ported has
 * the columns of its last hand-made shape and none that the ported schema added
 * since, `organization_id` first among them. `CREATE TABLE IF NOT EXISTS` left
 * it as it was; this adds each declared column the live table lacks, with the
 * declared default, so every ported query can name every declared column.
 */
function addMissingColumns(db: DatabaseSync): void {
  for (const table of PORTED_TABLES) {
    const present = new Set(
      // SAFETY: pragma_table_info returns one `name` text column per table column.
      (db.prepare('SELECT name FROM pragma_table_info(?)').all(table.name) as Array<{ name: string }>)
        .map((row) => row.name),
    )
    if (!present.size) continue
    for (const [column, spec] of Object.entries(table.columns)) {
      if (present.has(column)) continue
      db.exec(`ALTER TABLE "${table.name}" ADD COLUMN "${column}" ${sqliteColumnDdl(spec)}`)
    }
  }
}

function sqliteColumnDdl(spec: ColumnSpec): string {
  const type = spec.type === 'text' || spec.type === 'json' ? 'TEXT' : 'INTEGER'
  // SQLite adds a NOT NULL column only with a default to fill the existing rows.
  const literal = sqliteDefaultLiteral(spec)
  if (literal !== undefined) return `${type}${spec.notNull ? ' NOT NULL' : ''} DEFAULT ${literal}`
  return type
}

/** The declared default as SQLite DDL spells it: a quoted string for text columns, a number otherwise. */
function sqliteDefaultLiteral(spec: ColumnSpec): string | undefined {
  if (spec.default === undefined) return undefined
  if (spec.type === 'text' || spec.type === 'json') return `'${String(spec.default).replaceAll("'", "''")}'`
  if (spec.default === true) return '1'
  if (spec.default === false) return '0'
  return String(spec.default)
}
