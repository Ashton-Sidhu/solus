import { AsyncLocalStorage } from 'node:async_hooks'
import type { SQLInputValue } from 'node:sqlite'
import type { SQL } from 'drizzle-orm'
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { drizzle as drizzleSqliteProxy, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import postgres from 'postgres'
import { getDb, withAsyncTx } from '.'
import { resolveEngine, type DatabaseEngine } from './engine'
import { migrationsFolder } from './migration-files'

/**
 * The one database handle a ported domain uses (docs/plans/cloud-service-model.md).
 *
 * A query is a `sql` template naming the domain's schema tables; the handle
 * renders it for the engine chosen at boot and runs it. SQLite runs on the
 * host's existing connection through Drizzle's proxy driver, so legacy tables
 * and ported tables share one file and one connection; Postgres runs through
 * postgres-js. Both are async, so a domain written against `Db` is the same
 * code on a laptop and in the cloud.
 *
 * A transaction body receives the transaction as its `Db`, and the active
 * transaction is also carried on the async context: a call that reaches
 * `getDatabase()` from inside a body joins the open transaction instead of
 * running beside it, and a nested `transaction()` reuses the outer one.
 */
export interface Db {
  readonly engine: DatabaseEngine['kind']
  all<T>(query: SQL): Promise<T[]>
  get<T>(query: SQL): Promise<T | undefined>
  run(query: SQL): Promise<{ changes: number }>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

interface RootDb extends Db {
  close(): Promise<void>
}

const activeTransaction = new AsyncLocalStorage<Db>()

/** postgres-js sends `undefined` as an error and SQLite refuses it; every absent value is NULL. */
function nullForUndefined(params: unknown[]): SQLInputValue[] {
  // SAFETY: Drizzle binds the primitives a `sql` template carries; SQLite accepts each of them.
  return params.map((value) => (value === undefined ? null : value)) as SQLInputValue[]
}

// --- SQLite -----------------------------------------------------------------

class SqliteDb implements RootDb {
  readonly engine = 'sqlite' as const
  private readonly drizzle: SqliteRemoteDatabase

  constructor() {
    this.drizzle = drizzleSqliteProxy(async (query, params, method) => {
      const statement = getDb().prepare(query)
      const bound = nullForUndefined(params)
      switch (method) {
        case 'run': {
          const result = statement.run(...bound)
          return { rows: [Number(result.changes)] }
        }
        // `get` is never issued: this handle reads one row through `all` (see `SqliteDb.get`).
        case 'get':
        case 'all':
          return { rows: statement.all(...bound) }
        case 'values':
          return { rows: statement.all(...bound).map((row) => Object.values(row)) }
      }
    })
  }

  all<T>(query: SQL): Promise<T[]> {
    return activeTransaction.getStore()?.all<T>(query) ?? this.drizzle.all<T>(query)
  }

  async get<T>(query: SQL): Promise<T | undefined> {
    return (await this.all<T>(query))[0]
  }

  async run(query: SQL): Promise<{ changes: number }> {
    const tx = activeTransaction.getStore()
    if (tx) return tx.run(query)
    const result = await this.drizzle.run(query)
    return { changes: Number(result.rows?.[0] ?? 0) }
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const open = activeTransaction.getStore()
    if (open) return fn(open)
    const tx = new SqliteTransaction(this.drizzle)
    return withAsyncTx(() => activeTransaction.run(tx, () => fn(tx)))
  }

  async close(): Promise<void> {
    // The file belongs to `getDb()`; `closeDb()` closes it.
  }
}

class SqliteTransaction implements Db {
  readonly engine = 'sqlite' as const

  constructor(private readonly drizzle: SqliteRemoteDatabase) {}

  all<T>(query: SQL): Promise<T[]> {
    return this.drizzle.all<T>(query)
  }

  async get<T>(query: SQL): Promise<T | undefined> {
    return (await this.all<T>(query))[0]
  }

  async run(query: SQL): Promise<{ changes: number }> {
    const result = await this.drizzle.run(query)
    return { changes: Number(result.rows?.[0] ?? 0) }
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

// --- Postgres ---------------------------------------------------------------

type PgExecutor = Pick<PostgresJsDatabase, 'execute'>

class PostgresTransaction implements Db {
  readonly engine = 'postgres' as const

  constructor(private readonly executor: PgExecutor) {}

  async all<T>(query: SQL): Promise<T[]> {
    const result = await this.executor.execute(query)
    // SAFETY: the caller's row schema validates the shape; the driver returns plain objects.
    return [...result] as T[]
  }

  async get<T>(query: SQL): Promise<T | undefined> {
    const rows = await this.all<T>(query)
    return rows[0]
  }

  async run(query: SQL): Promise<{ changes: number }> {
    const result = await this.executor.execute(query)
    return { changes: result.count }
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

class PostgresDb implements RootDb {
  readonly engine = 'postgres' as const
  private readonly client: ReturnType<typeof postgres>
  private readonly drizzle: PostgresJsDatabase
  private readonly root: PostgresTransaction
  private readonly ready: Promise<void>

  constructor(url: string) {
    this.client = postgres(url, {
      max: 8,
      onnotice: () => {},
      // Every timestamp is a bigint of milliseconds; a JS number holds it exactly.
      types: { bigint: { to: 20, from: [20], serialize: (value: number) => String(value), parse: Number } },
    })
    this.drizzle = drizzlePostgres(this.client)
    this.root = new PostgresTransaction(this.drizzle)
    this.ready = migratePostgres(this.drizzle, { migrationsFolder: migrationsFolder('postgres') })
  }

  private async executor(): Promise<Db> {
    await this.ready
    return activeTransaction.getStore() ?? this.root
  }

  async all<T>(query: SQL): Promise<T[]> {
    return (await this.executor()).all<T>(query)
  }

  async get<T>(query: SQL): Promise<T | undefined> {
    return (await this.executor()).get<T>(query)
  }

  async run(query: SQL): Promise<{ changes: number }> {
    return (await this.executor()).run(query)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await this.ready
    const open = activeTransaction.getStore()
    if (open) return fn(open)
    return this.drizzle.transaction((drizzleTx) => {
      const tx = new PostgresTransaction(drizzleTx)
      return activeTransaction.run(tx, () => fn(tx))
    })
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined)
    await this.client.end()
  }
}

// --- The singleton ----------------------------------------------------------

let database: RootDb | null = null

/** The process's database, opened on first use for the engine `resolveEngine()` chose. */
export function getDatabase(): Db {
  if (database) return database
  const engine = resolveEngine()
  database = engine.kind === 'postgres' ? new PostgresDb(engine.url) : new SqliteDb()
  return database
}

export async function closeDatabase(): Promise<void> {
  if (!database) return
  const open = database
  database = null
  await open.close()
}
