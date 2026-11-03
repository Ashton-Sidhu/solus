# Plan 024: Store lead status on session state

Status: TODO. Priority P2. Effort M. Risk MED. Category tech-debt.
Planned at `c4c64aff2`, 2026-11-01. No functional dependency; serialize generated
migration changes before 025 and 026. Table delta: −1.

## Current state and intent

`data/sessions/lead-sessions.ts:16` inserts `(session_id, created_at, organization_id)`
into `session_leads` with `ON CONFLICT(session_id) DO NOTHING`. A positive cache
avoids repeated reads. A miss is re-read because the mark can arrive later.
`data/sessions/session-records.ts:80` projects lead status using
`EXISTS(SELECT 1 FROM session_leads WHERE session_leads.session_id = session_records.session_id)`.
`session_states` already supports rows before `session_records` exists.

Add nullable `lead_started_at` to `session_states`. Do not require earlier session
record creation for this step. Admission consolidation is not part of this plan.

## Scope

Paths below are under `packages/server/src/`: `data/sessions/schema.ts`,
`lead-sessions.ts`, `session-records.ts`, `session-states.ts` (the latter three in
`data/sessions/`). Include `db/schema/sqlite.ts` and `db/schema/postgres.ts`,
whose named exports must stop referencing the removed declaration. Include
generated `packages/server/drizzle/{sqlite,postgres}/`
SQL, snapshots and journals; `tests/unit/lead-sessions.test.ts`,
`session-record-repository.test.ts`, `session-states.test.ts`,
`data-model-consolidation.test.ts`; and `docs/database-schema.md`.
Keep run-launcher and orchestrator public helper signatures unchanged.

## Steps and gates

1. Check HEAD and working-tree drift against `c4c64aff2` for scoped paths. Read
   `tests/unit/lead-sessions.test.ts`: repeated marking preserves the first mark,
   including a later different organization argument. Preserve this behavior.
2. Add `lead_started_at` via `bigint()` in the existing `defineTable` declaration.
   Remove `sessionLeads` from the active schema export/registry. Use the existing
   `sessionStates` declaration as the portable schema exemplar.
3. Change mark to insert/upsert state, setting only
   `lead_started_at = COALESCE(session_states.lead_started_at, excluded.lead_started_at)`.
   Do not replace organization, settle/read fields, or execution preferences.
   Retain positive-cache and recheck-on-miss behavior. Change lead reads and all
   list projections to the new field. Reuse existing state joins where present;
   standalone record reads still need a narrow state lookup/projection.
4. Check every state writer uses named columns and cannot clear the mark.
   Generate with `bun run db:generate --name session_lead_state`; review both
   dialects. No backfill. Do not modify generated snapshots by hand or change old
   baselines. The final fresh schema must omit `session_leads`.
5. Add tests: mark before record; first timestamp survives repeat; lead then
   prompt/settle/unread/preferences; state then lead; cache reset; list projection;
   record disappearance does not erase the surviving state mark. Keep organization
   immutable on conflicting repeated marks. Update schema docs.

After schema generation and steps 4–5 run:
`bun scripts/test-unit.ts lead-sessions.test.ts session-record-repository.test.ts session-states.test.ts data-model-consolidation.test.ts`.
Expected: all pass. Run `bun run --cwd packages/server check` and scoped oxlint;
no new errors in edited paths. Inspect generated SQL for both engines; SQLite
tests alone do not prove PostgreSQL races.

## Completion and limits

No source reads `session_leads` except historical migrations; final schema has
one fewer table. Contracts and provider behavior stay unchanged for Claude and
Codex, across all clients. Stop on changed first-mark ownership semantics,
new state-deletion behavior, or schema drift. No builds, live database use,
servers, commits or PRs. Preserve unrelated work. Update the plan index with
tests and remaining PostgreSQL limits. Future session-state writes must preserve
the permanent lead timestamp.
