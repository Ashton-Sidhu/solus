# Database schema and migrations

Solus keeps its data in three schemas. Each one starts from a single baseline.
The baselines replaced every earlier migration on 2026-09-30. A database made
before that date cannot be opened: Solus stops with a message that names the
file to delete.

## The three schemas

| Schema | File | Defined in | Migrated by |
|---|---|---|---|
| Host tables | `solus.db` | `packages/server/src/db/migrations.ts` | `PRAGMA user_version`, one slot per change |
| Ported tables | `solus.db` on SQLite, the `DATABASE_URL` database on Postgres | `defineTable` in each domain's `schema.ts` | drizzle-kit, `packages/server/drizzle/<engine>/` |
| Metrics | `metrics.db` | `packages/server/src/data/insights/migrations.ts` | `PRAGMA user_version`, one slot per change |

- **Host tables** exist on every machine, whatever its engine. They include the
  index of the transcripts on the machine's own disk (`sessions`,
  `session_messages`, `session_fts`), the delivery queues, and host settings.
  They are read synchronously.
- **Ported tables** are the durable, replicated records, such as tasks, works,
  and `session_records`. They are written once in `defineTable` and generated
  for both engines.
- **Metrics** holds this host's spans and log events. Rollover deletes rows
  older than the retention setting and gives the freed pages back to the file
  system.

`sessions` and `session_records` hold similar facts, but they are different
things. `sessions` is this host's local, synchronous index. `session_records`
is the replicated record, and on the Postgres engine it lives in Postgres. Do
not merge them.

## To change a schema

- **Host tables or metrics.** Add a new slot at the end of the migrations
  array. Do not change a released slot.
- **Ported tables.** Change the domain's `schema.ts`, then run
  `bun run db:generate --name <tag>`. Review the generated SQL for both engines.
- **Search.** The search indexes are hand-written SQL at the end of each Drizzle
  baseline. On SQLite this is `works_fts`, with `works_fts_rows` and its
  triggers. On Postgres it is the generated `tsvector` columns. A migration that
  rebuilds `works` on SQLite drops the triggers with the old table, so it must
  create them again.

## Index rules

- Every index has a reader. Before you add an index, name the query that uses
  it. Before you remove a query, remove the indexes that only it used.
- A host owner reads every organization. For that read, `scopeClause` renders
  `1 = 1`, so an index that starts with `organization_id` cannot help. Such
  indexes serve the Solus API, where one organization is always named. A read
  that also runs on a host should seek on a key that comes before the
  organization, as `session_transcripts` does with `(session_id, position,
  organization_id)`.
