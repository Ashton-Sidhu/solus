# Cloud service model — P0: engine, `Db`, and the ported domains; P1: the cloud workspace; P2: sessions and the mirror; P3: the credential vault

Solus runs the same server binary on a laptop and in the cloud. A host keeps
SQLite in its data directory with no configuration; the cloud runs one
Postgres for every instance. The domain managers are the same code on both.
P0 lays the storage layer and ports the collaboration-plane domains — tasks,
works, plans, sharing, and session records — as the pattern every later
domain follows. P1 (§15–§17) boots that binary as an organization's workspace
service and teaches a linked host to write to it. P2 (§18–§19) mirrors
transcripts and insights to the service; a prompt still goes to the host that
runs the session. P3 (§20) moves provider credentials into a vault every
runner leases.

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

## 15. Workspace mode (P1)

`packages/server/src/server/workspace-mode.ts`. `SOLUS_WORKSPACE=1` boots the
server as the **workspace service**: the cloud process every client of an
organization connects to first. Read once from the environment at boot,
before anything else (`applyWorkspaceMode`), and refused when incomplete:
`SOLUS_CLOUD_ISSUER` and `SOLUS_CLOUD_JWKS_URL` name the one issuer whose
grants are admitted, and `DATABASE_URL` is required — one Postgres for every
organization — unless a test says `SOLUS_DB=sqlite` explicitly.

What holds for the life of the process:

- The roles are `collaboration` only, whatever `SOLUS_ROLES` says; every
  execution method answers `PLANE_DISABLED`.
- There is no link record, no tunnel listener, no connector, and no runner
  delivery of its own: the service is nobody's machine. `uplinkLink`,
  `uplinkUnlink`, and the pairing methods are refused as on a managed host;
  `/pair*` answers 404; LAN discovery is off; nobody is a trusted requester,
  loopback included; `requireAuth` is forced on every listener.
- One grant verifier (`server/host-grants.ts`, which now takes `issuer`,
  `jwksUrl`, and an `audience` rather than a link) trusts the cloud issuer for
  `aud: solus-workspace`. At the ticket door (`ticketForGrant`) only a member
  grant admits a person — as an `org-member` of the grant's organization with
  `hostKind: 'cloud'` — and only a runner grant admits a runner (§16). An owner
  grant and a guest grant are refused (`member-required`): `local-owner` and
  `remote-owner` never exist here, and a guest link is a host's resource.
- `organizationOf(principal)` is the grant's organization; every ported store
  call scopes by it, so another organization's rows are not found, not
  refused. Inside the organization the service is the team's space, as a
  managed host is (`isOrganizationSpace` in `server/principal.ts`): a resource
  made there starts shared with the organization as editors, and the owner
  alone transfers or deletes. A resource a runner's op wrote is claimed as it
  lands (`ShareManager.claimForRunner`: owned by the account that linked the
  runner when the grant carries `hostOwnerUserId`, else by the host-owner
  sentinel, and shared with the organization the same way), so nothing in the
  cloud is unowned — the managed host's "unowned is the team's" rule would
  otherwise answer for another organization's ids. An organization `owner` is
  the service's `isHostAdmin`.
- `connectionsGetServerInfo` answers `hostKind: 'cloud'`, `organizationId`,
  and `roles: ['collaboration']` (a new field on every host: the planes it
  serves), so a client keeps the service out of its execution targets.
- Presence is one room per organization (`PresenceManager.hostSnapshot(orgId)`,
  `clientsIn(orgId)`): the host roster is published to the clients of the room
  that changed, and `presenceSnapshot` answers the caller's own room. On a host
  every room is `local`, so nothing there changes.

Deployment: `packaging/workspace-service/` (`fly.toml` for two machines behind
Fly's proxy, health on `/health`, the managed-host image with `SOLUS_MANAGED=0`
overriding the baked value; the README names the secrets and the
`WORKSPACE_SERVICE_URL` the control plane needs). Not deployed by this change.

Known limits of P1: `tasks.invalidated` and the other host-wide invalidation
events are broadcast to every connected client of the service, whichever
organization it is in — they carry no data, only "re-read"; guests and share
links on the service are P4; `loadSessionPreview` and `loadSessionMessageWindow` on
the service still read the local index, which is empty there (§18 covers
`loadSession` and `loadSessionPage`).

## 16. The runner principal, runner delivery, and the ownership rule (P1)

