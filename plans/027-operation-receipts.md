# Plan 027: Share atomic operation receipts

Status: TODO — independent review corrections incorporated. Priority P1. Effort M–L.
Risk MED–HIGH. Category correctness/tech-debt. Planned at `c4c64aff2`, 2026-11-01.
Execute after 026 to serialize generated migrations. Table delta: −2.

> **2026-11-10.** [Provider-owned tasks](../docs/plans/provider-owned-tasks.md) replaced the task model. GitHub and Jira own every task; Solus has no local task, no task in an organization and no task sharing. In this plan, the task create receipt is history: Solus creates a task on GitHub or Jira, not through the `/v1` API.

## Intent and current code

Replace `workspace_api_receipts`, `applied_ops`, and `webhook_seen_keys` with one
typed, engine-neutral receipt store. All claim a durable unique identity before
work, but retain different duplicate and expiry rules.

`packages/server/src/data/workspace/receipts.ts:29` performs two expiry deletes,
an insert-on-conflict, domain creation, and a result-ID update in one Records
transaction. A duplicate re-reads the resource with current authorization.
`sync/outbox/outbox-store.ts:184` calls `getDatabase().transaction()` but checks
and inserts `applied_ops` through Host `getDb()`. Those differ on PostgreSQL.
`data/webhooks/webhook-store.ts:160` conditionally reclaims an expired key.
`execution/webhooks/receiver.ts:163` commits claims before inserting the pending
delivery, leaving a crash gap. Fix that boundary without claiming exactly-once
external execution.

## Target schema and policies

New Records table `operation_receipts`:
`scope TEXT NOT NULL`, `namespace TEXT NOT NULL`, `key TEXT NOT NULL`
(composite PK), nullable
`request_hash`, `result_id`, `expires_at`; partial expiry index on non-null expiry.
Use explicit typed namespace definitions, not arbitrary payloads or caller-supplied
retention. Namespace encodes create kind so task/work/comment results cannot mix.

* API create: scope is current authority; namespace is create kind; key is retry
  key with unambiguous encoding/hash. Matching fingerprint required, 24-hour TTL,
  result ID only. A duplicate must re-run the authorized resource read; never
  cache response bodies or replay deleted/private content.
* Applied operation: scope is the literal `courier-owner`, namespace is the
  literal `applied-operation`, and key is the
  existing globally unique operation ID. Never derive scope from the currently
  signed-in person: identity can change before a retry. No TTL without a defined
  replay horizon. Presence means committed apply.
* Webhook: scope is webhook ID, namespace distinguishes delivery ID/replay key.
  Keep the existing 25-hour/seven-day TTL constants. Expiry permits reuse.

Receipt and protected domain write must use the same `Db` transaction. No host
guard write alongside a PostgreSQL domain write. Claim with conditional insert
or expired-row replacement and RETURNING; rollback removes a winning claim.
Separate scoped commands implement duplicate policies; do not build a universal
operation/lifecycle framework. Keep cursor, queue and exchange tables unchanged.

## Scope

Under `packages/server/src/`: new `data/receipts/schema.ts` and store;
`data/workspace/receipts.ts` and schema exports; `data/webhooks/schema.ts` and
`webhook-store.ts`; `execution/webhooks/receiver.ts`; `sync/outbox/outbox-store.ts`;
`db/schema/index.ts`; `db/migrations.ts` for retiring the Host guard; immediate
schema re-exports. Generated SQL/journals/snapshots for both Records engines.
Tests: new `tests/unit/operation-receipts.test.ts` and socket-free
`tests/unit/webhook-receipts.test.ts`; `work-write-paths.test.ts`,
`dispatch-parity.test.ts`, current webhook receiver/API/outbox tests,
consolidation schema test. Include `boot-server.ts` solely to replace the current
hourly `sweepSeenKeys` callback with the shared bounded expiry sweep. Include
`db/schema/sqlite.ts` and `db/schema/postgres.ts` explicitly: both generators
require named exports. Docs: `docs/database-schema.md`.
Exclude cloud auth, delivery protocols, clients, public API shapes, and unrelated
outbox cleanup. Preserve other contributors' working changes.

## Steps and gates

1. Read scoped HEAD and working diff against `c4c64aff2`. Read `tests/preload.ts`
   and `scripts/test-unit.ts` before tests. Baseline focused receiver and API tests
   below. Record failures before changes; do not bypass the safety preload.
2. Add typed schema and transaction-required claim/store operations. Register
   exports, then generate the additive migration with
   `bun run db:generate --name add_operation_receipts` before running tests;
   runtime initialization uses generated SQL, not schema declarations alone.
   Keep old tables until their callers have moved. Create the new receipt test
   suite now; run `bun scripts/test-unit.ts operation-receipts.test.ts`.
   Test claim
   winner/duplicate, namespace isolation, exact expiry boundary, fingerprint
   mismatch, rollback, and null expiry. One namespace must not expire another's
   permanent receipt. Reject null identity fields in both engines. Replace the
   hourly sweep in `boot-server.ts:1473` with a shared sweep of at most 1000 expired
   rows per call ordered by expiry and full receipt key, excluding null expiry.
   Keep the existing timer cadence and lifetime. This owner sweeps API and webhook
   namespaces; key-specific expired replacement still works between sweeps.
   Test mixed namespaces, the batch cap, and permanent-receipt retention. Do not
   add another timer or a background service.
