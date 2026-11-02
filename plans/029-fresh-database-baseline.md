# 029 Fresh database baseline — the one data model plan

Status: PLAN, 2026-11-01; §4.2 merger validation complete (PASS / CONDITIONAL adopted / FAIL for the index sibling). Reaffirmed 2026-11-01: no backwards compatibility anywhere, host or cloud; all data is deleted. Supersedes plans 022–028 and the data model section of
`plans/README.md`; their content is absorbed here. Those files stay as history
and are not to be executed on their own. Planned against `c4c64aff2` plus the
working tree. No source, schema, or database has changed under this plan.

## 1. Decisions that shape everything below

User decisions, 2026-11-01:

1. **The database is rebuilt from scratch and the existing one is wiped.** No
   migration, backfill, compatibility shim, read-both layer, or "keep the old
   marker" step exists in this plan. Every change is written into one baseline
   schema. The wipe itself is the developer's action; no plan step deletes or
   opens a live database.
2. **Two person columns, no more.** `created_by` is on every user-created
   table: the user id of who made the row, set from the verified acting
   identity, never from a client value, immutable. Ownership never transfers,
   so `created_by` is also the owner; `owner_key`, `person_key`,
   `granted_by_user_id`, and `by_user_key` all become `created_by`. `user_id`
   is the person a row is *for*, and exists only where that can differ from
   the creator: notifications (the recipient), activity (the person an event
   names), the delivery cursors and queue (the person whose token delivers).
   A personal preference is created by the person it belongs to, so its key is
   `(resource, created_by)`. An agent acting for a person records that person;
   agent and session provenance stay in their own columns. External authors
   keep an `author` attribution and are never presented as local users.
   Creator identity is not an access grant. Internal cursors, caches and
   derived rows carry no creator; they reach ownership through their parent.
   The baseline test enforces this: every table has `created_by` or is on the
   internal allowlist, `user_id` is the only other person column, and no other
   column names a person (user decision, 2026-11-01).
   Consequence (user decision, 2026-11-02): the `shareTransfer` RPC is removed,
   including the host-admin handover of a departed member's records (plan 004
   item 10). What a departed member owned keeps its `created_by`; the
   organization entry keeps it readable to the members who remain. `activity`
   rows name the signed-in person the actor acts for in `created_by` (NOT
   NULL) and the actor's kind in `by_kind`; see §8.
3. **Organization scope is canonical.** Every root record carries one
   `organization_id` (`local` or an organization id, never changed). Child rows
   that organization filters read carry it too. A host shared with several
   organizations keeps its membership relation; no single organization is
   forced onto it.
4. **A shared `resource_links` table is in the target.** Not open for debate;
   the remaining work is the reference-integrity implementation (§5).
5. **Work bodies are Git-backed, so revision retention is not a concern.**
   `work_revisions` stays as the revision index; its `content` is nulled once
   the body is archived, as `git-work-storage.ts:73-75` does today. The
   database-only storage provider is not the production configuration.
6. **Recents come from `projects`.** `recent_projects` is removed (§3.6).

Acceptance rule for every consolidation (from the earlier session, kept): it
must preserve results and access rules, make the implementation simpler, and
show no material regression on representative reads and writes. A lower table
count alone is not a reason.

## 2. Structural principles

These are the rules the baseline follows. Each names the concrete change it
causes; the table sections below carry the detail.

