import { desc, getTableColumns, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import * as pg from 'drizzle-orm/pg-core'
import * as sqlite from 'drizzle-orm/sqlite-core'

/**
 * One table declaration, two Drizzle tables (docs/plans/cloud-service-model.md).
 *
 * A domain writes its columns once as plain specs and gets the `sqlite-core`
 * and `pg-core` tables drizzle-kit needs to generate a migration per engine.
 * The column set is deliberately small — the portable subset both engines
 * store the same way:
 *
 * - `text`      TEXT on both.
 * - `integer`   INTEGER / integer (int4): counts, small ids, and 0/1 flags a
 *               domain chose to keep as integers.
 * - `bigint`    INTEGER / bigint (int8), read as a JS number: every timestamp
 *               is milliseconds since the epoch.
 * - `boolean`   INTEGER 0/1 on SQLite, boolean on Postgres.
 * - `json`      TEXT on both; the domain stringifies and parses.
 *
 * A definition is also usable inside a `sql` template (`FROM ${tasks}`): it
 * renders as the quoted table name in either dialect, so one query text runs
 * on both engines.
 */
export type ColumnType = 'text' | 'integer' | 'bigint' | 'boolean' | 'json'

export interface ColumnReference {
  /** The referenced definition, or `'self'` for a column that points at its own table. */
  table: TableDefinition | 'self'
  column: string
  onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action'
}

export interface ColumnSpec {
  type: ColumnType
  notNull?: boolean
  primaryKey?: boolean
  unique?: boolean
  default?: string | number | boolean
  references?: ColumnReference
}

export interface IndexSpec {
  name: string
  columns: string[]
  /** Columns of `columns` the index orders descending. */
  descending?: string[]
  unique?: boolean
  /** A portable predicate for a partial index, for example `external_id IS NOT NULL`. */
  where?: string
}

export interface TableOptions {
  /** A composite primary key. A single-column key is declared on the column. */
  primaryKey?: string[]
  indexes?: IndexSpec[]
}

export interface ColumnSpecs {
  [column: string]: ColumnSpec
}

export interface TableDefinition extends SQLWrapper {
  readonly name: string
  readonly columns: ColumnSpecs
  readonly options: TableOptions
  readonly sqlite: sqlite.SQLiteTable
  readonly pg: pg.PgTable
  /** The column names, in declaration order. */
  columnNames(): string[]
  getSQL(): SQL
  /** Renders bare, not as a parenthesized subquery, so `FROM ${table}` and `INSERT INTO ${table}` are plain. */
  shouldOmitSQLParens(): boolean
}

export const text = (spec: Omit<ColumnSpec, 'type'> = {}): ColumnSpec => ({ type: 'text', ...spec })
export const integer = (spec: Omit<ColumnSpec, 'type'> = {}): ColumnSpec => ({ type: 'integer', ...spec })
export const bigint = (spec: Omit<ColumnSpec, 'type'> = {}): ColumnSpec => ({ type: 'bigint', ...spec })
export const boolean = (spec: Omit<ColumnSpec, 'type'> = {}): ColumnSpec => ({ type: 'boolean', ...spec })
export const json = (spec: Omit<ColumnSpec, 'type'> = {}): ColumnSpec => ({ type: 'json', ...spec })

type SqliteColumnBuilder = ReturnType<typeof sqlite.text> | ReturnType<typeof sqlite.integer>
type PgColumnBuilder =
  | ReturnType<typeof pg.text>
  | ReturnType<typeof pg.integer>
  | ReturnType<typeof pg.boolean>
  | ReturnType<typeof pg.bigint<string, 'number'>>

interface ColumnsOf<TColumn> {
  [column: string]: TColumn
}

/** SQLite has no boolean: a boolean default is stored as its 0/1 integer. */
function sqliteDefault(spec: ColumnSpec): string | number | undefined {
  if (spec.default === true) return 1
  if (spec.default === false) return 0
  return spec.default
}

function referencedColumn<TColumn>(
  name: string,
  reference: ColumnReference,
  self: () => ColumnsOf<TColumn>,
  foreign: (table: TableDefinition) => ColumnsOf<TColumn>,
): TColumn {
  const target = reference.table === 'self' ? self() : foreign(reference.table)
  const column = target[reference.column]
  if (!column) throw new Error(`Column ${name} references an unknown column ${reference.column}.`)
  return column
}

function sqliteColumn(name: string, spec: ColumnSpec, self: () => ColumnsOf<sqlite.SQLiteColumn>): SqliteColumnBuilder {
  let column: SqliteColumnBuilder = spec.type === 'text' || spec.type === 'json'
    ? sqlite.text(name)
    : sqlite.integer(name)
  if (spec.primaryKey) column = column.primaryKey()
  if (spec.notNull) column = column.notNull()
  if (spec.unique) column = column.unique()
  const fallback = sqliteDefault(spec)
  if (fallback !== undefined) column = column.default(fallback)
  const reference = spec.references
  if (reference) {
    column = column.references(
      () => referencedColumn(name, reference, self, (table) => getTableColumns(table.sqlite)),
      { onDelete: reference.onDelete },
    )
  }
  return column
}

function pgColumn(name: string, spec: ColumnSpec, self: () => ColumnsOf<pg.PgColumn>): PgColumnBuilder {
  let column: PgColumnBuilder
  switch (spec.type) {
    case 'text':
    case 'json':
      column = pg.text(name)
      break
    case 'integer':
      column = pg.integer(name)
      break
    case 'bigint':
      column = pg.bigint(name, { mode: 'number' })
      break
    case 'boolean':
      column = pg.boolean(name)
      break
  }
  if (spec.primaryKey) column = column.primaryKey()
  if (spec.notNull) column = column.notNull()
  if (spec.unique) column = column.unique()
  if (spec.default !== undefined) {
    // SAFETY: a spec default is a string, number, or boolean, and the column kinds above accept exactly those.
    column = column.default(spec.default as never)
  }
  const reference = spec.references
  if (reference) {
    column = column.references(
      () => referencedColumn(name, reference, self, (table) => getTableColumns(table.pg)),
      { onDelete: reference.onDelete },
    )
  }
  return column
}

/** The named columns as a non-empty tuple, which is what Drizzle's key and index builders take. */
function columnTuple<TColumn>(owner: string, names: string[], columns: ColumnsOf<TColumn>): [TColumn, ...TColumn[]] {
  const [first, ...rest] = names.map((name) => {
    const column = columns[name]
    if (!column) throw new Error(`${owner} names an unknown column ${name}.`)
    return column
  })
  if (!first) throw new Error(`${owner} names no columns.`)
  return [first, ...rest]
}

function indexColumns<TColumn extends SQLWrapper>(
  spec: IndexSpec,
  columns: ColumnsOf<TColumn>,
): [TColumn | SQL, ...Array<TColumn | SQL>] {
  const descending = new Set(spec.descending ?? [])
  const [first, ...rest] = columnTuple(`Index ${spec.name}`, spec.columns, columns)
  const ordered = (column: TColumn, index: number): TColumn | SQL =>
    descending.has(spec.columns[index] ?? '') ? desc(column) : column
  return [ordered(first, 0), ...rest.map((column, index) => ordered(column, index + 1))]
}

export function defineTable(name: string, columns: ColumnSpecs, options: TableOptions = {}): TableDefinition {
  const sqliteColumns: ColumnsOf<sqlite.SQLiteColumn> = {}
  const pgColumns: ColumnsOf<pg.PgColumn> = {}
  const sqliteBuilders: ColumnsOf<SqliteColumnBuilder> = {}
  const pgBuilders: ColumnsOf<PgColumnBuilder> = {}
  for (const [column, spec] of Object.entries(columns)) {
    sqliteBuilders[column] = sqliteColumn(column, spec, () => sqliteColumns)
    pgBuilders[column] = pgColumn(column, spec, () => pgColumns)
  }

  const sqliteTable = sqlite.sqliteTable(name, sqliteBuilders, (table) => {
    const extras: Array<sqlite.PrimaryKeyBuilder | sqlite.IndexBuilder> = []
    if (options.primaryKey) {
      extras.push(sqlite.primaryKey({ columns: columnTuple(`Table ${name}`, options.primaryKey, table) }))
    }
    for (const spec of options.indexes ?? []) {
      const builder = (spec.unique ? sqlite.uniqueIndex(spec.name) : sqlite.index(spec.name))
        .on(...indexColumns(spec, table))
      extras.push(spec.where ? builder.where(sql.raw(spec.where)) : builder)
    }
    return extras
  })
  const pgTable = pg.pgTable(name, pgBuilders, (table) => {
    const extras: Array<pg.PrimaryKeyBuilder | pg.IndexBuilder> = []
    if (options.primaryKey) {
      extras.push(pg.primaryKey({ columns: columnTuple(`Table ${name}`, options.primaryKey, table) }))
    }
    for (const spec of options.indexes ?? []) {
      const builder = (spec.unique ? pg.uniqueIndex(spec.name) : pg.index(spec.name))
        .on(...indexColumns(spec, table))
      extras.push(spec.where ? builder.where(sql.raw(spec.where)) : builder)
    }
    return extras
  })

  // Self references resolve lazily against the built tables' own columns.
  Object.assign(sqliteColumns, getTableColumns(sqliteTable))
  Object.assign(pgColumns, getTableColumns(pgTable))

  return {
    name,
    columns,
    options,
    sqlite: sqliteTable,
    pg: pgTable,
    columnNames: () => Object.keys(columns),
    getSQL: () => sql`${sql.identifier(name)}`,
    shouldOmitSQLParens: () => true,
  }
}
