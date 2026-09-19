# Cloud service model — P0: engine, `Db`, and the ported domains

Solus runs the same server binary on a laptop and in the cloud. A host keeps
SQLite in its data directory with no configuration; the cloud runs one
Postgres for every instance. The domain managers are the same code on both.
P0 lays the storage layer and ports the collaboration-plane domains — tasks,
works, plans, sharing, and session records — as the pattern every later
domain follows.

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
- **organization** — the scope every ported row belongs to. A host's database
  holds one organization, `local`; the cloud's Postgres holds many, one per
  organization the control plane knows.
- **cloud-owned** — a record whose home is the cloud Postgres (a task in a
  cloud organization). **runner-owned** — a record whose home is one machine
  (a session transcript, a worktree). **mirror / mirrored** — a copy of a
  runner-owned record kept where the collaboration plane can read it: a
  session record is the mirror of a transcript (§12).

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
automation titles) and `db/session-indexer.ts` (the transcript index beside
the session records, §12).

## 6. Organization scoping

Every ported store function takes an explicit `organizationId` as its first
argument and scopes every read and write by it: a row of another organization
is not found, not refused. Inserts stamp `organization_id`; reads keyed by
anything other than a task or work id already checked against the
organization (a session id, a link target, a listing) filter on it. A child
row keyed by a verified parent id (a task's comments, a work's revisions)
follows its parent.

`organizationOf(principal)` in `server/principal.ts` decides the value:

- `local-owner`, `remote-owner`, `system`, `guest` → `local`.
- `org-member` on a `personal` or `managed` host → `local`. A host's database
  is one organization's own; the member's grant names the organization the
  host belongs to, and every row the host itself writes (an agent tool, an
  automation, the indexer) is `local`. Mapping members to their grant there
  would hide the host's own rows from them.
- `org-member` on a `cloud` host → the grant's organization: one database
  serves many organizations, and the grant is the only thing that tells them
  apart.

Handlers pass `organizationOf(ctx.principal)`. Code that acts for the host —
the control plane, agent tools, the indexer, outbox appliers, PR discovery —
passes `LOCAL_ORGANIZATION_ID`: the runner's records are its own.

Two rows stay unscoped on purpose. `task_counters` hands out `short_id`, which
is unique across the whole database, so a short id names one task wherever it
is read; `asset_publications` is keyed by the content digest and the provider
target, and the same bytes are the same upload for anyone.

## 7. The tasks port (the pattern)

Tables in `packages/server/src/tasks/schema.ts`: `tasks`, `task_counters`,
`task_session_links`, `task_comments`, `task_links`, `task_events`,
`task_external_links`, `upstream_task_cache`, `asset_publications`; each with
`organization_id TEXT NOT NULL DEFAULT 'local'`. `task_cache` was dropped by an
earlier migration and nothing reads it, so it was not carried over.
`task_counters` is new: `short_id` is handed out by one atomic upsert, because
`MAX(short_id) + 1` inside a transaction is racy on Postgres.

Every store function in the tasks folder is `async` over `Db`; in-transaction
cores take the transaction as their first argument; public writes open one
with `database().transaction(...)`. `Task` instances carry their organization
in a private field, so the record that crosses RPC never does. Callers `await`
them (task handlers, the control plane, presence, PR discovery and
reconciliation, session tools). The sync engine's background poll walks every
organization's external links (`listExternalLinksForPoll`) and syncs each
task under its own organization.

The hand-written SQLite migrations keep their slots (`PRAGMA user_version` is
an index into them); slots that created or changed ported tables are reserved
`SELECT 1;` entries. The generated SQLite migrations use `IF NOT EXISTS`, so a
developer's existing `solus.db`, which already holds these tables in their
last hand-made shape, opens unchanged; `runSqliteSchemaMigrations` then adds
every declared column the hand-made table lacks (`organization_id` first
among them, with its default), so every ported query can name every declared
column. A share table made before tasks could be shared carries a `CHECK`
SQLite cannot widen; it is set aside, recreated by the generated migration,
and its rows copied back.

