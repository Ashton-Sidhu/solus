# Plan 023: Store the browser default on its profile

Status: TODO. Priority P2. Effort M. Risk MED. Category tech-debt.
Planned at `c4c64aff2`, 2026-11-01. Execute after 022 to serialize Host DDL edits.
Table delta: −1. No backward compatibility or data backfill is required.

## Intent and current state

`packages/server/src/browser/browser-profiles.ts:53` reads profiles, then reads
`browser_profile_defaults` for the same owner/project. `deleteBrowserProfileRow`
deletes both rows. `setBrowserDefaultProfile` either deletes the pointer for the
built-in profile or upserts it for a named profile. Current identity is
`PRIMARY KEY (owner_key, project_root, profile_id)`; the default pointer uses
`(owner_key, project_root)`. Cookie partitions depend on profile IDs, not this
pointer. A missing default means the built-in profile.

## Scope

Only `packages/server/src/db/migrations.ts`,
`packages/server/src/browser/browser-profiles.ts`,
`tests/unit/browser-profiles.test.ts`, `tests/unit/data-model-consolidation.test.ts`,
and `docs/database-schema.md`. Keep cookie cleanup, profile identity, contracts,
renderer state, and host transport unchanged. Follow `withTx` in
`packages/server/src/db/index.ts` and current profile parsing/ownership checks.

## Steps

1. Compare `git diff --stat c4c64aff2..HEAD -- packages/server/src/browser/browser-profiles.ts packages/server/src/db/migrations.ts`
   and the working diff to this description. Run the existing profile test below
   before edits; all must pass or record the pre-existing failure.
2. Append a Host migration: add `is_default INTEGER NOT NULL DEFAULT 0` to
   `browser_profiles`; create a unique partial index on `(owner_key, project_root)`
   where `is_default = 1`; drop `browser_profile_defaults`. Keep prior slots.
   No preservation of existing defaults is required by this fresh-DB task.
3. Include the flag in the existing profile query and parser. Derive the selected
   profile from those rows, falling back to the built-in profile. Do not add a
   second query or change the returned `BrowserProfileSet`.
4. Set the default inside one `withTx`: validate the named profile in that
   owner/project, clear the old flag, then set the new flag. For the built-in
   profile clear flags only. Failure must roll back the clear. Profile deletion
   now deletes one row; keep the caller's cookie-cleanup-before-row-delete rule.
5. Extend tests for owner/project isolation, built-in fallback, deletion of the
   selected profile, invalid selection preserving the prior default, rollback,
   and direct attempts to set two defaults rejected by the unique index.
   Add final-schema assertions to the consolidation test and update docs.

## Commands and done criteria

After steps 2–5 run:
`bun scripts/test-unit.ts browser-profiles.test.ts data-model-consolidation.test.ts`.
Expected: all pass; one default per owner/project, old pointer table absent.
Run `bunx oxlint packages/server/src/browser/browser-profiles.ts tests/unit/browser-profiles.test.ts`.
Expected: no introduced errors. Run `bun run --cwd packages/server check`; report
pre-existing errors separately and accept no new errors in changed paths.

No UI behavior change is intended on desktop, web or mobile. Do not start a
browser/server, build, touch live data, commit, or open a PR. Stop if selecting a
default can name a profile outside the existing list or requires changing cookie
partition identity. Keep the unique constraint when adding future profile fields.
Record completion and verification in `plans/README.md`.
