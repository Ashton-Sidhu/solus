# Database schema and baselines

Solus keeps its data in three databases. Each one is a single generated
baseline, `0000_baseline.sql`, with no migration history
(plans/029-fresh-database-baseline.md, decision 1).
A database made by another version of the schema cannot be opened: Solus stops
with a message that names the file to delete, and the file is recreated empty.

## The three databases

| Database | Holds | Declared in | drizzle-kit entry | Baseline |
|---|---|---|---|---|
| `solus.db` (SQLite, every host) | the host tables, and the ported records when SQLite is the engine | host tables in `packages/server/src/db/host-tables.ts`; records in each domain's `schema.ts` | `db/schema/sqlite.ts` (re-exports `db/schema/host.ts`) | `packages/server/drizzle/sqlite/0000_baseline.sql` |
| Postgres (`DATABASE_URL`) | the ported records when Postgres is the engine | the same `defineTable` declarations | `db/schema/postgres.ts` | `packages/server/drizzle/postgres/0000_baseline.sql` |
| `metrics.db` (SQLite, every host) | this host's spans and log events | `packages/server/src/data/insights/metrics-schema.ts` | `db/schema/metrics.ts` | `packages/server/drizzle/metrics/0000_baseline.sql` |

On the Postgres engine `solus.db` still carries the record tables, empty:
records are read through `getDatabase()`, which points at Postgres.

- **Host tables** exist on every machine, whatever its records engine: the
  index of the transcripts on the machine's own disk (`sessions`,
  `session_messages`, `session_fts`), the execution ledger, the delivery
  queues, and host-local settings. They are read synchronously through
  `getDb()`.
- **Ported records** are the durable, replicated records, such as tasks, works,
  and `session_records`. They are written once in `defineTable` and generated
  for both engines; a read goes through `getDatabase()`.
- **Metrics** holds this host's spans and log events. Rollover deletes rows
  older than the retention setting and gives the freed pages back to the file
  system.

`sessions` and `session_records` hold similar facts, but they are different
things. `sessions` is this host's local, synchronous index of provider threads
(one session has several after a handoff). `session_records` is the replicated
record, and on the Postgres engine it lives in Postgres. Plan 029 §4 narrows
`sessions` to indexer state; it does not merge the two.

## How a baseline is applied

`runSqliteSchemaMigrations(db, schema, fileName)` (`db/sqlite-migrations.ts`)
applies a database's folder to an open SQLite connection, synchronously, the
moment the file is opened: `sqlite` on `solus.db`, `metrics` on `metrics.db`.
Each file keeps one bookkeeping table, `__drizzle_migrations`. Postgres uses
Drizzle's own migrator on the `postgres` folder (`db/database.ts`).

A file is refused when its `user_version` is not zero (a file from before the
baselines, which numbered its hand-written slots there) or when its
bookkeeping table holds a hash this folder does not know.

## To change a schema

1. Change the declaration: a domain's `schema.ts`, `db/host-tables.ts`, or
   `data/insights/metrics-schema.ts`. A new table is also exported from the
   database's drizzle-kit entry module (drizzle-kit reads named exports only).
2. Run `bun run db:generate`. The script empties every `drizzle/<database>`
   folder, lets drizzle-kit write `0000_baseline` from the entry module, and
   appends that database's hand-written SQL from
   `packages/server/src/db/schema/custom/<database>.sql`.
3. Review the generated SQL. For the ported records, review both engines.

Hand-written SQL is for what `defineTable` cannot say: FTS5 virtual tables and
their triggers on SQLite (`session_fts`, `works_fts` with `works_fts_rows`,
`session_transcripts_fts`), and the generated `tsvector` columns with their GIN
indexes on Postgres.

There is no additive migration. While the product has no deployed data this is
the whole story; when it does, the first additive migration is a new decision
and a new section here.

## Index rules

- Every index has a reader. Before you add an index, name the query that uses
  it. Before you remove a query, remove the indexes that only it used.
- A host owner reads every organization. For that read, `scopeClause` renders
  `1 = 1`, so an index that starts with `organization_id` cannot help. Such
  indexes serve the Solus API, where one organization is always named. A read
  that also runs on a host should seek on a key that comes before the
  organization, as `session_transcripts` does with `(session_id, position,
  organization_id)`.
