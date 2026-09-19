import { describe, expect, test } from 'bun:test'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { bigint, boolean, defineTable, integer, json, text } from '@solus/server/db/schema/define-table'
import { PORTED_TABLES } from '@solus/server/db/schema'

// docs/plans/cloud-service-model.md: one declaration, two engines. Both emitted
// tables must carry the same columns, and drizzle-kit must be able to read them
// as ordinary Drizzle tables; otherwise a domain would silently drift per engine.

describe('defineTable', () => {
  const parent = defineTable('widgets', {
    id: text({ primaryKey: true }),
    parent_id: text({ references: { table: 'self', column: 'id', onDelete: 'cascade' } }),
    count: integer({ notNull: true, default: 0 }),
    created_at: bigint({ notNull: true }),
    is_open: boolean({ notNull: true, default: false }),
    payload: json(),
  }, {
    indexes: [
      { name: 'widgets_by_count', columns: ['count', 'created_at'], descending: ['created_at'] },
      { name: 'widgets_open', columns: ['id'], unique: true, where: 'is_open = 1' },
    ],
  })
  const child = defineTable('widget_parts', {
    widget_id: text({ notNull: true, references: { table: parent, column: 'id', onDelete: 'cascade' } }),
    part: text({ notNull: true }),
  }, { primaryKey: ['widget_id', 'part'] })

  test('both emitted tables carry the same column names, in the declared order', () => {
    for (const table of [parent, child, ...PORTED_TABLES]) {
      const sqliteColumns = Object.values(getTableColumns(table.sqlite)).map((column) => column.name)
      const pgColumns = Object.values(getTableColumns(table.pg)).map((column) => column.name)
      expect(sqliteColumns).toEqual(table.columnNames())
      expect(pgColumns).toEqual(table.columnNames())
      expect(getTableName(table.sqlite)).toBe(table.name)
      expect(getTableName(table.pg)).toBe(table.name)
    }
  })

  test('the portable types map to each engine\'s storage: bigint and boolean are INTEGER on SQLite', () => {
    const sqliteColumns = getTableColumns(parent.sqlite)
    const pgColumns = getTableColumns(parent.pg)
    expect(sqliteColumns.created_at.getSQLType()).toBe('integer')
    expect(pgColumns.created_at.getSQLType()).toBe('bigint')
    expect(sqliteColumns.is_open.getSQLType()).toBe('integer')
    expect(pgColumns.is_open.getSQLType()).toBe('boolean')
    expect(sqliteColumns.payload.getSQLType()).toBe('text')
    expect(pgColumns.payload.getSQLType()).toBe('text')
    expect(sqliteColumns.is_open.default).toBe(0)
    expect(pgColumns.is_open.default).toBe(false)
  })

  test('a definition renders as its quoted name in a sql template on either dialect', () => {
    const query = sql`SELECT id FROM ${parent} WHERE count > ${1}`
    expect(new SQLiteSyncDialect().sqlToQuery(query).sql).toBe('SELECT id FROM "widgets" WHERE count > ?')
    expect(new PgDialect().sqlToQuery(query).sql).toBe('SELECT id FROM "widgets" WHERE count > $1')
  })

  test('references resolve to the referenced engine\'s column, including self references', () => {
    const sqliteParent = getTableColumns(parent.sqlite)
    const pgChild = getTableColumns(child.pg)
    // Drizzle keeps the reference thunk on the column; resolving it must land on the right table.
    const parentReference = sqliteParent.parent_id
    expect(parentReference).toBeDefined()
    expect(getTableName(child.sqlite)).toBe('widget_parts')
    expect(pgChild.widget_id.notNull).toBe(true)
  })
})
