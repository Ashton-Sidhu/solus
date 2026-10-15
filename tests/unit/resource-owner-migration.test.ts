import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'

// docs/plans/access-model.md §2.2: every resource has its owner on its own row.
// The migration that makes `owner_key` takes it from the owner row of
// `share_grant`, then from a session record's `owner_user_id`, and renames the
// table to `acl_entry`, which holds only what an owner gave others.

const folder = join(import.meta.dir, '../../packages/server/drizzle/sqlite')

describe('the resource owner migration', () => {
  test('owners move from share_grant onto their rows, and only the entries for others stay', () => {
    const migrations = readMigrationFiles({ migrationsFolder: folder })
    const ownerSlot = migrations.findIndex((migration) => migration.sql.some((statement) => statement.includes('RENAME TO `acl_entry`')))
    expect(ownerSlot).toBeGreaterThan(0)
    const db = new Database(':memory:')
    try {
      for (const migration of migrations.slice(0, ownerSlot)) for (const statement of migration.sql) db.exec(statement)
      db.exec(`INSERT INTO works (id, organization_id, content_hash) VALUES ('w-owned', 'local', 'h'), ('w-nobody', 'local', 'h')`)
      db.exec(`INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t-owned', 'T', 1, 1)`)
      db.exec(`INSERT INTO session_records (session_id, owner_user_id, provider, project_path, created_at, last_activity_at) VALUES
        ('s-row', 'bob', 'codex', '-p', 1, 1), ('s-record', 'carol', 'codex', '-p', 1, 1)`)
      db.exec(`INSERT INTO share_grant (id, resource_kind, resource_id, subject_kind, subject_id, role, granted_by_user_id, created_at) VALUES
        ('o1', 'work', 'w-owned', 'user', 'alice', 'owner', 'alice', 1),
        ('o2', 'task', 't-owned', 'user', 'alice', 'owner', 'alice', 1),
        ('o3', 'session', 's-row', 'user', 'alice', 'owner', 'alice', 1),
        ('g1', 'work', 'w-owned', 'user', 'bob', 'viewer', 'alice', 1)`)

      for (const statement of migrations[ownerSlot]!.sql) db.exec(statement)

      const owners = (table: string, id: string) => db.query(`SELECT ${id} AS id, owner_key FROM ${table} ORDER BY ${id}`).all()
      // The owner row wins over the record's column; a resource with neither keeps '', which no person holds.
      expect(owners('works', 'id')).toEqual([{ id: 'w-nobody', owner_key: '' }, { id: 'w-owned', owner_key: 'alice' }])
      expect(owners('tasks', 'id')).toEqual([{ id: 't-owned', owner_key: 'alice' }])
      expect(owners('session_records', 'session_id')).toEqual([{ id: 's-record', owner_key: 'carol' }, { id: 's-row', owner_key: 'alice' }])
      expect(db.query('SELECT id, subject_id, role FROM acl_entry').all()).toEqual([{ id: 'g1', subject_id: 'bob', role: 'viewer' }])
      expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'share_grant%'").all()).toEqual([])
    } finally {
      db.close()
    }
  })
})
