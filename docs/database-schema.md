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
  index of the transcripts on the machine's own disk (`transcript_index`,
  `session_messages`, `session_fts`), the execution ledger, the delivery
  queues, and host-local settings. They are read synchronously through
  `getDb()`.
- **Ported records** are the durable, replicated records, such as works and
  `session`, and the host's task cache. They are written once in `defineTable` and generated
  for both engines; a read goes through `getDatabase()`.
- **Metrics** holds this host's spans and log events. Rollover deletes rows
  older than the retention setting and gives the freed pages back to the file
  system. A span's long texts (a turn's prompt, system prompt, and response; a
  thought) are rows of `span_texts`, so an aggregate over `spans` never reads
  a body; a turn root's timing measures (`provider_wait_ms`, `thinking_time_ms`,
  the per-kind sums) are columns written when the root ends, and the `turns`
  view selects them (plans/029 §6).

## The session row

One `session_records` row holds everything that was `session_records`,
`session_states`, `session_leads`, and `session_admissions`
(plans/029-fresh-database-baseline.md §4.2). The table is not named `session`:
Solus Cloud keeps Better Auth's account tables in the same Postgres schema, and
Better Auth owns `session` (`data-model-baseline.test.ts` guards those names). The row is the session's birth: a
turn's admission or a claim makes it with its owner (`created_by`, never
changed) and organization (`local` until assigned once) before the provider
starts; `started_at` is set by the first report of provider facts and never
moves. Every list read adds `started_at IS NOT NULL`, so a row only an
admission made is not shown. The two invariants `defineTable` cannot declare
as CHECKs are kept by the write commands: `started_at IS NULL OR (provider IS
NOT NULL AND project_path IS NOT NULL)` and `(settled_at IS NULL) =
(settled_by IS NULL)`.