**The runner principal.** `{ kind: 'runner', hostId, organizationId }`
(`server/principal.ts`), admitted from a grant that carries the `runner`
claim — `sub: host:<hostId>`, `aud: solus-workspace`, `organizationId` — on
the socket (a `runner` ticket kind in `server/auth.ts`) and on the runner HTTP
routes alike (`runnerPrincipalFor`). `assertRpcAccess` admits it to the
`system-only` methods and to nothing else; `organizationOf` is its
organization; it holds no role on any resource, hears no event, and joins no
room. `sessionRecordUpsert` from a runner stamps `runnerHostId` with the
runner's own id, whatever the body claimed.

**Delivery.** A linked host that the control plane counts in an organization
exchanges its host token for a runner grant
(`POST <directoryUrl>/v1/hosts/<hostId>/runner-grant`, answered with the
organization and the way to the workspace service) and ships two streams to
the service, in the order it numbered them:

- `POST <workspace>/runner/outbox` — `{ hostId, ops: [{ seq, op }] }` →
  `{ lastSeq, failed: [{ seq, error, permanent }] }`: outbox ops of the `tasks`
  and `works` domains.
- `POST <workspace>/runner/session-records` — `{ hostId, reports: [{ seq, record }] }`
  → `{ lastSeq }`: session-record upserts.

Both under `Authorization: Bearer <runner grant>`, verified without consuming
the grant's `jti` (one grant serves its ten minutes), with the body's `hostId`
required to be the grant's own. The schemas are
`server/uplink/runner-protocol.ts`; the runner side is
`server/uplink/runner-delivery.ts` (`RunnerDelivery`), the service side
`server/runner-intake.ts`.

On the runner: `outbox_ops` gained `seq` (one counter for both streams, in
`kv`, assigned inside the recording transaction so it is durable before the
row is) and `destination` (`host` for the client couriers, `cloud` for this
delivery; `outboxList` never shows a pending cloud op to a courier);
`runner_session_reports` queues one merged report per session (a later report
merges into the queued one as the record store would merge it, and takes a
fresh `seq`, so the queue is bounded by the number of sessions and a late ack
cannot drop a newer report). `session-records.ts` announces every write to one
of the host's own records (`onSessionRecordChanged`) with the whole stored
record; the delivery queues it stamped with the host id. Nothing waits on the
network: a tool writes its row and returns; the delivery wakes, sends in
batches of a hundred, and acks by sequence (a dead-lettered op stays visible in
`outboxList` with its error). A transient failure backs off, one second
doubling to a minute; a 401 mints a fresh grant; a host in no organization asks
again every five minutes; a restart resumes from what is still queued. The
cursor of what was acked is the queue itself.

On the service: `runner_cursors` (`outbox/schema.ts`, ported, generated
migration `0006_runner_cursors`) keeps `last_seq` per organization, runner,
and stream. Items at or below it are skipped; each op is applied through the
existing appliers — now `(op, organizationId)` — in the runner's organization,
and the op and the cursor advance in one transaction, so a crash between them
cannot apply anything twice. A `PermanentApplyError` is skipped, named in
`failed`, and the cursor moves past it; any other error stops the batch there
and the runner sends the rest again. Session-record reports go through
`upsertSessionRecord` with `runnerHostId` forced to the runner's id.

**The ownership rule.** On a runner linked to an organization
(`outbox/cloud-ownership.ts`, set by the delivery once it holds a grant,
cleared when the link goes) the agent tools' task and work writes are
**cloud-owned**: `create_task`, `update_task_status`, `comment_task`,
`link_task`, `create_work`, `update_work`, and `render_artifact` record an op
with `destination: 'cloud'` and return, and nothing lands in the runner's own
tables. Ids are minted before dispatch — a task id by `ulid`, a work id by
`randomUUID` — so the id the agent holds is the id the service writes the row
under; `createTask` therefore accepts an origin `{ id, now }`. The new op
verbs are `tasks/create`, `tasks/link`, and `tasks/link-session`
(`contracts/outbox-types.ts`); a cloud-owned `works/create` carries no
`taskId` and asks the service to file the work on the session's task itself
(`linkToSessionTask`). A signed-out or unlinked host applies locally as
before, and a dispatched session's foreign-task path is unchanged. The reads
(`read_task`, `list_tasks`, `find_works`, `read_work`) still answer from the
runner's own tables in P1: an agent cannot read back a cloud-owned row from
the runner yet.

## 17. The Lab on the cloud

