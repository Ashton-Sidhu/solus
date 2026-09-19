# Cloud service model — P0 slice 1: engine, `Db`, and the tasks port

Solus runs the same server binary on a laptop and in the cloud. A host keeps
SQLite in its data directory with no configuration; the cloud runs one
Postgres for every instance. The domain managers are the same code on both.
This slice lays the storage layer and ports one domain, tasks, as the pattern
every later domain follows.

## 1. Vocabulary

- **engine** — the database a process opens at boot: `sqlite` or `postgres`.
  Chosen once by `resolveEngine()`; never per query.
- **plane** — which half of the product an RPC method belongs to.
  `collaboration` is the records people share and read together (tasks, works,
  comments, shares, presence, session records and history, pull-request
  records, automation definitions, notifications, seat status, host identity
  and settings). `execution` needs a checkout or an agent process (prompting,
  permissions, git, files, diffs, worktrees, project config, checkout-bound
  review, setup, seat connection, the machine's own window, updates, browser).
  Every method has exactly one plane: `packages/contracts/src/rpc-planes.ts`.
- **role** — a plane a process serves. `SOLUS_ROLES` is a comma list; unset
  means both. A method outside the served planes is refused with
  `{ code: 'PLANE_DISABLED' }` on the wire. The host calling itself
  (capability probes) is not gated.
- **workspace service** — a cloud process with the `collaboration` role: the
  place clients connect first, backed by Postgres.
- **runner** — a process with the `execution` role: a machine with checkouts
  and agent processes. A laptop is a workspace service and a runner at once.
- **cloud-owned** — a record whose home is the cloud Postgres (a task in a
  cloud organization). **runner-owned** — a record whose home is one machine
  (a session transcript, a worktree). **mirror / mirrored** — a copy of a
  runner-owned record kept where the collaboration plane can read it (a
  session's title and provider beside a task link). Mirrors are a later
  slice; this one names them so ports do not invent synonyms.

## 2. The engine rule

`packages/server/src/db/engine.ts`:

1. `SOLUS_DB=sqlite|postgres` wins when set. `postgres` needs `DATABASE_URL`.
2. Otherwise `DATABASE_URL` set means Postgres.
3. Otherwise SQLite at `<SOLUS_DATA_DIR or ~/.solus>/solus.db`.

No environment is SQLite. The desktop app sets nothing and stays on SQLite.

## 3. The `Db` handle

`packages/server/src/db/database.ts` — `getDatabase(): Db`, `closeDatabase()`.

```ts
interface Db {
  engine: 'sqlite' | 'postgres'
  all<T>(q: SQL): Promise<T[]>
  get<T>(q: SQL): Promise<T | undefined>
  run(q: SQL): Promise<{ changes: number }>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}
```

- A query is a Drizzle `sql` template that names schema tables:
  `` sql`SELECT * FROM ${tasks} WHERE id = ${id}` ``. The handle renders it
  for the engine and binds the values. Rows come back as plain objects keyed
  by column name; the domain parses them with its zod row schema.
- SQLite runs through Drizzle's `sqlite-proxy` driver on the existing
  `node:sqlite` connection from `getDb()`: legacy tables and ported tables
  share one file and one connection. Postgres runs through `postgres-js`;
  `bigint` columns are parsed to JS numbers.
- Transactions: `BEGIN IMMEDIATE`/`COMMIT` on SQLite (queued, so two async
  bodies never interleave their `BEGIN`s on the one connection); a real
  transaction on Postgres. The body receives the transaction as its `Db`. The
  active transaction also rides the async context (`AsyncLocalStorage`): a
  call that reaches `getDatabase()` from inside a body joins the transaction,
  and a nested `transaction()` reuses the outer one. Legacy `withTx()` inside
  an open async transaction joins it too.
- Migrations run at open. SQLite: `getDb()` applies the generated migrations
  synchronously right after the hand-written ones, with the same
  `__drizzle_migrations` bookkeeping the Drizzle migrator uses, so no
  synchronous caller ever sees half a schema. Postgres: the `postgres-js`
  migrator runs on first use and every operation awaits it.
- `getDb()` and `withTx()` stay for the domains not yet ported.

## 4. The column-list builder

`packages/server/src/db/schema/define-table.ts` — `defineTable(name, columns,
options)` declares a table once and emits both a `sqlite-core` and a
`pg-core` table for drizzle-kit. A definition renders as its quoted table
name inside a `sql` template.

| spec      | SQLite    | Postgres  | read as        |
|-----------|-----------|-----------|----------------|
| `text`    | TEXT      | text      | string         |
| `integer` | INTEGER   | integer   | number         |
| `bigint`  | INTEGER   | bigint    | number (ms)    |
| `boolean` | INTEGER   | boolean   | 0/1 or boolean |
| `json`    | TEXT      | text      | string         |

Columns take `notNull`, `primaryKey`, `unique`, `default`, and `references`
(`{ table, column, onDelete }`, `'self'` for a self reference). Options take a
composite `primaryKey` and `indexes` (`columns`, `descending`, `unique`,
`where`). Timestamps are `bigint` milliseconds. A domain that keeps a 0/1
flag as `integer` reads the same value on both engines; `boolean` differs per
engine and the domain must normalize.

## 5. The portable SQL subset

Write only what both engines run unchanged:

- `INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…`, and
  `ON CONFLICT DO NOTHING` (never `INSERT OR IGNORE` / `OR REPLACE`).
- `RETURNING`.
- `IN (…)` with a bound list (`sql.join`), never an empty list.
- `COALESCE`, `CASE WHEN`, `TRIM`, `LOWER`, `MIN`/`MAX` as aggregates, `LIMIT`.
- Integer timestamps compared as numbers; no date functions.
- `LOWER(a) = LOWER(b)` instead of `COLLATE NOCASE`; a `CASE` instead of
  scalar `MIN(a, b)`; a JS test instead of `GLOB`/regex; no `rowid`; no
  `AUTOINCREMENT`; no Postgres arrays.
- Unqualified column names in text (`tasks.id`) beside `${tasks}` in `FROM`
  and `JOIN`: both engines fold the quoted and unquoted spellings the same way.

A read that needs a table from a domain not yet ported is a separate
statement on `getDb()`, never a JOIN from a ported query — see
`packages/server/src/tasks/host-records.ts` (session titles and providers,
work, automation, and plan titles).

## 6. The tasks port (the pattern)

Tables in `packages/server/src/tasks/schema.ts`: `tasks`, `task_counters`,
`task_session_links`, `task_comments`, `task_links`, `task_events`,
`task_external_links`, `upstream_task_cache`, `asset_publications`; each with
`organization_id TEXT NOT NULL DEFAULT 'local'`. `task_cache` was dropped by an
earlier migration and nothing reads it, so it was not carried over.
`task_counters` is new: `short_id` is handed out by one atomic upsert, because
`MAX(short_id) + 1` inside a transaction is racy on Postgres.

Every store function in the tasks folder is `async` over `Db`; in-transaction
cores take the transaction as their first argument; public writes open one
with `database().transaction(...)`. Callers `await` them (task handlers, the
control plane, presence — `hostSnapshot()` is now async because a roster row
names the session's task — PR discovery and reconciliation, session tools).

`task-sharing.ts` is the one exception: `ShareManager.roleFor` is synchronous
and runs inside every RPC's access check, so those two reads stay on the
SQLite connection. On Postgres they return nothing until the sharing domain is
ported, so a task's share reaches only its own page there.

The hand-written SQLite migrations keep their slots (`PRAGMA user_version` is
an index into them); slots that created or changed task tables are reserved
`SELECT 1;` entries. The generated SQLite migration uses `IF NOT EXISTS`, so a
developer's existing `solus.db`, which already holds these tables in their
last hand-made shape, opens unchanged; it simply lacks `organization_id`,
which no query names yet.

## 7. Porting the next domain

1. Declare the tables with `defineTable` in `<domain>/schema.ts`, add
   `organization_id`, and list them in `db/schema/index.ts`, `sqlite.ts`, and
   `postgres.ts`.
2. `bun run db:generate --name <domain>` writes both migrations and patches
   the SQLite one to `IF NOT EXISTS`.
3. Replace the hand-written DDL for those tables in `db/migrations.ts` with
   reserved slots; keep every other slot.
4. Rewrite the domain's queries as `sql` templates over `Db` in the portable
   subset; make each function `async`; ripple `await` to callers.
5. Move any JOIN to an unported table into a separate `getDb()` read.
6. Reset per test with `tests/unit/helpers/test-db.ts` (`resetTestDatabase`)
   and seed ported tables through `getDatabase().run(...)`, not `getDb()`.

## 8. Running tests on both engines

```sh
bun scripts/test-unit.ts <filters>                          # SQLite, the default
docker run -d -e POSTGRES_PASSWORD=solus -p 54329:5432 postgres:17
POSTGRES_ADMIN_URL=postgres://postgres:solus@localhost:54329/postgres \
  bun scripts/test-unit.ts --engine=postgres <filters>       # one database per file
```

With `--engine=postgres` the runner creates a database per test file, passes
`SOLUS_DB=postgres DATABASE_URL=<that db>` to the child, and drops it after.
Suites that read the SQLite file itself (`sqlite_master`) skip on Postgres.