| # | Principle | What it changes |
| --- | --- | --- |
| P1 | **One owner per fact.** No fact is stored twice unless a measurement justifies it. | `sessions` and `session_records` stop sharing fifteen columns (§4). `recent_projects` goes (§3.6). PR facts are stored once per organization and authority in `pull_request_observations`, not on every link (§5). Browser default, lead status, watch state move onto the row they describe (§3). |
| P2 | **Hot metadata and large text are separate.** A list or aggregate never reads a body. | Span texts leave `attrs` into `span_texts` (§6). `listWorks` reads `content_hash`, not `content`; `revisions()` and the task board select no bodies (§8). |
| P3 | **A fact final at write time is stored at write time.** | Root-span timing measures are computed when the root closes (§6). `content_hash` is used, not recomputed (§8). `keeps_session` is a stored bit (§5). |
| P4 | **Growth is a decision.** Every history table has a declared lifetime. | `applied_ops`, `async_questions`, `session_admissions` get `retained_until` and one shared sweep; `activity` is deleted with its subject; `run_exchanges`, `webhook_seen_keys` keep their prunes (§7). |
| P5 | **Parent-child integrity is declared.** Every child of a session, task, or work has a foreign key with `ON DELETE CASCADE`. | Ten session child tables gain the key (§4). `resource_links` and `comment_threads` state their deletion rules explicitly because their parents are polymorphic (§5). |
| P6 | **JSON is a payload, never a predicate.** A field the app filters, sorts, or groups on is a column. | Promoted columns on spans; `started_by`, `trigger_config`, `attrs` stay JSON TEXT on both engines because nothing filters them in SQL. `json` remains TEXT in the schema DSL; no `jsonb`. |
| P7 | **One schema system.** Every table is a `defineTable`; one generated baseline per engine; nothing is created at runtime. | The legacy `CREATE TABLE` strings in `db/migrations.ts` and the history under `packages/server/drizzle/` are replaced by one baseline. `member_folder` becomes a `defineTable`. `session_fts` is created contentless once; the first-open rebuild in `db/index.ts:69` is deleted (§3.7). |
| P8 | **Owner scope is uniform.** Two person columns (decision 2); `organization_id` wherever a filter needs it; enforced by the baseline test, not by review. | `turn_flags` and `saved_metrics_queries` gain `created_by` and filter on it. `owner_key` → `created_by` on `session`, `tasks`, `works`, `webhooks`, `automations`, `integration`, `browser_profiles`, `workspace_projects`; `recipient_key` → `user_id` on `notifications`; `person_key` → `created_by` on preferences; `granted_by_user_id` → `created_by` and `target_user_key` → `user_id`. `task_counters` loses its meaningless `organization_id`. |

## 3. Table consolidations (absorbed from plans 022–027)

Rewritten for a fresh baseline: "drop" means the table is not in the baseline;
"add" means the baseline has the column. The behaviour requirements and tests
each original plan named are kept.

### 3.1 `saved_prompts` — not in the baseline (022)

No reader or writer in server, contracts, clients or tests. Not replaced by KV.
Test: the fresh schema has no such table or index.

### 3.2 Browser default on its profile (023)

`browser_profiles` gains `is_default INTEGER NOT NULL DEFAULT 0` and a unique
partial index on `(owner_key, project_root) WHERE is_default = 1`.
`browser_profile_defaults` is not in the baseline. The profile query returns the
flag; the selected profile is derived from the rows, falling back to the
built-in profile when no row is flagged. Setting a default is one `withTx`:
validate the named profile in that owner/project, clear the old flag, set the
new one; failure rolls back the clear. Cookie partitions key on profile ids and
are unchanged. Tests: owner/project isolation, built-in fallback, deleting the
selected profile, invalid selection keeps the prior default, rollback, two
defaults rejected by the index.

### 3.3 Lead status on the session (024, folded into §4)

`session_leads` is not in the baseline. `lead_started_at` is a nullable column
on the shared session row (§4 decides which row). Marking writes
`COALESCE(existing, new)` so the first mark survives a repeat, including a
repeat with a different organization argument. No state writer may clear it.
Positive cache and recheck-on-miss behaviour in `lead-sessions.ts` stay.

### 3.4 Personal resource preferences (025)

`session_views` and `task_snoozes` become one `resource_preferences` table in
`data/preferences/schema.ts`: `organization_id`, `resource_kind`
(`session` | `task`), `resource_id`, `person_key`, `settled_at`, `archived_at`,
`snoozed_until`, `snooze_note`; composite PK on the four identity columns; a
person/kind/resource lookup index and a partial person/kind/wake index where
`snoozed_until IS NOT NULL`. Required semantics kept: an empty session row
records participation (`SessionViewer.returnToList`) and is never cleaned up;
task wake deletes its row; an expired task snooze stays until woken; task move
keeps preferences, task delete removes them (explicit delete in the task
transaction, since the parent is polymorphic). Every join is qualified by kind
and organization as well as id and person. Typed commands per kind; no open
JSON settings object; domain authorization stays in task and session commands.
Pins and read state are not moved (ownership differs; product decision open).

