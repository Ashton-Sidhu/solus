import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync as BunDatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: BunDatabaseSync }))

const { DatabaseSync } = await import('node:sqlite')
const { migrations, runMigrations } = await import('@solus/server/db/migrations')

describe('connection source migration', () => {
  for (const hasSource of [false, true]) {
    test(`keeps connections when the old table ${hasSource ? 'has' : 'does not have'} source`, () => {
      const db = new DatabaseSync(':memory:')
      try {
        // The file as it stood before the source slot: every slot before it applied.
        const sourceSlot = migrations.findIndex((migration) => migration.includes('integration_connection ADD COLUMN source'))
        for (const migration of migrations.slice(0, sourceSlot)) db.exec(migration)
        db.exec(`PRAGMA user_version = ${sourceSlot}`)
        if (hasSource) db.exec("ALTER TABLE integration_connection ADD COLUMN source TEXT NOT NULL DEFAULT 'host'")
        db.prepare("INSERT INTO integration (id, organization_id, owner_user_id, kind, slug, name, url, auth, created_at, updated_at) VALUES ('integration-1', 'local', 'account:alice', 'mcp', 'wiki', 'Wiki', 'https://wiki.example/mcp', '{}', '1', '1')").run()
        db.prepare('INSERT INTO integration_connection (integration_id, user_id, status, label, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run('integration-1', 'account:alice', 'connected', 'Alice', '2026-10-09')
        if (hasSource) db.exec("UPDATE integration_connection SET source = 'account'")

        runMigrations(db)
        expect(db.prepare('SELECT status, label, source FROM integration_connection').get()).toEqual({
          status: 'connected', label: 'Alice', source: hasSource ? 'account' : 'host',
        })
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: migrations.length })
        runMigrations(db)
        expect(db.prepare('SELECT COUNT(*) AS count FROM integration_connection').get()).toEqual({ count: 1 })
      } finally {
        db.close()
      }
    })
  }

  test('an integration with no owner and its connections are not kept; an owned one moves to owner_key', () => {
    // WHY (docs/plans/access-model.md, D3): there are no shared MCP servers. A shared row
    // from before would be a server nobody owns, which no rule can reach.
    const db = new DatabaseSync(':memory:')
    try {
      const ownerSlot = migrations.findIndex((migration) => migration.includes('owner_key TEXT NOT NULL'))
      for (const migration of migrations.slice(0, ownerSlot)) db.exec(migration)
      db.exec(`PRAGMA user_version = ${ownerSlot}`)
      const insert = db.prepare("INSERT INTO integration (id, organization_id, owner_user_id, kind, slug, name, url, auth, created_at, updated_at) VALUES (?, 'local', ?, 'mcp', ?, 'n', 'https://x.example/mcp', '{}', '1', '1')")
      insert.run('shared', null, 'shared')
      insert.run('owned', 'account:alice', 'owned')
      const connect = db.prepare("INSERT INTO integration_connection (integration_id, user_id, status, updated_at) VALUES (?, 'account:alice', 'connected', '1')")
      connect.run('shared')
      connect.run('owned')
      runMigrations(db)
      expect(db.prepare('SELECT id, owner_key FROM integration').all()).toEqual([{ id: 'owned', owner_key: 'account:alice' }])
      expect(db.prepare('SELECT integration_id FROM integration_connection').all()).toEqual([{ integration_id: 'owned' }])
    } finally {
      db.close()
    }
  })

  test('a new host receives the source column', () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db)
      db.prepare('INSERT INTO integration_connection (integration_id, user_id, status, updated_at) VALUES (?, ?, ?, ?)')
        .run('integration-1', 'account:alice', 'connected', '2026-10-09')
      expect(db.prepare('SELECT source FROM integration_connection').get()).toEqual({ source: 'host' })
    } finally {
      db.close()
    }
  })
})