A person's own view of a session or a task — settle, archive, snooze, and the
read boundary `viewed_at` — is a `personal_resource_state` row keyed by
`(organization_id, resource_kind, resource_id, created_by)`, where
`created_by` is the person whose state it is. A task's row is keyed by the
task key and needs no copy of the task. The parent is polymorphic,
so a session delete, or the delete of a draft task, removes its rows explicitly; so are the session's
edges in `resource_links` (its pull requests with their watches, its file and
automation links, its work memberships, and the tasks' edges to it), deleted by
`deleteEdgesOf` in the same transaction; and the host tables that name a
session (`runs`, `run_queue`, `run_exchanges`, `async_questions`,
`transcript_mirror_rows`, `activity_mirror_rows`) are deleted by
`deleteSessionRecord`, because a host table cannot reference a ported one.

## Tasks

GitHub and Jira own every task (docs/plans/provider-owned-tasks.md). The host
keeps a copy, the task cache, and no task of its own. A task id is a task key:
`github:<node id>` or `jira:<cloud id>:<issue id>`. A row of the cache has no
organization and no owner. `packages/server/src/data/tasks/` owns the tables.

| Table | Key | Holds |
|---|---|---|
| `tasks` | `id` (task key) | The copy of one task: its provider fields, `state_name` and `state_category` (the provider's own state), `state_id` (the Jira status id), `category` (`Task.category`), `writable_fields`, `home` (what the adapter needs to write), provider times, `fetched_at`, `detail_fetched_at`, `last_read_at`, `comment_position` |
| `task_sources` | `source_key` | One task source, shared by each project that lists it: `source`, `label`, `columns`, `write_state`, `fetched_at`, `truncated` |
| `task_source_items` | (`source_key`, `task_id`) | Where a source puts a task: `column_id`, `item_id` (the board item), `position` |
| `task_source_access` | (`user_id`, `source_key`) | One person's connection to one source: `checked_at` (their own connection read it), and the `health` and `message` of their last read |

- Only a provider answer writes `tasks`: a read of a source, a read of one
  task, or the answer of a write that the provider took (`task-cache.ts`).
- A read of a source replaces its `task_source_items`. A task that left its
  source and that nothing holds (no other source, no link, no session, no
  snooze, no unsent comment) is deleted from the cache in the same transaction.
  So is each copy that nothing holds and that no provider answer wrote for one
  day, such as a task that only a search found.
- A person sees the tasks of a source only when `task_source_access.checked_at`
  is set for them. `health` is for each person, because it is about their
  connection, not about the source.
- The attachments of a task (`resource_links`, `personal_resource_state`,
  `activity`) key on the task key, have an organization, and need no row in
  `tasks`.

## Apps

An app (docs/plans/apps.md §4.1) is a record on the host that runs it.
`packages/server/src/data/apps/` owns the tables.

| Table | Key | Holds |
|---|---|---|
| `apps` | `id` | One app: `slug` (unique on the host), `name`, `active_version`, `stopped`, `repository` (the name of its git repository), `project`, `webhook_ids` (the webhook record of each webhook it declares) |
| `app_versions` | (`app_id`, `number`) | One immutable version: `source_commit`, `build_commit`, `descriptor` (what the build declares), `state` (`active`, `superseded`, `failed`), `error` |
| `app_schedules` | (`app_id`, `name`) | The state of one schedule the active version declares: `enabled`, `next_run_at`, and how the last run ended |
| `app_calls` | `id` | The call log: `operation`, `caller`, times, `outcome`. Never an input or a result. The newest 2,000 of each app. |

An app's source and builds are in its git repository, its data is in its own
folder, and its secrets are in the host's secret store. A session's link to an
app is an edge of `resource_links` with `target_kind = 'app'`.

## Relationships

One table, `resource_links` (`data/links/schema.ts`), holds every edge from a
task or a session to another record (plans/029-fresh-database-baseline.md
§5.1): a task's sessions (`works-on`, or `reference` for a session it only
mentions), its links to works, plans, pull requests, and automations
(`reference`, `pull-request`, or `output` for an item its working session
made), a session's pull requests (`pull-request`), its works (`member`), and
its files and automations (`reference`). The edge identity is
`(organization_id, source_kind, source_id, target_kind, target_scope,
target_key)`, with one spelling per target kind: a session target has an empty
scope, a repository is lower case. The organization is part of the identity
because a task source id is a task key, which is the provider's: two
organizations on one host can link one target to one task, and each has its own
row. The relation is an attribute of the edge, so a task has one edge to
a session whatever its role, and a claim turns an `output` into a `reference`.

The endpoints are polymorphic, so no foreign key reaches them: every delete of
a work, a session, or a draft task runs `deleteEdgesOf` in its transaction, and
`danglingEdgeCount` (tests) must stay zero. A task end is not counted: an edge
needs no copy of its task on the host. `defineTable` has no CHECK and no
composite foreign key; the commands keep the invariants and the tests encode
them: `keeps_session` is 1 only on an active session→pull-request edge whose
pull request is open or not yet observed; the four watch fields are set or
cleared together, never on a dismissed edge, and every end or update of a watch
names its generation (`watch_id`); a canonical pull request has both
`repository` and `number` or neither.

`pull_request_observations` holds what PR sync last saw of a pull request, once
per organization and source authority (`host`, or `person:<user key>`: the
visibility context of the read, never a token). An edge names the observation
it reads through `authority_key`, `repository`, and `number`, and a new edge
binds to the organization's most recent observation of its pull request.
`recordObservation` writes the observation, resolves raw aliases, and writes
every dependent `keeps_session` bit in one transaction; a title-only change
writes no edge. Two raw aliases of one source that resolve to one pull request
are never silently merged: the second alias is canonicalized only when it agrees
with the first on its title and its pin; otherwise it stays unresolved and is
logged (`resource_link_alias_conflict`), and readers dedupe by canonical key.

Indexes, each with its reader: `resource_links_edge` (unique, the edge
identity), `resource_links_by_source` (the forward read of one source in each
organization), `resource_links_by_target` (the reverse read, key before scope),
`resource_links_working_owner` (one active working task per session),
`resource_links_open_session ON (source_id, organization_id) WHERE
keeps_session = 1` (the session list's candidate query; the join-only
alternative measured 2–11× slower and is rejected), `resource_links_watch`
(the watch generation guard), and `resource_links_by_pull_request` (an
observation's fan-out). A work's origin stays on `works.session_id` and is in
the access union without an edge; its members are edges.

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
| `api-create-work`, `api-create-comment` | the request authority | the retry key | 24 hours | same fingerprint: the stored result id, read again under current authorization; another fingerprint is a 409 |
| `applied-operation` | `courier-owner` | the outbox op id | none | the op is applied; the applier does not run |
| `webhook-delivery`, `webhook-replay` | the webhook id | the proven delivery id, the rendered replay key | 25 hours, 7 days | a duplicate delivery; an expired key is taken again |

A row whose expiry has passed is replaced by the next claim of its identity. The
hourly sweep (`sweepExpiredReceipts`) deletes at most 1000 expired rows a call,
oldest expiry first, through the partial index `operation_receipts_expiry`; a
row with no expiry is never swept. A webhook's receipts are deleted with it, by
scope.

## Comment threads

`comment_threads` is the one table for the comments of a task, a work, and a
plan (plans/029-fresh-database-baseline.md §5.2; the model in
plans/data-model-validation/README.md). One row is one thread, keyed by
`(organization_id, subject_kind, subject_id, subject_part, thread_id)`: the
subject is `task:<task key>`, `work:<work id>`, or `plan:<session id>` with the
plan's tool use id as `subject_part`. The row holds the body, `created_by`, the
`author` attribution (an external comment's upstream author is a name, never a
local user), `source`, task provenance, times, `position`, `version`,
`delivery_state`, the scoped external identity, and the `review` payload
(anchor, replies, read marks, resolution). `packages/server/src/data/comments/`
owns it.

- **Writes are per thread.** A command reads one thread, applies the reducer in
  `@solus/contracts/comment-commands`, and writes the row back `WHERE version =
  ?`; a thread another writer changed is read again and the command reapplied.
  A whole copy of a plan's threads (`savePlanAnnotations`) is reconciled thread
  by thread against the `updatedAt` the copy was read at: a thread the copy
  never saw is not deleted by its absence.
- **Order.** A task's comments read by `(created_at, thread_id)`; a work's and a
  plan's by `position`, allocated by advancing the parent row's
  `comment_position` (`tasks`, `works`, `plan_annotations`) in the inserting
  transaction.
- **Delivery.** Each task comment is a provider comment. A comment the host
  read from GitHub or Jira, or one the provider took from Solus, is `sent`
  with the provider's id (`external_scope` is the task key). A comment the
  provider did not take is `pending`, with the reason in `review.sendError`,
  until it is sent again or discarded. A task's threads are in the
  organization `local`: a task has no organization. A work's or a plan's
  thread is always `private`. A work's external document state is
  `works.external_comments`, guarded by `works.external_comments_version`; a
  refresh that read an older state is refused.
- **Lifetime.** The subject is polymorphic, so nothing cascades: a work's
  delete, the delete of a draft task, and the prune of a task copy that nothing
  holds, delete the threads in the same transaction.
  A work's move keeps them. A plan's threads belong to its `plan_annotations`
  identity, so a rebuild of `indexed_plans` never touches them.

## Person columns

Two columns name a person, and no other column does
(plans/029-fresh-database-baseline.md decision 2; `tests/unit/data-model-identity.test.ts`
checks every table of both baselines).

- `created_by TEXT NOT NULL`: the user id of who made the row, set from the
  verified acting identity (`ownerKeyOf`), never from a client value. Ownership
  never transfers, so it is also the owner: `visibleTo` and `roleOf` read it
  on `works`, `webhooks`, `automations`, `integration`,
  `workspace_projects`, and `browser_profiles`; on `acl_entry` it is who made
  the grant; on `activity` it is the signed-in person the actor acts for (an
  agent's session owner, an automation's creator, else the host's user), with
  `by_kind` naming the actor's kind.
- `user_id`: the person a row is *for*, only where that can differ from the
  creator: `notifications` (the recipient), `activity` (who was mentioned or
  shared with), `delivery_queue` and `runner_delivery_cursors` (whose token
  delivers), `notification_pr_observations`, `integration_connection`, and
  `member_folder`.

Display attribution is JSON and never a person column: `webhooks.author`,
`works.content_author`, `work_revisions.author`, `resource_links.author`,
`activity.by`, `notifications.by`, and `acl_entry.granted_by_name` beside
`created_by`. `resource_links.watch_user_id` is the one other domain reference:
the person a pull request watch acts for.
Internal rows (cursors, mirrors, queues, receipts, caches, derived rows, FTS
tables) carry no creator and reach ownership through their parent; the test
lists them by name.

## Index rules

- Every index has a reader. Before you add an index, name the query that uses
  it. Before you remove a query, remove the indexes that only it used.
- A host owner reads every organization. For that read, `scopeClause` renders
  `1 = 1`, so an index that starts with `organization_id` cannot help. Such
  indexes serve the Solus API, where one organization is always named. A read
  that also runs on a host should seek on a key that comes before the
  organization, as `session_transcripts` does with `(session_id, position,
  organization_id)`.
