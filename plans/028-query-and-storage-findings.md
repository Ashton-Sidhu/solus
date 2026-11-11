# 028 Query and storage findings — 2026-11-01

Status: TODO. Findings only; no source, schema, or database changed.

> **2026-11-10.** [Provider-owned tasks](../docs/plans/provider-owned-tasks.md) replaced the task model. GitHub and Jira own every task; Solus has no local task, no task in an organization and no task sharing. In this plan, finding C5 (the task board selects `tasks.*`) and the task delete of D3 describe the old `tasks` table and are history. The `tasks` table is now the task cache.

A second pass over the Solus host database, after the table consolidation
review (plans 022–027). That review asked which tables should exist. This one
asked what the application's SQL does to the tables that remain. Every
statement in the named groups was read, the schema was built in an in-memory
SQLite, and `EXPLAIN QUERY PLAN` was run on the real statements. Measurements
come from synthetic in-memory fixtures and understate disk cost. "Reasoned"
means the plan and the code show the cost; it was not timed.

Scope: the four groups below. Cloud (`solus-cloud`) tables are out of scope.

**Rebuild rule (user decision, 2026-11-01):** the database is rebuilt from
scratch and the existing one is wiped. No migration, backfill, compatibility
shim, or "keep the old marker" step is part of any item here. Every change is
written into the baseline schema directly. In particular: the legacy
`CREATE TABLE` strings in `db/migrations.ts` and the drizzle history under
`packages/server/drizzle/` collapse into one generated baseline per engine;
every table moves to `defineTable`; E1 is done as the split, not as a
read-both compatibility layer; D1 is done with declared foreign keys and
`ON DELETE CASCADE`, not a manual delete list; E4 writes the contentless FTS
form and drops the first-open rebuild. Items that said "drop index X" or
"add column Y" simply mean the baseline does not have X and does have Y.

## A. Measured, local, do first

| # | Finding | Evidence | Change |
| --- | --- | --- | --- |
| A1 | Insights aggregates read ~20 KB of text per turn. `volume`, `hosts`, `stats` each `json_extract` one number from `attrs`, but the row carries prompt (4 KB cap), system prompt (16 KB), response (8 KB), and uncapped `thought`. 20k turns: 683 ms per aggregate; 25 ms with the texts out of the row. JSONB does not help; a promoted column does (32 ms). `turnListingSummary` runs three such aggregates per filter change. | `data/insights/turn-page.ts:171-288`, `execution/observability/session-emitter.ts:30-37, 953-959`, `data/insights/api-turns.ts:71-76` | Move `prompt`, `systemPrompt`, `response`, `thought` out of `attrs` into `span_texts(span_id, name, text)` read only by the trace view. `attrs` falls to ~100–300 B. Also removes the `json_remove` in `api-turns.ts`. `metrics.db` size falls by most of its bytes; the system prompt is repeated per turn of a session. |
| A2 | `provider_wait_ms` and `thinking_time_ms` are five-CTE window queries per row inside the `turns` view. `AVG(provider_wait_ms) BY model` at 20k turns × 15 children: 1,395 ms; `thinking_time_ms` 316 ms; `SUM(tool_time_ms)` 46 ms. | `data/insights/field-registry.ts:201-219`, `trace-timing.ts:67-129`, `span-table.ts:216-233` | The root span is written after every child, in one transaction. Compute the per-kind sums, thinking lead-in and provider wait once there (the TypeScript exists in `trace-timing.ts` and `rollups.ts`) and store them on the root. The view selects the stored value. |
| A3 | The host work list reads every body to recompute a hash the row already stores. `listWorks` selects `content` only so `withDerivedSyncState` can call `documentContentHash` for Google-mirrored works. `works.content_hash` is that value by definition. Artifact bodies are hundreds of KB. | `data/works/works.ts:138-144, 168-181`, `work-rows.ts:69`, `schema.ts:28-30` | Select `content_hash` instead of `content`; compare `link.lastPushedContentHash !== row.content_hash`. The API path already does `NULL AS content`. |
| A4 | `metricsDistinctValues` scans every span of every kind: `SELECT DISTINCT model FROM spans ... ORDER BY model LIMIT 200`. 62 ms at 300k spans; 23 ms with `kind = 'turn'`, same result set for model, provider, origin, user_email, organization_id. | `transport/handlers/observability-handlers.ts:46` | Add `kind = 'turn'`. |

## B. Write-path amplification during a turn