## 8. Porting the next domain

1. Declare the tables with `defineTable` in `<domain>/schema.ts`, add
   `organization_id`, and list them in `db/schema/index.ts`, `sqlite.ts`, and
   `postgres.ts`.
2. `bun run db:generate --name <domain>` writes both migrations and patches
   the SQLite one to `IF NOT EXISTS`. Engine-specific DDL (an index type one
   engine has) goes in a custom migration: `bunx drizzle-kit generate --custom
   --name <tag> --config drizzle.<engine>.config.ts` in `packages/server`.
3. Replace the hand-written DDL for those tables in `db/migrations.ts` with
   reserved slots; keep every other slot.
4. Rewrite the domain's queries as `sql` templates over `Db` in the portable
   subset; make each function `async` and give it `organizationId`; ripple
   `await` to callers.
5. Move any JOIN to an unported table into a separate `getDb()` read.
6. Reset per test with `tests/unit/helpers/test-db.ts` (`resetTestDatabase`)
   and seed ported tables through `getDatabase().run(...)`, not `getDb()`.

## 9. The works port

Tables in `packages/server/src/folio/schema.ts`: `works`, `work_revisions`,
`work_annotations`. **Every work is a database row (decision D3).** The
repository-file storage (`kind: 'project'` works under `<repo>/.solus/works`,
`works-manifest.json`, `promoteWorkToProject`) is gone: the contract has no
`WorkStorage`, `WorksManifest`, or `WorkMeta.storage`, the RPCs that took a
`cwd` locator no longer do, and the client has no storage-kind control. In
its place one execution-plane RPC, `worksExport({ workId, path })`, writes a
work's stored content to a path on the host that runs the call — Markdown for
a document, JSON for a diagram or slides, HTML for an artifact — and the
work's overflow menu offers it as "Export…" beside "Save as", on desktop, web,
and mobile. The `storage` column stays declared (`'local'`, with a default)
because a hand-made `works` table declares it `NOT NULL` with no default.

Full-text search is behind `SearchIndex` in `db/search-index.ts`, chosen by
engine: on SQLite the `works_fts` FTS5 table keyed by `work_id` and kept in
step by triggers on `works` (the `works_search` custom migration; a host that
already had them keeps them); on Postgres a stored `tsvector` column on
`works`, title at weight A and content at weight B, under a GIN index, queried
with `websearch_to_tsquery`. `folio/work-search.ts` asks the index and formats
one hit shape. Agent tools (`work-tools`, `artifact-tools`, `doc-tools`,
`comment-tools`), the outbox applier, and the automation prompt composer read
works through the organization; a referenced work in an automation prompt is
named by the id `read_work` takes, not a file path.

## 10. The plans port

Tables in `packages/server/src/plans/schema.ts`: `plan_annotations` (the review
state a person owns: status, title, bookmark, comments, the mirrored doc link),
`indexed_plans` and `plan_index_providers` (the query model the provider
transcript readers keep in step). `plans/annotations.ts` and
`plans/plan-index.ts` are `async` over `Db` with `organizationId`; the Claude
and Codex backends, the indexer, the control plane's live plan index, the
history handlers, and the review tools await them. `plan_index_providers` is
keyed by provider alone: which providers a runner has indexed in full is that
runner's fact.

## 11. The sharing port

Tables in `packages/server/src/sharing/schema.ts`: `resource_owner` and
`share_grant`, both with `organization_id`. `ShareManager` takes a `Db`, every
method is `async`, and each derives the organization from the principal it is
given (`forget` and `ownerOf` take it explicitly; `resolveLinkSecret` looks a
hash up across the database, since a secret is unique). The semantics are the
ones docs/plans/multiplayer-sharing.md §3.4 states: organization members are
editors on every resource of a managed host, the owner alone transfers or
deletes, a guest link is scoped to one resource.