### 3.5 Watch state on the PR link (026, folded into §5)

`session_pull_request_watches` is not in the baseline. The link row carries
nullable `watch_id`, `watch_started_at`, `watch_actor_key`, `watch_state`,
with a partial index on `watch_id WHERE watch_id IS NOT NULL`. Id, time and
state are all set or all null; a dismissed link cannot be watched. Start is a
guarded update of a live link; stop clears the fields; end and update require
the parent key plus the generation (`watch_id`); restart replaces the
generation; unlink and branch replacement clear watch state in the same
transaction while keeping dismissal tombstones. Ordinary link lists project the
start time and never parse watch JSON. With §5 the link row is a
`resource_links` row of the session→PR kind.

### 3.6 Operation receipts (027)

`workspace_api_receipts`, `applied_ops`, `webhook_seen_keys` become
`operation_receipts(scope, namespace, key, request_hash, result_id, expires_at)`
with composite PK `(scope, namespace, key)` and a partial expiry index on
non-null `expires_at`. Policies are typed per namespace, not caller-supplied:

- API create: scope is the current authority, namespace the create kind, key
  the retry key; matching fingerprint required; 24-hour TTL; stores a result id
  only, and a duplicate re-runs the authorized resource read.
- Applied operation: scope literal `courier-owner`, namespace literal
  `applied-operation`, key the operation id; no TTL; presence means committed.
- Webhook: scope is the webhook id; namespace distinguishes delivery id from
  replay key; keep the 25-hour and seven-day TTLs; expiry permits reuse.

The receipt and the protected domain write share one `Db` transaction; no host
guard beside a PostgreSQL domain write; claim by conditional insert or
expired-row replacement with `RETURNING`; rollback removes a winning claim.
Events and `runDelivery` are scheduled after the outermost commit
(`afterDatabaseCommit`). The hourly `sweepSeenKeys` becomes one bounded sweep
(≤1000 rows, ordered by expiry and key, null expiry excluded) on the existing
timer. Webhook receipts are deleted by scope, not a `LIKE` prefix. Tests as in
027 §steps 2–5, including two-connection PostgreSQL claims on the disposable
runner (`POSTGRES_ADMIN_URL`), recorded NOT TESTED if unavailable.

### 3.7 Removed or reshaped host tables (028 E-items)

- `recent_projects` is not in the baseline. `trackRecentProject` only calls
  `recordProject`; `listRecentProjects` is
  `SELECT key, path, folder_name, last_used_at FROM projects ORDER BY last_used_at DESC LIMIT 10`
  filtered by `existsSync`, mapped to the existing `RecentProject` shape. Known
  difference, accepted: today's recents keep a worktree's own path while
  `projects` keeps the repository root, and `projects` excludes the projects
  root and member folders. The directory picker shows six recents; the project
  list already groups by root (`docs/plans/project-model.md` §2).
- `turn_flags`, `saved_metrics_queries` gain `created_by`; list reads filter by
  it (P8).
- `task_counters` loses `organization_id`; it is one global `short_id` counter.
- `member_folder` is a `defineTable`.
- `session_fts` is declared contentless (`content=''`, `contentless_delete=1`)
  in the baseline; the drop-and-rebuild on first open is deleted.
- `outbox_ops.publication_id` and its index are not in the baseline.
- Span root writes use `INSERT ... ON CONFLICT DO UPDATE`, not
  `INSERT OR REPLACE`, so the `log_events` cascade cannot fire by accident.

## 4. Session identity

Today five tables describe one session: `sessions` (indexer state plus fifteen
facts), `session_records` (the collaboration record, same fifteen facts),
`session_states` (settle, snooze, viewed, execution preferences),
`session_leads`, and `session_admissions` (the Solus API's acceptance before the
provider starts; the owner comes from here). Plan 024 moves leads onto state;
the earlier session marked the full records+state+admission merger as
unvalidated. This section records the validation run on 2026-11-01 and the
resulting baseline.