| # | Finding | Evidence | Change |
| --- | --- | --- | --- |
| B1 | Every Codex refresh deletes and reinserts the thread's whole message set and FTS postings. A 400-message thread costs 800 deletes and 800 inserts per turn. Claude already appends from `last_offset`. | `db/session-indexer.ts:245-249`, `execution/agents/codex/codex-backend.ts:1049` | Codex thread messages are append-only and ids are `number * 2^20 + position`. Read `COUNT(*)` / `MAX(id)` for the session (statement at `:209`), skip the first N, append the tail. Full replace only when the count shrank. |
| B2 | The plan scanner re-reads the whole Claude transcript file on every flush during a streaming turn: it caches by mtime, the mtime changes per flush, the watcher debounces at 2 s. A 100 MB file is read start to end every ~2 s. | `db/session-indexer.ts:44, 399`, `execution/agents/claude/claude-plan-helpers.ts:72-89` | Give the scanner the message reader's `last_offset` contract (store scanned offset and open `pending` plans), or scan only when the tail batch contained an `ExitPlanMode` tool use, which the reader already parses. |
| B3 | Each `sessions` upsert rewrites three `last_timestamp` indexes and all 10 columns; each `session_records` upsert sets all 27 non-key columns including `created_at` (two indexes) and `started_by`. A status change is UPDATE, then a 29-column read-back, then a re-queue (SELECT + DELETE + INSERT). | `db/session-indexer.ts:263-283, 305, 744, 867-905`, `data/sessions/session-records.ts:649-657` | `UPDATE ... RETURNING <columns>` for the status write; drop `created_at` from the upsert `SET`; guard the Claude upsert with `WHERE last_timestamp IS NOT excluded.last_timestamp OR size IS NOT excluded.size`. With B4, index maintenance per flush falls from 3 to 1. |
| B4 | Write-only indexes. `sessions_worktree_recent` (partial on `is_worktree = 1`): its query now scans because `recentBranchSessions` dropped that predicate; no statement contains `is_worktree = 1`. `sessions_by_parent`: its only reader `getChildSessions` has no caller. `session_states_settled`: every `settled_at` predicate is `IS NULL` on a PK join. `session_views_by_person`: the partial `session_views_snoozed` serves the only `person_key`-first read. | `db/migrations.ts:110-113`, `data/tasks/host-records.ts:93-98`, `db/session-indexer.ts:655-661`, `data/sessions/schema.ts` | Drop the four. Add `sessions(last_timestamp) WHERE branch IS NOT NULL AND branch <> ''` for the PR-sync tick (verified: range seek). Delete `getChildSessions`. |

## C. List and search reads that touch every row

| # | Finding | Evidence | Change |
| --- | --- | --- | --- |
| C1 | The "all sessions" page scans `session_records` on a normal host. The owner's scope is `ANY_ORGANIZATION`, `scopeClause` renders `1 = 1`, and every composite index leads with `organization_id`. Plans: `SCAN session_records; USE TEMP B-TREE FOR ORDER BY` for the created order; the activity order uses `session_records_by_activity` then a temp b-tree for `session_id`. Hit per open by the unified picker (two lists per host), the editor reference index, and mobile. | `data/sessions/api-operations.ts:245-265`, `admission/principal.ts:234`, `workspace-ui/.../conversation-search.svelte.ts:234-236`, `reference-index.svelte.ts:421`, `apps/mobile/.../thread-directory.ts:171` | Add `(created_at DESC, session_id DESC)`; make `session_records_by_activity` `(last_activity_at DESC, session_id DESC)` so the `(last_activity_at, session_id) < (?, ?)` seek matches; consider `(project_path, last_activity_at)` for the picker's project filter. |
| C2 | No index on `session_records.parent_session_id`. The `parentSessionId` filter and `readDelegatedSessions` (one query per depth level when artifacts open) scan; every top-level page carries `parent_session_id IS NULL`. | `data/sessions/api-operations.ts:262`, `session-artifacts.ts:135` | `(parent_session_id, created_at DESC, session_id DESC)`. |
| C3 | Every search request (180 ms debounce) reads every session record with a `session_states` probe per row, then every PR link (`SCAN + TEMP B-TREE`), then every watch, then one lineage resolve per linked session; the id set is used only as a membership filter. | `data/sessions/api-operations.ts:39-47, 305-308`, `db/session-search.ts:130`, `data/sessions/pull-request-watches.ts:141` | Filter visibility and `project_root` inside the FTS query; read `viewed_at` and PR names for the hit page only (`session-search.ts:204-212` already runs a page query). |
| C4 | Lineage misses are not cached, so search re-queries every lineage-less session (most history sessions). 5,000 sessions: 2.4 ms raw plus a zod parse per row; one bulk map 0.46 ms. | `db/session-search.ts:109-111`, `data/sessions/session-lineage.ts:126-135, 183-352` | Cache misses (every lineage write already calls `forgetLineageReads`), or load the thread→session map once in `sessionsInScope`. |
| C5 | The task board selects `tasks.*` including `body`, `epic`, `pr` for every task; the sidebar renders none of them; the API page already blanks `body`. | `data/tasks/task-store.ts:231-239, 270-278, 378-401`, `task-sidebar.ts:12` | A list column set without `body` and `epic`; keep `TASK_SELECT` for `taskRow`. |
| C6 | `revisions()` is documented "without bodies" and selects every body; `revisionSummaryFromRow` discards them. With D2 this is an unbounded body read to open a history menu. | `data/works/work.ts:453-458` | `REVISION_SUMMARY_COLUMNS` without `content`; keep the full list for `exportWorkForCloud` (`works.ts:238`). |
| C7 | Boot and pull statements walk every turn: `closeAbandonedTurns` (`kind='turn' AND ended_at IS NULL`, once per process) and `newestPulledTurnStart` (`host_id IS NOT NULL`, every 30 s; on a host with no pulled turns it reads every turn). 9 ms and 7.7 ms at 20k turns, linear in retention. | `data/insights/metrics-db.ts:20-33`, `pulled-turns.ts:54-62`, `sync/insight-pull.ts:26` | Partial indexes `spans(started_at) WHERE kind='turn' AND host_id IS NOT NULL` and `WHERE kind='turn' AND ended_at IS NULL`. |