`packages/lab/src/workspace.ts` boots the built server in workspace mode on a
temporary data directory (`bootWorkspaceService`; SQLite by default, Postgres
with a fresh database per run from `createLabDatabase` when
`POSTGRES_ADMIN_URL` is set). `LabIssuer` mints workspace grants
(`issueWorkspaceGrant`) and runner grants (`issueRunnerGrant`), and plays the
control plane's `POST /v1/hosts/:id/runner-grant` for a host it has attached
to an organization (`attachHostToOrganization`, `setWorkspaceRoute`).
`bootLabHost({ runnerOf })` boots a personal host with a real link and its
tokens, attached to the organization. The mock backend's `__MOCK_AGENT_TOOLS__`
directive runs the real `create_task` and `create_work` tools the host handed
the run. The `cloud-workspace` scenario is the proof, on both engines
(`packages/lab/README.md`).

## 18. The mirror (P2, §6 of the work)

A runner produces two things the collaboration plane must be able to read
with the runner off: session transcripts and insights. Both go through one
pattern. The producer appends to the runner's **mirror log**
(`packages/server/src/mirror/mirror-log.ts`, table `mirror_log`), numbered by
the same `kv` counter the outbox and the session reports use, and returns; the
runner delivery ships the log as a third stream (`POST /runner/mirror`) in
sequence order and truncates it on acknowledgement; the service applies each
item through the sink for its domain under the `mirror` cursor of
`runner_cursors`, in one transaction per item. A host that holds no runner
grant appends nothing (`mirrorEnabled()`): there is nowhere to ship to, and
the durable copies on the machine — the provider's transcript files,
`metrics.db` — are untouched by any of this.

**Transcripts.** The unit is the history row the client already replays, a
`SessionLoadMessage` at its position in the transcript the control plane's
lineage-aware reader produces (`loadSession`). `TranscriptMirror`
(`packages/server/src/mirror/transcript-mirror.ts`) is touched on every
broadcast event and every status change of a session, debounces two seconds
per session, reads the transcript, and appends the positions whose content
hash changed since the last pass (`transcript_mirror_rows`) plus a
`truncateFrom` item when the transcript shrank; a settlement flushes at once.
A restart touches every session the previous process left `running` (marked
`interrupted` at boot), so the rows of a killed turn reach the cloud once the
runner is back. The sink upserts `session_transcripts` by
`(organization, session, position)`; in workspace mode `loadSession`,
`loadSessionPage` (the cursor is a position), and the session description read
from that table and from `session_records`, so a member opens a session with
its runner dead.

**Insights.** `SqliteSpanExporter` appends every finished span that belongs to
a session — the turn tree — with the log events it owns, after
`writeSpanRecord` succeeded; host-internal spans stay local. The sink upserts
`insight_spans` and `insight_log_events` keyed by the runner and the span or
event id. Nothing queries them on the service yet; the tables are the durable
copy the rollover on the runner may delete from `metrics.db`.

## 19. Prompts while the runner is away (P2)

Decision: queued prompts stay in the memory of the host that runs the session,
as they always did. The cloud holds no prompt rows and no lease; a runner
claims nothing from the service. A prompt to a session whose runner is away is
refused by the client with the runner-offline state: the picker's cloud row is
marked "runner offline", and the record page (`SessionRecordPage.svelte`)
shows the mirrored transcript with an inert composer that says a prompt can be
sent once the runner is back. The owner prompts the session on the runner
itself when it returns, and the new turn's rows reach the service through the
mirror (§18). The tables `session_prompt_queue` and `session_runner_leases`
that migration 0007 created are dropped by 0008.

## 20. The credential vault (P3, §5)

`credential_vault` holds one encrypted credential set per person and provider
(`SOLUS_VAULT_KEY`, AES-256-GCM; `packages/server/src/vault/vault.ts`). On the
workspace service the seat RPCs are served by `VaultSeatManager`: a relayed CLI
login writes the provider's files into a seat directory, `markConnected` reads
them into the vault and deletes them; a pasted token goes in as a `token`
credential; for Claude, pasted `.credentials.json` contents are a `login`
credential. The website links a signed-in person to `/app/#/w/<orgId>/connections`,
which mounts the same seats surface against the cloud host, with the person's
GitHub, Google, and Atlassian connections below it. Settings → Providers on a
cloud row shows the same four sections; on a runner linked to an organization it
shows a member one row that opens that page instead, so the member never
overwrites the host's own connections. The host's owner, a guest, and a
signed-out client see the host's sections as before.

A runner leases the credential per turn (`POST /runner/credentials/lease`,
allowed when the person has been admitted to the runner's organization on the
service — `organization_members`), materializes it into that person's seat
directory only, and runs. When the material is near expiry the runner takes
the refresh lock (`credential_locks`, D2) for the turn; a second runner waits
for the lock, then re-leases and finds the refreshed version. After the turn
the runner reads the files back and, if they changed, writes them back with
the version it leased (`version_conflict` drops the local copy). A lease
refused with `no_credential` purges the local copy and refuses the turn with
`SEAT_REQUIRED`, whose message points at Solus cloud. A signed-out host, and
the host login, are unchanged.