### 4.1 Settled now, independent of the merger verdict

- `sessions` becomes `transcript_index(session_id, provider, file identity,
  last_offset, last_timestamp, size)`: indexer state only. Every session fact
  (provider, cwd, project_path, project_root, is_worktree, slug, custom_title,
  model, reasoning_effort, branch, parent/root ids, delegation_*) lives on the
  record and nowhere else (P1). The indexer writes the record once and the index
  row once; renames and branch changes write one row.
- The record gains the indexes the facts need: `(parent_session_id, created_at
  DESC, session_id DESC)` and `(parent_session_id, last_activity_at DESC,
  session_id DESC)` for the pages (every page names a parent: the top-level
  sessions are `parent_session_id IS NULL`, and an index on the order alone
  loses to that equality and sorts every row, as `EXPLAIN` showed; the
  `(created_at DESC, session_id DESC)` any-organization index had no reader
  left and is not in the baseline), `session_by_activity` as
  `(last_activity_at DESC, session_id DESC)` for the recent sessions of the
  list, and `(project_path, last_activity_at)` for the picker.
- Every session child table (`session_links`, `session_transcripts`,
  `transcript_mirror_rows`, `activity_mirror_rows`, `runs`, `run_queue`,
  `run_exchanges`, `async_questions`, `resource_preferences` rows of kind
  `session` via explicit delete, `resource_links` via explicit delete) declares
  `session_id REFERENCES <session table>(session_id) ON DELETE CASCADE` where
  the parent is a real table, so a record delete removes everything (P5).
- Admission facts live on the `session` row (§4.2); a row that never started is swept by `retained_until` logic on `admitted_at` with `started_at IS NULL` (P4).

### 4.2 Merger validation (records + states + leads; + admissions; + transcript_index)

Validated 2026-11-01 in an in-memory SQLite fixture
(`plans/data-model-validation/session-merge-fixture.ts`, `bun run`; 5,000
sessions, 2,014 states, 200 leads, 1,169 admissions, 1,496 PR links, 1,024
views). Not exercised: PostgreSQL plans and `ON CONFLICT` concurrency, the live
runtime, `defineTable` generation, the `viewed_at` move.

| Merge | Verdict | Reason |
| --- | --- | --- |
| (a) records + states + leads | **PASS** | Every state and lead write is already an upsert-or-update keyed by `session_id`. Result parity on every query; one `LEFT JOIN` and one `EXISTS` disappear; no new `SCAN` or `TEMP B-TREE`. |
| (b) + admissions | **CONDITIONAL → adopted** | The admission id *is* the Solus session id (`api-operations.ts:209`, `turn-organization.ts:137`), so `(organization_id, admission_id)` collapses to `session_id`. The row must be creatable before the provider starts, and `admit` needs a same-owner `DO UPDATE` arm for a report that arrives first. Both are specified below. |
| (c) + `transcript_index` | **FAIL — sibling stays** | The index row is keyed by the **provider thread id**, not the Solus session id (`migrations.ts:86`, `session-indexer.ts:264,305`, `session-lineage.ts:113-119`); one session has N threads after handoffs, and `last_offset` is per file (`session_files`). 1:N and runner-local facts cannot share the 1:1 row. |

**Baseline: one `session` row** (records + states + leads + admissions) and a
sibling `transcript_index` keyed by provider thread id.

Columns: `session_id PK`, `organization_id NN default 'local'`, `owner_key NN`,
`publication NN default 'local'`, `admitted_host_id`, `admitted_at`,
`started_at`, `provider`, `project_path`, `project_remote`, `runner_host_id`,
`title`, `custom_title`, `status NN default 'idle'`, `model`,
`reasoning_effort`, `parent_session_id`, `root_session_id`, `created_at NN`,
`last_activity_at NN default 0`, `size NN default 0`, `cwd`, `slug`,
`is_worktree NN default 0`, `branch`, `project_root`, `delegation_*`, `place`,
`started_by`, `settled_at`, `settled_by`, `unsettled_at`, `last_prompt_at`,
`execution_preferences`, `lead_started_at`, `created_by` (decision 2; equals
`owner_key` for user-started sessions and is the one stored identity).

