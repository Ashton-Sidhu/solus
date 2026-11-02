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

## Operation receipts

`operation_receipts` is the one ported table for a write that must happen once
(plans/029-fresh-database-baseline.md §3.6). A row claims `(scope, namespace,
key)` before the write it protects, in the same `Db` transaction, so the two
commit or roll back together, and a concurrent claimer of the same identity
waits on the primary key for that outcome. The receipt lives in the records
engine with the records it protects; no host-file guard sits beside a records
write. The namespaces and their policies are declared in
`packages/server/src/data/receipts/operation-receipts.ts`; a caller never
supplies a TTL.

| Namespace | Scope | Key | Expiry | Duplicate |
|---|---|---|---|---|
| `api-create-task`, `api-create-work`, `api-create-comment` | the request authority | the retry key | 24 hours | same fingerprint: the stored result id, read again under current authorization; another fingerprint is a 409 |
| `applied-operation` | `courier-owner` | the outbox op id | none | the op is applied; the applier does not run |
| `webhook-delivery`, `webhook-replay` | the webhook id | the proven delivery id, the rendered replay key | 25 hours, 7 days | a duplicate delivery; an expired key is taken again |

A row whose expiry has passed is replaced by the next claim of its identity. The
hourly sweep (`sweepExpiredReceipts`) deletes at most 1000 expired rows a call,
oldest expiry first, through the partial index `operation_receipts_expiry`; a
row with no expiry is never swept. A webhook's receipts are deleted with it, by
scope.

## Index rules

- Every index has a reader. Before you add an index, name the query that uses
  it. Before you remove a query, remove the indexes that only it used.
- A host owner reads every organization. For that read, `scopeClause` renders
  `1 = 1`, so an index that starts with `organization_id` cannot help. Such
  indexes serve the Solus API, where one organization is always named. A read
  that also runs on a host should seek on a key that comes before the
  organization, as `session_transcripts` does with `(session_id, position,
  organization_id)`.
