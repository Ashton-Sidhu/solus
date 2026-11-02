# Plan 022: Remove unused saved prompt storage

Status: TODO. Priority P2. Effort S. Risk LOW. Category tech-debt.
Planned at `c4c64aff2`, 2026-11-01. Dependencies: none. Table delta: −1.

## Intent and current state

`packages/server/src/db/migrations.ts:136` creates `saved_prompts`, followed by
`saved_prompts_by_project`. Searches of server, contracts, clients and unit tests
found no application reader or writer. Remove the final table without replacing
it with KV storage. This saves schema maintenance; no latency gain is claimed.

Current DDL starts with `CREATE TABLE saved_prompts (`. This is a Host SQLite
table, not a ported Records table. Host migration slots are append-only. The
user permits a fresh database and requires no backfill; that does not authorize
opening, deleting, or migrating their live data.

## Scope and conventions

Modify only `packages/server/src/db/migrations.ts`, a new
`tests/unit/data-model-consolidation.test.ts`, and `docs/database-schema.md`.
Match the existing migration array and the isolated SQLite fixture pattern in
`tests/unit/browser-profiles.test.ts`. Do not change saved metrics queries,
prompt UI, cloud schemas, or unrelated migration slots.

## Steps and verification

1. Run `git diff --stat c4c64aff2..HEAD -- packages/server/src/db/migrations.ts`
   and inspect the working diff as well. Repeat the scoped runtime-use search.
   Expected: only historical DDL refers to this table. If a live caller exists,
   stop and revise this plan.
2. Append a Host migration that drops `saved_prompts`. Its index disappears with
   the table. Do not rewrite all baselines or delete migration history.
3. Add a fresh-schema test that runs the complete Host migration array against
   an owned in-memory database and asserts that this table and index are absent,
   while `saved_metrics_queries` and `kv` remain. Use `sqlite_master`; do not count
   historical CREATE statements as current tables.
4. Document the removed unused table and the distinction between logical tables
   and engine/migration bookkeeping.

Verify steps 2–4 with:
`bun scripts/test-unit.ts data-model-consolidation.test.ts`.
Expected: all assertions pass. Run `bunx oxlint packages/server/src/db/migrations.ts tests/unit/data-model-consolidation.test.ts`;
expected: no introduced lint failures.

## Done and stop rules

Done means the fresh final schema has no saved-prompts table/index, no active
caller was removed, and focused tests pass. Update the plan index with evidence.
Do not run builds, servers, full test suites, migrations against live files,
installs, commits, or PR creation. Preserve other working-tree changes. Stop if
the migration history has drifted, a reader is discovered, or unrelated changes
are required. No client behavior changes; desktop, web and mobile contracts stay
the same. Future saved-prompt features must select storage from their queries.