Nullable until the provider starts: `provider`, `project_path`, `cwd`,
`project_root`, `runner_host_id`, `model`, `title`. `created_at` is the
admission time and is kept by every later write. CHECKs:
`started_at IS NULL OR (provider IS NOT NULL AND project_path IS NOT NULL)`
and `(settled_at IS NULL) = (settled_by IS NULL)`.

Row-absence meanings and their column encodings:

1. "No state row means active" → `settled_at IS NULL`.
2. "No record yet, leave it for start" → `started_at IS NULL`. The status
   writer stays a bare `UPDATE` and hits the admitted row (status is already
   `running` from admission).
3. `getSessionRecord(...) === null` branching in admission, `claimSessionOwner`,
   `applySessionFacts`, `admittedHomeOf` → `started_at IS NULL`. The in-memory
   birth caches (`rememberSessionBirth`, `bornInto`, `claimedOwners`,
   `admittedBirths`, `pendingAssignments`) are deleted: the row is the birth.
4. List and page readers add `started_at IS NOT NULL` so an admitted-but-never-
   started row is not shown.
5. `isLeadSession` keeps its hit-only cache against `lead_started_at IS NOT NULL`.
6. Delete is one `DELETE` and the cascades of §4.1; states, leads and admission
   go with it (today they are orphaned).

Admission and report, idempotent:

```sql
-- admit (API accept)
INSERT INTO session (session_id, organization_id, owner_key, publication, admitted_host_id, admitted_at, created_at, created_by)
VALUES (?, ?, ?, 'published', ?, ?, ?, ?)
ON CONFLICT (session_id) DO UPDATE
  SET admitted_at = COALESCE(session.admitted_at, excluded.admitted_at),
      admitted_host_id = COALESCE(session.admitted_host_id, excluded.admitted_host_id)
  WHERE session.owner_key = excluded.owner_key;
SELECT owner_key, admitted_host_id FROM session WHERE organization_id = ? AND session_id = ?;
-- owner or host differs → SessionAdmissionConflict (409), as today

-- host report (applySessionFacts)
INSERT INTO session (...facts...) VALUES (...)
ON CONFLICT (session_id) DO UPDATE
  SET started_at = COALESCE(session.started_at, excluded.started_at), <facts>
  WHERE session.organization_id = excluded.organization_id;
-- never names owner_key or publication in SET (today's upsertRecordNow rule)
```

Fixture results: first admit 1 row; same-owner retry 0 rows, same admission;
another person's retry leaves the stored owner and host and is refused;
report-twice is identical; report-before-admit creates the row with the
deliverer as owner and the later admission fills `admitted_*` once. Postgres
`ON CONFLICT ... RETURNING` returns no row on conflict as SQLite does, so the
follow-up `SELECT` is required on both.

Queries (parity OK on all; current → merged ms): `readSessionListPage` 3.10 →
3.08 with the state join and lead subquery gone; `settleSessionsWithEndedPullRequests`
0.82 → 0.93; `liveSessionBranches` 0.35 → 0.29; `settledSessionIds`,
`isLeadSession`, admission lookup, `SessionShelf.row` unchanged at PK seeks.
Writes (µs per row, in transaction): status 4.1 → 3.4; settle 0.8 → 1.4;
prompt 2.0 (two statements) → 1.4 (one); viewed 0.9 → 1.3. A `session_runtime`
sibling for hot columns is not justified by these numbers; revisit only if
PostgreSQL row versioning shows bloat from `last_activity_at` updates.

Indexes: `(organization_id, created_at DESC, session_id DESC)`,
`(organization_id, provider, created_at DESC, session_id DESC)`,
`(organization_id, last_activity_at DESC, session_id DESC)`, the §4.1
any-organization, parent and project-path indexes, `(place, last_activity_at)`.
`session_states_settled` has no reader and is not in the baseline.