## D. Rows nothing deletes

| # | Finding | Evidence | Change |
| --- | --- | --- | --- |
| D1 | Session delete removes one row. `deleteSessionRecord` deletes only `session_records`; no foreign keys, no sweep. Orphans stay in `session_states`, `session_views`, `session_leads`, `session_links`, `session_pull_requests`, `session_pull_request_watches`, `session_transcripts`, `transcript_mirror_rows`, `activity_mirror_rows`, `runs`, `run_queue`. Orphan PR links and views also stay in `listCandidates`. `applied_ops`, `async_questions`, `session_admissions` have no delete path at all; the boot `UPDATE async_questions ... WHERE state = 'delivering'` is a growing scan. | `data/sessions/session-records.ts:638-647, 233-235`, `sync/outbox/outbox-store.ts:193`, `data/sessions/async-questions.ts:13` | Declare `session_id REFERENCES session_records(session_id) ON DELETE CASCADE` on every child table in the baseline; one `DELETE` on the record removes the rest. Give `applied_ops`, `async_questions`, and `session_admissions` a `retained_until` column and one shared sweep on the existing timer. |
| D2 | `work_revisions` is unbounded. An `agent` or `upstream` save checkpoints the displaced body and inserts the new one, both with `content`. No `DELETE FROM work_revisions` exists; bodies are nulled only by the Git storage provider. The current body is also in `works.content` and `works_fts`. | `data/works/work.ts:168-186`, `git-work-storage.ts:73-75` | A retention rule in the works domain: keep the last N `agent` checkpoints per work plus every `review` and `restore` row, or null `content` on checkpoints past the revert window. Product decision: how far back revert reaches. |
| D3 | `activity` rows for sessions and works are never deleted; only task deletion calls `deleteActivityFor`. Reads are indexed and the notification list does not join `activity`, so growth costs disk and backup, not list speed. The `by_user_key` read has no index but is an unreachable branch today. | `data/activity/activity.ts:72-74, 98-100`, `data/tasks/task.ts:763, 779`, `data/works/work.ts:541-549` | Call `deleteActivityFor({ kind: 'work' })` in `Work.delete()` and the session equivalent on session removal; consider an age sweep like `webhook_seen_keys`. Delete the `userId` branch or index it when it gets a caller. |
| D4 | `DELETE FROM webhook_seen_keys WHERE key LIKE 'id:%'` scans the table; PK is `(kind, key)`. Hourly, tiny. | `data/webhooks/webhook-store.ts:140` | `WHERE kind IN (...) AND key >= 'id:' AND key < 'id;'`. |

## E. Structural: duplicated facts and stale definitions