Because `roleFor` is a read now, everything above it is asynchronous:
`assertRpcAccess` and `SolusServer.handle` await the access check;
`eventVisibleTo` awaits the role; `ClientEventRegistry.deliver` returns a
promise and hands events to one client in publish order (a per-client queue,
so a slower audience check never lets a later event overtake);
`HostEventPublisher.publish`/`broadcast` resolve to the delivered count; the
list filters (`filterVisible`) and ownership claims are awaited by their
handlers; the session listing's streamed batches are filtered one after
another. `tasks/task-sharing.ts` answers what a task's share reaches from the
ported tables on either engine. The host's guest paths are unchanged (P4).

## 12. Session records

`packages/server/src/sessions/schema.ts` declares `session_records`: one row per
session with `session_id` (PK), `organization_id`, `owner_user_id`,
`provider`, `project_path`, `project_remote`, `runner_host_id`, `title`,
`custom_title`, `status` (`idle` | `running` | `interrupted`), `model`,
`reasoning_effort`, `parent_session_id`, `root_session_id`, `created_at`,
`last_activity_at`, `size`. `project_path` is the provider's project folder
key, the same spelling the transcript index uses, so the picker's filters are
unchanged. `sessions/session-records.ts` is the store: `upsertSessionRecord`
merges a report into the row (a field left out keeps the stored value; a
field given as null clears it; activity never runs backwards),
`listSessionRecords` keeps the picker's filters (provider, project path,
worktrees beneath it, limit), `setSessionRecordStatus`,
`setSessionRecordTitle`, `deleteSessionRecord`, and
`markOwnRunningSessionRecordsInterrupted` for boot.

On a host the records are fed in-process: the transcript indexer upserts one
per swept Claude file and per cached Codex thread, `persistIndexedSessionStart`
reports a start as `running`, `persistRemoteSessionStart` records the runner a
dispatched session ran on, `setSessionCustomTitle` lands the name on the
record, the control plane's status changes map to `running`/`idle`/
`interrupted`, and a session the file no longer lists loses its record. At
boot the host marks every record it left `running` as `interrupted`; a record
another runner reported is that runner's to settle.

The picker and history list (`listIndexedSessions`,
`listIndexedCodexSessions`, and so the `listSessions` handler behind the
session sidebar) read `session_records` for which sessions and in what order,
then fill in what only the transcript index on this machine knows — the
working directory, the slug, the branch, the lineage — with one separate
`getDb()` read. A record whose transcript this machine does not hold still
lists, with what the record carries.

Two collaboration RPCs: `sessionRecordList(filter)` for members and owners,
and `sessionRecordUpsert(record)`, the `system-only` access class: the host
itself today, and a runner of the same organization once the uplink's runner
principal claim exists (the one-line hook is in `assertRpcAccess`).

## 13. What stays runner-local

The transcript index — `sessions`, `session_messages`, `session_fts`,
`session_files`, the lineage and thread-alias tables — stays in the host's
SQLite file on `getDb()` on either engine; transcripts are P2. Pinned
sessions, saved prompts, session read state (`viewed_at`), automations,
projects, project config, the outbox, browser profiles, seats, and the turn
ledger are runner-local for now. Where a ported domain shows a fact from one
of these (a session's title beside a task link, an automation's name on a
link), it reads it in a separate `getDb()` statement.

## 14. Running tests on both engines

```sh
bun scripts/test-unit.ts <filters>                          # SQLite, the default
docker run -d -e POSTGRES_PASSWORD=solus -p 54332:5432 postgres:17
POSTGRES_ADMIN_URL=postgres://postgres:solus@localhost:54332/postgres \
  bun scripts/test-unit.ts --engine=postgres <filters>       # one database per file
```

With `--engine=postgres` the runner creates a database per test file, passes
`SOLUS_DB=postgres DATABASE_URL=<that db>` to the child, and drops it after.
Suites that read the SQLite file itself (`sqlite_master`) skip on Postgres.