**Personal fact found on the shared row (product decision):** `viewed_at` is
one boundary per session, documented as "so every client agrees", but on an
organization session Alice reading marks it read for Bob. It belongs in
`resource_preferences` (§3.4) beside `settled_at` and `snoozed_until`, the same
move migration 0030 made for `settled_by = 'person'`. Recommended: move it.
`execution_preferences` is person-derived but intentionally shared per
plans/018 §6; keep and document.

Fixed as a side effect: `ensureRow` reads `organizationOfSession`, which does
not consult the admitted birth, so the state row of a new organization session
on an attached machine gets the machine's organization today. One row, one
organization.

Invariants a test must assert: owner and organization never change after the
first insert, whichever writer made it; a same-owner retry is a no-op returning
the same admission; a different owner or host is refused; `started_at` is set
once and provider facts are null before it; list reads exclude
`started_at IS NULL`; `lead_started_at` keeps its first value under repeated
marks and every state writer; settle returns null when already settled; the
settle CHECK holds; `recordPrompt` on a never-started row is one `UPDATE` and
clears the settle; deleting the session removes state, lead and admission facts.

## 5. Relationships and threads

Model-validated on 2026-11-01 (`plans/data-model-validation/README.md`): 74
relationship checks and 58 thread checks passed in SQLite fixtures. Application
integration and PostgreSQL concurrency are open gates.

### 5.1 `resource_links` + `pull_request_observations`

Replaces `task_links`, `task_session_links`, `session_links`,
`session_pull_requests` (watch columns from §3.5 included) and the JSON
membership in `works.meta.sessionIds`. One row per edge:

- `organization_id NOT NULL`, `source_kind`, `source_id`, `target_kind`,
  `target_id` (both endpoints checked against the organization in the command),
  `relation` (e.g. `works-on`, `output`, `reference`, `member`, `pull-request`),
  raw `target_scope`/`target_key` for unresolved targets, nullable canonical
  `repository`/`number`, `source`/provenance, dismissal tombstone, pin,
  `created_by`, `created_at`, watch fields, and the stored bit `keeps_session`.
- `pull_request_observations(organization_id, authority_key, repository, number,
  state, draft, title, updated_at, observed_at)`: PR facts once per organization
  and source authority. Authority keys describe visibility context, never
  tokens. Links reference an observation; the observation and every dependent
  `keeps_session` bit update in one transaction.
- Indexes: unique on the edge identity with a canonical spelling of session
  scope; both directions `(source_kind, source_id)` and `(target_kind,
  target_id)`; partial unique for one active working task owner;
  `resource_links_open_session ON (owner_id, organization_id) WHERE
  keeps_session = 1` — the measured covering index; the join-only candidate
  query was 2–11× slower and is rejected.
- Rules kept from the fixtures: direct task links beat newer inherited session
  links; references contribute no PRs; dismissed PRs stay dismissed on branch
  discovery and revive only by explicit link; removing an adopted output does
  not recreate it; claimed outputs survive departure; work origin stays on the
  work row (`session_id`) and is in the access union even without a membership
  edge; unresolved aliases are never silently merged.
- Reference integrity across polymorphic endpoints: no SQL foreign key is
  possible. Every delete of a task, work, or session runs
  `DELETE FROM resource_links WHERE (source_kind, source_id) = (?, ?) OR
  (target_kind, target_id) = (?, ?)` in the same transaction, and a periodic
  sweep asserts zero dangling edges in tests. Move semantics stay explicit:
  task moves remove source comments and keep links per current `task.ts`.
- `task_session_links.pr` and `tasks.pr` are still written by `task.ts:634,
  639`; those callers move to observations before the fields go.
- Open before approval: alias collision policy (two raw aliases resolving to one
  canonical target with conflicting pins/titles), concurrent observation versus
  link changes, PostgreSQL plans.

### 5.2 `comment_threads`

