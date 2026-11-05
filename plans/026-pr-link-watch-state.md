# Plan 026: Keep watch state on the session PR link

Status: TODO. Priority P2. Effort M. Risk MED. Category tech-debt/perf.
Planned at `c4c64aff2`, 2026-11-01. Execute after 025 to serialize schema changes.
Table delta: −1. No product or transport contract changes.

## Current state

`data/sessions/schema.ts` gives PR links and watches the same composite identity:
`(session_id, repository, number)`. `prs/start-pull-request-watch.ts:17` refuses a
watch without a live link. `readSessionPullRequests` reads links and then all
matching watches just to construct each link's watch start time. Stale results
are guarded by `watch_id`; restarting generates a new UUID.

Current update is `UPDATE session_pull_request_watches SET state = ... WHERE watch_id = ...`.
Keep this generation rule, but also use the known parent composite key.

## Target and scope

Add nullable `watch_id`, `watch_started_at`, `watch_actor_key`, `watch_state` to
`session_pull_requests`. Add a partial active-watch index on `watch_id` where
non-null. ID/time/state are either all set or all clear; actor may be null. A
dismissed link cannot be watched. Enforce these through all typed writes and
database CHECKs if supported. `defineTable` currently has no CHECK option: do
not assume one exists. A narrowly scoped extension with generator tests is
permitted only if needed to preserve checks across generation; no broad DSL work.

Scope: session schema, `db/schema/sqlite.ts`, `db/schema/postgres.ts` (remove
the retired named exports), `pull-request-watches.ts`, `session-pull-requests.ts`,
`prs/start-pull-request-watch.ts`, immediate watcher callers/tests that assume a
watch may exist without a link, portable schema CHECK support only as above,
generated SQL/snapshots/journals, schema docs. Tests: `pr-watcher.test.ts`,
`pr-watch-rules.test.ts`, `session-pull-requests.test.ts`, new
`pr-link-watch-state.test.ts`, consolidation test. Server paths are under
`packages/server/src/`; tests under `tests/unit/`.

## Steps

1. Inspect HEAD/working diff against `c4c64aff2`, especially start/stop/unlink and
   branch replacement. Run current watcher, rules and link tests before edits.
2. Add fields/index and generate the additive migration with
   `bun run db:generate --name add_pr_link_watch_state` before testing the new
   writes. Keep the old table until its callers have moved. Create
   `pr-link-watch-state.test.ts` now. Rewrite start as a guarded update of an existing live link,
   returning the started watch. Preserve high-level outcomes for missing, settled,
   closed/merged/missing PRs. Do not create a phantom link to satisfy a low-level test.
3. Stop clears watch fields. End/update require parent key plus generation.
   Restart replaces generation. Unlink and branch replacement clear old watch
   state atomically while preserving dismissal tombstones and source precedence.
4. List watches with a non-null watch predicate. Ordinary link lists project
   only start time and do not parse watch JSON. Remove the second watch query and
   map construction. Keep watch evaluation, actor identity and notifications.
5. Remove the watch table export and generate both migrations with
   `bun run db:generate --name pr_link_watch_state`. No backfill. Add schema and
   behavior tests and update docs.

After steps 3–5:
`bun scripts/test-unit.ts pr-link-watch-state.test.ts pr-watcher.test.ts pr-watch-rules.test.ts session-pull-requests.test.ts data-model-consolidation.test.ts`.
Expected: all pass. Explicit cases: old result after stop/restart/unlink changes
zero rows; two sessions watch the same PR independently; dismissal prevents
rediscovery; actor retained; ordinary link read uses one query without baseline
JSON. Check EXPLAIN for active-watch scan and parent/generation update. Run server
`check` and scoped oxlint; no introduced errors.

## Done and safety

One fewer final table, same public watch capability on every client/provider,
one link-list query instead of two. No source access to the retired table outside
historical DDL. Do not merge PR observations or generic relationships in this
step. Stop if direct watch creation without a link is a real product path,
generation checks cannot be preserved, or branch cleanup has unexplained behavior.
No builds, servers, live data, commits or PRs. Update the plan index. Future link
deletion/replacement must clear watch fields in the same transaction.
