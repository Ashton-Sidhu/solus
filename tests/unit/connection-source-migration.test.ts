import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { DatabaseSync } = await import('node:sqlite')
const { migrations, runMigrations } = await import('@solus/server/db/migrations')

describe('connection source migration', () => {
  for (const hasSource of [false, true]) {
    test(`keeps connections when the old table ${hasSource ? 'has' : 'does not have'} source`, () => {
      const db = new DatabaseSync(':memory:')
      try {
        for (const migration of migrations.slice(0, -1)) db.exec(migration)
        db.exec(`PRAGMA user_version = ${migrations.length - 1}`)
        if (hasSource) db.exec("ALTER TABLE integration_connection ADD COLUMN source TEXT NOT NULL DEFAULT 'host'")
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