Replaces `task_comments` and `work_annotations`; `plan_annotations` keeps its
bookmark/status metadata without its comment array. Identity
`(organization_id, subject_kind, subject_id, subject_part, thread_id)`, all
non-null. Columns: body, typed author (`created_by` for local users; external
authors kept as attribution, never presented as verified users), source, task
provenance, created/updated, review position, mutation version, delivery state
(`private`/`pending`/`sent`), external identity scoped by provider, account,
site and target, and a review payload (anchors, replies, read, resolution).
Corrections from validation: task ordering `(created_at, id)`, work/plan
ordering by explicit position with separate indexes; positions allocated by
advancing a parent counter in the same transaction; external uniqueness includes
provider/account/site/target; task delivery state separate from external
operation receipts (§3.6); distinct thread mutation version, external-state
version, provider-link generation and parent collection revision; plan threads
belong to durable annotation identity, not the rebuildable index; work moves
keep comments, task moves remove them. Payload measured at 100 threads:
121,991 → 1,218 bytes per edit. Whole-array save callers
(`work-annotations.ts`, `comment-tools.ts`, `history-handlers.ts`) become
commands or version-checked batches before the table is used; a stale snapshot
diff must not delete a newer thread.

## 6. Insights (`metrics.db`)

Own file, own baseline; no contention with records.

- **`span_texts(span_id, name, text)`** holds `prompt`, `systemPrompt`,
  `response`, `thought`. `attrs` keeps the ~100–300 B of structured fields.
  Measured: a listing aggregate over 20k turns 683 → 25 ms; file size falls by
  most of its bytes; the system prompt stops being copied per turn
  (`turn-page.ts:171-288`, `session-emitter.ts:30-37, 953-959`). `api-turns.ts`
  no longer needs `json_remove`.
- **Stored root measures.** When the root span closes (`span-table.ts:216-233`,
  all children present, one transaction) compute per-kind sums, thinking
  lead-in and provider wait with the existing `trace-timing.ts`/`rollups.ts`
  code and store them on the root. The `turns` view selects the columns.
  Measured: `AVG(provider_wait_ms) BY model` 1,395 → ~46 ms class.
- **Promoted columns** for the fields the compiler filters and groups on
  (`cost_usd`, `input_tokens`, `output_tokens`, `hostname`, `task_id`) stay an
  option after §6.1 lands; not needed for the measured wins.
- `metricsDistinctValues` adds `kind = 'turn'`. Partial indexes
  `spans(started_at) WHERE kind='turn' AND host_id IS NOT NULL` and
  `WHERE kind='turn' AND ended_at IS NULL` serve the pull and boot statements.
- `turn_flags`, `saved_metrics_queries` carry `created_by` (P8).

## 7. Lifetimes (P4)

| Table | Lifetime in the baseline |
| --- | --- |
| `session_records` children | Cascade from the record (§4.1). |
| `applied_ops` (→ `operation_receipts` applied namespace) | No TTL by policy (§3.6); presence means committed. Reviewed: a replay horizon may be set later; not now. |
| `async_questions`, `session_admissions` | `retained_until`; shared sweep on the existing timer. |
| `run_exchanges` | Existing prune kept. Closed replies loaded by id, not at startup (028 carried from the first review). |
| `activity` | Deleted with its subject: `Work.delete()` and session delete call `deleteActivityFor`, as task delete does. Age sweep optional. |
| `work_revisions` | No retention (decision 5). `content` nulled on archive. |
| `webhook_deliveries`, `webhook_seen_keys` | Existing prunes; receipts via §3.6 sweep. |
| `notifications` | Unchanged. |

## 8. Query and write-path changes (absorbed from 028)

Code changes that read the new shape. Evidence lines are in plan 028's tables;
they are listed here by intent so the plan is complete on its own.

Reads that touch every row:
- Any-organization session page and `parent_session_id` filters use the §4.1
  indexes. Search filters visibility and `project_root` inside the FTS query and
  reads `viewed_at` and PR names for the hit page only; lineage misses are
  cached or loaded once per search.
- `listWorks` selects `content_hash`; `revisions()` selects no bodies; the task
  board selects no `body`/`epic`/`pr`; plan lists select no bodies.
- Integration connections filter by integration and person in SQL; webhook
  pagination cursors on `(created_at, id)`; PR watch updates carry the parent
  key; session activity reads only the requested window.

Write amplification during a turn:
- Codex refresh appends only the tail (`MAX(id)` per session); full replace only
  when the count shrank.