Not in this slice: the organization GitHub App; usage readings on the service.
The Jira, Google, and GitHub connections joined the vault in §22.

## 21. Proofs

`bun lab run cloud-sessions` (P2) and `bun lab run cloud-vault` (P3), both on
SQLite and, with `POSTGRES_ADMIN_URL`, on Postgres. The mock backend keeps a
transcript on disk for a session whose first prompt carries `__MOCK_CLOUD__`,
streams a `__MOCK_SLOW__` turn slowly enough to be killed, and rewrites the
seat's `.credentials.json` after a `__MOCK_REFRESH__` turn as a provider CLI
refreshing would; every run it is handed records the credential material it
saw (`mock-runs.ndjson`).

## 22. Provider connections in the vault (P3, §5)

A person's GitHub, Google, and Atlassian (Jira and Confluence) connections are
theirs, not the host's: made once on the workspace service and leased by every
runner for calls made on their behalf. The vault's `provider` column takes
`github`, `google`, and `atlassian` beside the two seats; the material is the
provider store's own JSON under one file name (`{ files: { 'credential.json':
… } }`, `packages/server/src/vault/credential-material.ts`), so the vault, the
lease route, and the write-back keep one shape. `expires_at` is read off the
Google and Atlassian JSON; a GitHub token has none.

**The scope rule.** Whose credential a call acts with is decided once, at the
edge, and carried by `AsyncLocalStorage`
(`packages/server/src/vault/credential-scope.ts`): `SolusServer.handle` sets it
from the principal (`principalOwnerId`; the host-owner sentinel, the host
itself, and a runner mean "the host's own", which is `null`); a turn's tools
run under the turn's actor when the actor is not the host owner
(`credentialScopedAgentTools` in `control-plane.ts`); a task sync runs under the
task's owner from `resource_owner` (`tasks/sync-engine.ts`). Every store then
resolves through `packages/server/src/vault/provider-credentials.ts`, which
chooses by where the process runs:

| Process | Scoped person | Where the credential is |
|---|---|---|
| workspace service | a member | their vault row; no scoped person reads nothing and cannot write |
| runner with a grant | a member | leased (`POST /runner/credentials/lease`), held in memory only, leased again after five minutes or when the vault says `no_credential`; a refresh is written back under the version leased, and `version_conflict` drops the copy |
| runner with a grant | the host owner | the host's secret store |
| any host without a grant | anyone | the host's secret store, as before |

A runner never writes a member's GitHub, Google, or Atlassian credential to
disk, and a runner's "clear" (a 401, a refused refresh) forgets its copy only;
the row is the person's to disconnect on the service.

**Where each flow runs.** On the service the connect RPCs act for the calling
person: `PER_PERSON_ON_SERVICE_RPC_METHODS` in `server/access-policy.ts` makes
`providerConnect`, `providerCancelConnect`, `providerDisconnect`,
`googleConnect`, `googleDisconnect`, `atlassianStartOAuth`,
`atlassianCancelOAuth`, and `atlassianDisconnect` host-wide in workspace mode
(host-admin on a host, unchanged), and the git-provider auth methods are
`collaboration` in `rpc-planes.ts` since they need no checkout. The GitHub
device flow is keyed per person (`GitHubAuth.connecting`) and its result lands
under the dispatch scope. Google's pending flow records the person at start and
the callback route, which carries no principal, persists under that scope.
Disconnect on the service deletes the person's row only.

**The Atlassian route mode.** A host keeps the fixed loopback listener on
`127.0.0.1:51789`. The service has no loopback a browser can reach, so
`atlassianStartOAuth(callbackBaseUrl)` in workspace mode names
`<service origin>/oauth/atlassian/callback` as the redirect URI and
`GET /oauth/atlassian/callback` in `server/http.ts` completes it; the app the
service is built with must register that exact URI
(`packaging/workspace-service/README.md`). Pending flows are keyed by state and
carry the person; a person's new attempt supersedes only their own.

**What stays on the host.** A paired device's delegated GitHub token and the
dispatch checkout it drives; `solus git-credential`, a separate process that
reads the host's own store directly; `githubExportCredential`, execution and
host-admin; and the host owner's own connections, which never enter a vault.

**Known gap.** Headless work with no scoped person — an automation, a queue
drain, a poll of a task nobody claimed — uses the host's own credential on a
host and nothing on the service. A guest's tool calls on a runner are scoped to
the guest, who has no row; they see no connection rather than the host's.
