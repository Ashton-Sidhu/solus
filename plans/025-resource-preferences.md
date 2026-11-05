# Plan 025: Share personal session and task preference storage

Status: TODO. Priority P2. Effort M. Risk MED. Category tech-debt.
Planned at `c4c64aff2`, 2026-11-01. Execute after 024 for ordered schema generation.
Table delta: `session_views` + `task_snoozes` → `resource_preferences`, net −1.

## Current state and required behavior

`data/sessions/session-states.ts:213` and `data/tasks/task-snoozes.ts:49` store the
same person/resource wake time and trimmed note. Session views also contain
personal settle/archive. `SessionViewer.returnToList` deliberately creates an
empty row: `session-records.ts:151` treats that row as participation. Task wake
deletes its row; an expired task snooze is retained until explicitly woken.
These are required semantics, not empty data to clean up.

Current task write:
`ON CONFLICT (task_id, person_key) DO UPDATE SET snoozed_until = excluded.snoozed_until, snooze_note = excluded.snooze_note`.
Current session membership predicate includes `session_views.person_key IS NOT NULL`.

## Target model

Use `defineTable` in new `packages/server/src/data/preferences/schema.ts`:
organization_id, resource_kind (`session` or `task`), resource_id, person_key,
settled_at, archived_at, snoozed_until, snooze_note. Composite PK includes all four
identity fields. Add person/kind/resource lookup and a partial person/kind/wake-time
index for non-null snoozes. Name the actual page/list query each index serves;
ANY_ORGANIZATION reads must not depend on an organization-leading index alone.
Use typed commands and named columns, not an open JSON settings object.

## Scope

New preferences schema/store; `db/schema/index.ts`, `db/schema/sqlite.ts`,
`db/schema/postgres.ts` (both generators read explicit named exports); task/session schemas and
their snooze/view stores; `data/sessions/session-records.ts`; task deletion in
`data/tasks/task.ts`; generated SQLite/Postgres migrations; existing
`task-snoozes.test.ts`, `session-states.test.ts`, `session-list-query.test.ts`,
new `resource-preferences.test.ts`, consolidation schema test, database docs.
All server paths are under `packages/server/src/`, tests under `tests/unit/`.
Do not change pins, shared read boundaries, task status, execution preferences,
RPC response/event contracts, clients, or account sync policy.

## Steps and verification

1. Compare scoped source and working diff with `c4c64aff2`. Run the existing three
   focused tests below. Read `task.ts:moveTo` and `delete`: move currently retains
   snoozes; deletion cascades them. Preserve that distinction.
2. Register the new schema and both dialect exports. Generate the additive
   migration with `bun run db:generate --name add_resource_preferences` while
   keeping the old tables. Create `resource-preferences.test.ts` now; use real
   generated schema initialization, not test-only CREATE statements.
   Implement typed preference writes with explicit
   session/task kind, organization, resource and person. Keep domain authorization
   in task/session commands. Do not let a generic store infer access permission.
3. Move both stores and session candidate/page joins to the new table. Qualify
   every join by kind and organization as well as ID/person. Retain empty session
   rows, personal event routing, note normalization, and current reply shapes.
   Updates touch only named preference fields. Reuse portable RETURNING where it
   removes readback, without creating no-op command wrappers.
4. Replace the lost task FK cascade with explicit preference deletion in the
   task-delete transaction. Leave task move and session-record disappearance
   behavior unchanged. Remove the old schema declarations and exports.
5. Generate both dialects using `bun run db:generate --name resource_preferences`.
   No backfill required. Add tests for same IDs across kinds, two organizations,
   two people, empty participation, prompt reset, expired snoozes, delete versus
   move, rollback, and disjoint concurrent archive/snooze updates. Add schema
   assertions and document ownership.

After steps 3–5:
`bun scripts/test-unit.ts resource-preferences.test.ts task-snoozes.test.ts session-states.test.ts session-list-query.test.ts data-model-consolidation.test.ts`.
Expected: all pass and page inclusion/order is unchanged. Compare SQLite EXPLAIN
for the existing candidate query and new query using representative fixtures;
reject a per-session query loop. Run server `check` and scoped oxlint; no new
edited-path errors. PostgreSQL concurrent tests need a disposable test database;
mark that gate incomplete if unavailable.

## Done, stop and maintenance

Final fresh schema replaces two tables with one; existing client contracts work
unchanged. Stop if a preference gains new sync/visibility behavior, a cleanup
would remove empty session rows, or another owner deletes tasks outside the
audited path. Discover and include any actual deletion caller before proceeding.
No live data, builds, servers, commits or PRs. Update `plans/README.md` with
evidence. Future preference kinds must define ownership, cleanup and index use.