- The plan scanner resumes from a stored offset or runs only when the tail batch
  contained `ExitPlanMode`.
- Status writes use `UPDATE ... RETURNING`; the upsert does not set `created_at`;
  an unchanged Claude pass writes nothing.
- Write-only indexes are not in the baseline: `sessions_worktree_recent`,
  `sessions_by_parent`, `session_states_settled`, `session_views_by_person`;
  `transcript_index(last_timestamp) WHERE branch IS NOT NULL AND branch <> ''`
  serves the PR-sync tick. `getChildSessions` is deleted.
- Transcript mirroring sends a reliable changed range with full reconciliation
  for recovery; runner delivery locks on the cursor identity before applying.

Correctness carried from the first review: external-ticket uniqueness includes
`organization_id` and task plus link creation is atomic; work comment writes are
thread rows (§5.2); pins and metadata queries are host-qualified.

## 9. Cloud (`solus-cloud`), owned by the startup session

The same rule applies to the cloud: all data is deleted and the schema starts
fresh. There is no migration history to order, so the earlier gate about the
completion migration's journal timestamp (0017 versus 0018) is void. The cloud
schema is regenerated as one Drizzle baseline that already contains:

- `host_link` and `managed_host` as column groups on `host` with the
  completeness CHECKs; `organization_host_policy` as columns on `organization`
  with `policy_revision`; organizations read once for page startup (startup
  session, `fast-secure-startup`, `d629bfa` and `099fabe`).
- Completion timestamps as server-owned user fields (`input: false`), the two
  completion tables gone; Better Auth's server API creates the first
  organization and owner membership with no default team (earlier session,
  uncommitted in the main checkout).
- `created_by` on user-created cloud records per decision 2, where the cloud
  session agrees it is not already covered by Better Auth's own columns.

Merging the two checkouts is still a text merge of `schema.ts`,
`create-auth.ts`, and `account-onboarding.ts`; it is no longer a migration
ordering problem. The cloud session owns the regeneration and the deploy.

## 10. Target table list

Solus host records and index, after this plan:

- Removed: `saved_prompts`, `browser_profile_defaults`, `session_leads`,
  `session_states`, `session_admissions` (both merged into `session`, §4.2),
  `session_views`, `task_snoozes`, `session_pull_request_watches`,
  `workspace_api_receipts`, `applied_ops`, `webhook_seen_keys`,
  `recent_projects`, `task_links`, `task_session_links`, `session_links`,
  `session_pull_requests`, `task_comments`, `work_annotations`, `sessions`
  (renamed and narrowed to `transcript_index`).
- Added: `resource_preferences`, `operation_receipts`, `resource_links`,
  `pull_request_observations`, `comment_threads`, `transcript_index`,
  `span_texts` (metrics), `member_folder` (now declared).
- Count: 74 → 62 (`session_records` continues as `session`). The count is a
  consequence, not a target.

## 11. Order of work

1. Write the baseline schema: every table as `defineTable`, in the order §3,
   §4.1, §5, §6, §7, §3.7; generate one migration per engine; delete
   `db/migrations.ts` DDL and the drizzle history; `tests/unit/
   data-model-baseline.test.ts` asserts the exact table and index set from
   `sqlite_master` and `pg_catalog` on the disposable runner.
2. Move the stores to the new shape, group by group, each with its focused
   tests from the absorbed plans: browser profiles; preferences; receipts;
   session record/index split and cascades; links and observations; threads;
   insights texts and root measures; host tables.
3. Query and write-path changes of §8, each with an `EXPLAIN QUERY PLAN`
   assertion (no `SCAN`/`TEMP B-TREE` where the finding named one) and a result
   parity fixture.
4. PostgreSQL gates on the disposable runner: receipt claims on two
   connections, observation versus link concurrency, thread CAS, delivery
   cursor serialization. Record NOT TESTED where the endpoint is unavailable;
   do not infer an ambient endpoint is safe.
5. Developer wipes and restarts on the new baseline. Not a plan step.

Do not run `bun run build`. No commits or PRs are part of this plan.