| # | Finding | Evidence | Change |
| --- | --- | --- | --- |
| E1 | `sessions` and `session_records` store the same facts twice: provider, cwd, project_path, project_root, is_worktree, slug, custom_title, size, model, reasoning_effort, branch, parent and root ids, delegation_*. Renames and branch changes write both. The indexed copy (`sessions_by_parent`, `sessions_by_project_root`) is the one the API does not read; `session_records` lacks those indexes (C1, C2). | `db/session-indexer.ts:264, 305, 701, 744, 808, 840-869, 905` | In the baseline, `session_records` owns every listed fact and gets the parent and project-root indexes. `sessions` becomes `transcript_index`: file identity, `last_offset`, `last_timestamp`, `size`, provider. The indexer writes the record once and the index row once. Admission and state stay separate per the index's note on the unvalidated identity merger. |
| E2 | `recent_projects` duplicates `projects.last_used_at`. `trackRecentProject` already calls `recordProject`; `listRecentProjects` is `SELECT ... FROM projects ORDER BY last_used_at DESC LIMIT n` in all but name. Both are read whole and `existsSync`-filtered. | `data/workspace/...recent-projects.ts:33-66`, `project-config/projects-manifest.ts:69-99` | `recent_projects` is not in the baseline; recents read `projects.last_used_at`. −1 table. |
| E3 | `turn_flags` and `saved_metrics_queries` have no `owner_key` or `organization_id`; `listTurnFlags` returns every flag on the host. A shared host shows every member's flags and queries to every member, unlike `automations`, `browser_profiles`, `integration`. Scope gap, not speed. | `db/migrations.ts` slot 0, `data/insights/turn-flags.ts:42-50` | Add the owner column and filter, consistent with the creator rule in the index. |
| E4 | `session_fts` is created as external-content (`content='session_messages'`) by the migration, then dropped and rebuilt contentless (`content=''`, `contentless_delete=1`) on first open. No triggers; sync is manual and only valid because of the rebuild. | `db/migrations.ts:332-337`, `db/index.ts:69`, `db/session-indexer.ts:215` | The baseline creates `session_fts` contentless; the first-open rebuild in `db/index.ts:69` is deleted. |
| E5 | `member_folder` is created with `CREATE TABLE IF NOT EXISTS` at runtime outside both migration systems. | `host/member-folders.ts:26` | It is a `defineTable` in the baseline. |
| E6 | `INSERT OR REPLACE` on a root span cascades a delete of its `log_events`. Harmless today because events are inserted after the replace in the same transaction; a trap for `writePulledTree`-style code. | `data/insights/span-table.ts:216-233` | `INSERT ... ON CONFLICT DO UPDATE` instead of `OR REPLACE`. |

## Checked and fine

`readSessionListPage` (one id query with indexed UNION arms, one row query, four batched `IN` reads; no N+1). `session_messages` window, count and uuid reads. Claude tail indexing (300-line transactions, 256 KiB reads, offset resume). `session_transcripts` PK serves tail, page, probe, truncate. `session_transcripts_fts` kept by triggers. `delivery_queue`, `outbox_ops`, `run_queue`, `async_questions` reads indexed; none polled on a timer. Notifications page, unread count, dedupe. Task detail reads, task and work API paging, sharing (`acl_entry`) reads, webhook deliveries list and prune. Work FTS trigger fires only on title or content change. Cascades: `PRAGMA foreign_keys = ON`, every child FK is the leading column of a PK or index. Metrics write path: one `BEGIN IMMEDIATE` transaction per span, ~4 µs in memory, WAL with `synchronous = NORMAL`, own file, no contention with `solus.db`. All five `spans` indexes and both `log_events` indexes have a reader. Insights cursor list is keyset, no COUNT or OFFSET. Query compiler ends every path in `LIMIT`.

## Verification per item

Each change ships with a focused unit test on isolated SQLite (and the disposable PostgreSQL runner where the table exists on both engines): the statement's `EXPLAIN QUERY PLAN` contains no `SCAN` or `TEMP B-TREE` where the finding named one; list results and order are unchanged against a fixture; for D1–D3, a delete leaves no row with the deleted id in the named child tables. A1 and A2 also rerun the fixture timing above and must show the stated order of improvement. Do not run `bun run build`.

## Suggested order for a from-scratch baseline

Schema first, in one pass: E1 (session split), A1 (`span_texts`), A2 (stored root measures), D1 (foreign keys and `retained_until`), D2 (revision retention), E2, E3, E5, B4 and C1/C2/C7 (the index set), E4, E6. Then the query and write-path changes that read the new shape: A3, A4, B1–B3, C3–C6, D3, D4. Generate one baseline migration per engine at the end; do not keep the history.