3. Switch API creates. Keep resource kind in namespace, current authorization on
   readback, and result completion in the transaction. Test retries after deleted
   resources, revoked visibility, failure during creation and lost response.
   Prove namespace-only result-kind isolation: use the same authority and retry
   key for task/work/comment, with equal fixture result IDs, and verify that each
   duplicate reaches only its matching authorized reader. A separate result-kind
   column is unnecessary only while this typed namespace rule is enforced.
4. Switch applied operations: insert claim in the same Records transaction
   before applying. Resolve/validate the applier and preserve permanent versus
   transient failure handling. A failed domain write rolls back its claim. A
   duplicate committed operation reports applied without changing the resource.
   Replace the SQLite-only `receipt_unavailable` trigger test in
   `tests/unit/work-write-paths.test.ts:250`: its old table and after-apply order
   disappear. Use a test applier that writes real domain state and then throws;
   assert that both state and claim roll back and retry succeeds. Keep the real
   work-update duplicate test proving that replay does not create another revision.
   Change the acting owner/account context between apply and retry; it must still
   recognize the same committed operation ID and skip the applier.
5. Switch webhook key claims. Commit key decisions and the accepted or duplicate
   delivery record together. Preserve the existing behavior that a new delivery
   ID can be consumed even when its replay key duplicates prior work. Emit events
   and schedule `runDelivery` only after commit. Keep external dispatch recovery
   policy unchanged; this work does not close crashes after commit but before
   dispatch. Use `afterDatabaseCommit` (or the existing outermost commit mechanism):
   returning from a nested transaction does not mean the outer one committed.
   Create socket-free `webhook-receipts.test.ts` with these named cases:
   (a) pending-delivery insert fails after claims: all new claims roll back and
   retry is accepted; (b) new delivery ID plus old replay key: duplicate log and
   new ID commit, and retrying that ID with a fresh replay key stays duplicate;
   (c) successful receive inside an outer transaction followed by rollback: no
   receipt, delivery log, event or scheduled action escapes. Duplicate branches
   return decisions, not exceptions that undo intended consumed IDs.
   Delete a webhook's receipts by explicit scope, not a LIKE prefix.
6. Remove active old table exports. Append a Host migration dropping `applied_ops`.
   Generate Records migrations with `bun run db:generate --name operation_receipts`.
   No backfill. Assert the final fresh schema has one new receipt table and none
   of the three old tables. Update docs with engine ownership and policy rules.

After step 2 run its receipt suite; after steps 3–4 run the command below without
the not-yet-created `webhook-receipts.test.ts`; after step 5 run the full command:
`bun scripts/test-unit.ts operation-receipts.test.ts webhook-receipts.test.ts solus-api-records.test.ts work-write-paths.test.ts dispatch-parity.test.ts outbox-changed.test.ts`.
Expected: all pass, including rollback/replay cases. After schema removal include
`tests/unit/data-model-consolidation.test.ts`. Use existing isolated fixtures in
`tests/unit/helpers/test-db.ts`; never reuse a real DATABASE_URL.
The runner forces SQLite by default and isolates module mocks per file. The full
`webhook-receiver.test.ts` opens a listening socket; use only its existing
socket-free group here:
`env -u DATABASE_URL -u SOLUS_TEST_DATABASE_URL BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test tests/unit/webhook-receiver.test.ts --test-name-pattern 'webhook receiver check order'`.
Expected: selected group passes, route group does not run. Do not start a server
as part of this plan.

PostgreSQL gate: `bun scripts/test-unit.ts --engine=postgres operation-receipts.test.ts webhook-receipts.test.ts solus-api-records.test.ts work-write-paths.test.ts dispatch-parity.test.ts outbox-changed.test.ts`.
This requires an explicitly approved disposable PostgreSQL admin endpoint via
`POSTGRES_ADMIN_URL`; the runner creates per-file databases. Do not infer that an
ambient endpoint is safe, start a database server, or print its URL. If unavailable,
record NOT TESTED and do not claim PostgreSQL concurrency proof. The new suite
must exercise two independent connections and deterministic barriers for same-key
claims, rollback, expired replacement and lost responses. SQLite serialization
or Promise.all on one reused transaction does not prove that behavior.

Run server `check` and scoped oxlint; no introduced edited-path errors. Review
generated SQL in both dialects and verify no cross-engine guard writes remain.

## Done and stop rules

Done requires policy-equivalent responses, atomic receipt/domain writes, no
events or dispatch before commit, correct expiry, and two fewer final tables.
Record unrun gates separately. Stop if an applier changes external state inside
the assumed atomic transaction, if replay keys need a different owner scope,
or if receipt identity cannot remain stable across retries. Do not silently
invent a TTL or use one acknowledgement policy everywhere. No live migrations,
builds, servers, commits or PRs. Future namespaces must define key identity,
transaction owner, duplicate response and replay horizon.
