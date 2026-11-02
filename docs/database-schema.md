# Database schema and baselines

Solus keeps its data in four schemas. Each one is a single generated baseline
with no migration history (plans/029-fresh-database-baseline.md, decision 1).
A database made by another version of the schema cannot be opened: Solus stops
with a message that names the file to delete, and the file is recreated empty.

## The four schemas

| Schema | File | Declared in | drizzle-kit entry | Generated into |
|---|---|---|---|---|
| Host tables | `solus.db` | `packages/server/src/db/host-tables.ts` | `db/schema/host.ts` | `packages/server/drizzle/host/` |
| Ported records, SQLite | `solus.db` when SQLite is the engine | `defineTable` in each domain's `schema.ts` | `db/schema/sqlite.ts` | `packages/server/drizzle/sqlite/` |
| Ported records, Postgres | the `DATABASE_URL` database | the same `defineTable` declarations | `db/schema/postgres.ts` | `packages/server/drizzle/postgres/` |
| Metrics | `metrics.db` | `packages/server/src/data/insights/metrics-schema.ts` | `db/schema/metrics.ts` | `packages/server/drizzle/metrics/` |

- **Host tables** exist on every machine, whatever its records engine: the
  index of the transcripts on the machine's own disk (`transcript_index`,
  `session_messages`, `session_fts`), the execution ledger, the delivery
  queues, and host-local settings. They are read synchronously through
  `getDb()`.
- **Ported records** are the durable, replicated records, such as tasks, works,
  and `session`. They are written once in `defineTable` and generated
  for both engines; a read goes through `getDatabase()`.
- **Metrics** holds this host's spans and log events. Rollover deletes rows
  older than the retention setting and gives the freed pages back to the file
  system.

## The session row

One `session` row holds everything that was `session_records`,
`session_states`, `session_leads`, and `session_admissions`
(plans/029-fresh-database-baseline.md §4.2). The row is the session's birth: a
turn's admission or a claim makes it with its owner (`created_by`, never
changed) and organization (`local` until assigned once) before the provider
starts; `started_at` is set by the first report of provider facts and never
moves. Every list read adds `started_at IS NOT NULL`, so a row only an
admission made is not shown. The two invariants `defineTable` cannot declare
as CHECKs are kept by the write commands: `started_at IS NULL OR (provider IS
NOT NULL AND project_path IS NOT NULL)` and `(settled_at IS NULL) =
(settled_by IS NULL)`.

A person's own view of a session or a task — settle, archive, snooze, and the
read boundary `viewed_at` — is a `resource_preferences` row keyed by
`(organization_id, resource_kind, resource_id, created_by)`, where
`created_by` is the person whose preference it is. The parent is polymorphic,
so a session or task delete removes its rows explicitly; the session's other
children (`session_links`, `session_pull_requests`,
`session_pull_request_watches`) cascade from the row, and the host tables that
name a session (`runs`, `run_queue`, `run_exchanges`, `async_questions`,
`transcript_mirror_rows`, `activity_mirror_rows`) are deleted by
`deleteSessionRecord`, because a host table cannot reference a ported one.

`transcript_index` and `session` hold similar facts, but they are different
things. `transcript_index` is this host's local, synchronous index of provider
threads (one session has several after a handoff): the indexer's state, the
per-thread facts (provider, model, folder), and the copies of `custom_title`
and `branch` the host's synchronous readers (`getIndexedSession`, the
transcript search, the task and PR readers) project from. `session` is the
replicated record, and on the Postgres engine it lives in Postgres. The two
are not merged (plan 029 §4.2: the index is keyed by provider thread).

## How a baseline is applied

`runSqliteSchemaMigrations(db, schema, fileName)` (`db/sqlite-migrations.ts`)
applies one schema's folder to an open SQLite connection, synchronously, the
moment the file is opened: the host schema and, when SQLite is the engine, the
ported schema on `solus.db`; the metrics schema on `metrics.db`. Each schema
keeps its own bookkeeping table (`__drizzle_migrations` for the ported records,
`__drizzle_migrations_<schema>` for the others), because the host and ported
schemas share one file. Postgres uses Drizzle's own migrator on the `postgres`
folder (`db/database.ts`).

A file is refused when its `user_version` is not zero (a file from before the
baselines, which numbered its hand-written slots there) or when its
bookkeeping table holds a hash this folder does not know.

## To change a schema

1. Change the declaration: a domain's `schema.ts`, `db/host-tables.ts`, or
   `data/insights/metrics-schema.ts`. A new table is also exported from the
   schema's drizzle-kit entry module (drizzle-kit reads named exports only).
2. Run `bun run db:generate`. The script empties every `drizzle/<schema>`
   folder, lets drizzle-kit write `0000_baseline` from the entry module, and
   appends that schema's hand-written SQL from
   `packages/server/src/db/schema/custom/<schema>.sql`.
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
