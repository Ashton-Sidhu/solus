# Workspace API validation

Verified on 2026-09-28 against isolated fixtures. No live Solus database, user
credentials, or provider accounts were used. No application build, deployment,
or interactive client run was performed.

## Passed

- Generated contract drift check: `bun run api:check`.
- TypeScript checks of `packages/contracts` and `packages/client-core`; the
  `packages/server` and `packages/lab` checks report only errors that predate
  this work, in files this work does not touch.
- Targeted lint of the contract, admission, data, HTTP, boot, client, and lab files.
- Focused SQLite suite: `tests/unit/solus-api-{auth,records,insights,service}.test.ts`,
  18 tests passing; the two PostgreSQL-only tests are skipped without `SOLUS_DB=postgres`.

The tests cover offline paired-source admission and revocation, cloud refusal of
local credentials, source-expiry bounds, organization override rejection,
credential renewal, client context changes, per-record privacy before LIMIT,
shared-work editor/owner rules, idempotency/conflicting keys, stale writes,
transaction rollback and deferred events, read-only provider works, conditional
work polling, complete Unicode transcript fragments, a cursor that keeps its
first page's Insights window, a borrowed cursor showing only the caller's own
records, one source grant spent across service replicas, and the
data-only service booting without execution handlers.

## Not run

- PostgreSQL runs of the same suite; the previous verification ran them on a
  disposable PostgreSQL 17 container and the SQL these tests exercise is unchanged.
- The Lab scenarios (`packages/lab`), which need `bun run build:test`. They were
  moved from the removed record RPC methods to the record API and type-check; a
  refused resource now reads `NOT_FOUND` and a guest's list holds only their resource.
- Interactive desktop, web, and mobile QA.
