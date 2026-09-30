# Plan 007: Separate Data, Execution, Sync, and Transport

> **Pure structural refactor.** Preserve current product behavior, data, network
> contracts, authorization decisions, and defaults. All net-new behavior belongs
> in the original **Solus Cloud — Service Model: Cloud-Owned Collaboration,
> Host-Owned Execution** feature plan (work ID
> `de142de0-7fbf-4ed2-a7e6-4cb982a733f2`, revision 10).

## Status and purpose

- **Status:** IMPLEMENTED 2026-09-28 in the Solus working tree (uncommitted). See
  "Outcome" below for the layout that exists, the exceptions, and the evidence.
- **Priority / effort / risk:** P1 / L / medium.
- **Planned at:** Solus `bf4e8fe7`, solus-cloud `d879934`, with existing uncommitted work; scope revised 2026-09-27.
- **Category:** structural refactor.
- **Dependencies:** current behavior and tests only. No organization-policy,
  automation-home, historical-backfill, or provider-access decision blocks this refactor.
- **Supersedes:** structural guidance from deleted plans 005/006 and the earlier
  mixed feature/refactor version of 007. Do not restore the deleted plans.

Make existing responsibilities easier to find and change. Keep domain rules and
persistence together, give the execution coordinator an accurate internal name,
and separate transport from execution and delivery. Keep the current repositories,
runtimes, database adapters, RPC surface, and deployment arrangement.

The original feature plan now owns every behavior change previously included
here. The structural refactor must be reviewable and testable on its own.

## Fixed scope boundary

| Included here | Owned by the original feature plan |
| --- | --- |
| Move existing implementations and update their imports | Add organization fields, indexes, publication state, or new tables |
| Rename internal execution coordinator to SessionRuntime | Change organization assignment, inheritance, or access decisions |
| Document the existing workspace service as Solus API | Change service wire names, environment keys, URLs, grants, or directory shape |
| Group existing mirror/outbox code under Sync | Replace global routing, add destination partitions, change receipts or retry behavior |
| Group existing domain rules and persistence under Data | Add organization-managed Insights, client opt-in, attribution fields, or cloud queries |
| Separate current dispatch and transport mechanics | Add exhaustive authorization policy or new scope checks |
| Preserve and test current role-specific composition | Change which capabilities a role starts or exposes |
| Update mocks/imports and repair stale test fixtures | Add publication coordination, asset manifests, or upload-on-submit behavior |
| Add module-boundary and behavior-preservation tests | Add Local-plus-org filtering, new navigation, settings, or entry points |
| Update architecture maps for the new file locations | Add portable review results, cloud review jobs, or execution-host transfer |

A correctness fix that changes behavior is a separate feature/fix change, even
if discovered while moving code. Record it for the feature plan; do not hide it
in a rename. Known current behavior can remain as a documented temporary boundary
exception until the corresponding feature phase changes it.

## Names and module responsibilities

| Name | Existing responsibility to group here |
| --- | --- |
| Data | Domain validation/rules, record reads and writes, schemas and domain events |
| Execution | Provider adapters, session runtime, seats, checkouts and process lifecycle |
| Sync | Current mirror/outbox producers, delivery, intake and receipts |
| Transport | IPC/WS/RPC envelopes, admission invocation, dispatch and event transport |
| Solus API | Deployment currently called the workspace service |
| Control plane | solus-cloud accounts, memberships, host authority and provisioning |

Use `SessionRuntime` for the existing `ControlPlane` execution coordinator.
Keep user-facing “workspace,” “host,” and other product terms. “Solus API” is a
documentation and internal naming change here; existing configuration keys,
wire literals, routes, audit event names and persisted identities stay intact
until the feature plan's coordinated contract change.

Update 2026-09-30: with no users yet, the deployment names changed too. The
environment key is `SOLUS_API`, the grant audience `urn:solus:api`, the Fly app
`solus-sh-api`, the control plane's key `SOLUS_API_URL`, and the API's `mode`
`solus-api`. The organization's *workspace* keeps its names (`workspace:<orgId>`,
`/v1/hosts` `workspaces`, `/v1/workspace/*`), and so does the
`workspace_api_receipts` table.

Do not create a repository/service/controller stack per domain. A small domain
can keep persistence and rules in the same module. Same-process calls remain
direct; no new internal RPC or deployment.

Intended dependency direction: Execution and Sync use Data; Transport dispatches
to the current domain/runtime operations; boot composition wires them together.
Data can use contracts, database infrastructure and domain events. It should not
depend on sockets or provider processes. If an existing dependency cannot be
removed without changing behavior, retain a named exception and assign its
removal to the original feature plan.

## Current evidence and bounded move map

Paths below are relative to `packages/server/src/` unless stated otherwise.
Read exports, immediate callers and tests before each move. These are ownership
boundaries, not an instruction to move every mixed folder wholesale.

| Current source | Structural target / limit |
| --- | --- |
| `sessions/session-records.ts`, `sessions/schema.ts`, `mirror/transcript-reads.ts` | `data/sessions/`; preserve row mapping, fields, SQL and events |
| `tasks/task-store.ts`, task links/sessions/sharing/events, `tasks/schema.ts` | `data/tasks/` where dependencies permit; preserve current joins and access behavior |
| `folio/works.ts`, `folio/work-annotations.ts`, `folio/schema.ts` | `data/works/`; preserve snapshot/import/removal behavior |
| `automations/automations-store.ts` | `data/automations/` if separable without changing schedule storage or behavior |
| Current durable observation tables/reads | `data/insights/`; no new fields or cloud query capabilities |
| `mirror/schema.ts` | Table definitions may move to owning domains; emitted schemas and table registration order must remain identical |
| `control-plane.ts` and existing runtime helpers | `execution/session-runtime.ts` and focused subfolders; rename class/imports, preserve methods and lifecycle |
| `agents/` and runtime-only session helpers | `execution/`; preserve provider behavior and generated provider file paths |
| `mirror/`, `outbox/outbox-store.ts`, runner delivery/protocol/intake | `sync/`; preserve all payloads, gates, sequence allocation, acknowledgements and errors |
| `server/server.ts`, `server/handlers/`, IPC/WS mechanics | `transport/`; preserve registration, dispatch order and admission behavior |
| `server/principal.ts`, `server/access-policy.ts` | Shared admission module if needed for dependencies; move existing rules unchanged |
| `db.ts`, `db/`, `platform/`, `boot-core.ts` | Keep existing infrastructure and boot entry; update imports/composition only |

Current fields in `sessions/schema.ts`:

```ts
organization_id: text({ notNull: true, default: 'local' }),
owner_user_id: text(),
runner_host_id: text(),
```

Current routing in `server/principal.ts`:

```ts
if (principal.hostKind === 'personal' || principal.hostKind === 'managed') return LOCAL_ORGANIZATION_ID
return principal.organizationId
```

Current mirror gate in `mirror/mirror-log.ts`:

```ts
export function mirrorEnabled(): boolean {
  return cloudOwnedOrganization() !== null
}
```

The original feature plan replaces the latter two behaviors. **This plan does
not.** Move them with their tests so the behavioral change is separately visible.

Other limits:

- `tasks/host-records.ts` reads host-local session indexes. Preserve that behavior;
  replacing it with canonical record reads belongs to feature implementation.
- `folio/work-sync.ts` integrates Google Docs/Confluence. It is not host-to-API
  Sync. Do not move it merely because its name contains “sync.”
- Review guide/lens stores currently include checkout caches. Do not turn them
  into cloud records during this refactor.
- Keep existing Data-to-delivery notification timing, including transaction
  commit behavior. Composition may receive an existing callback/event dependency
  only when tests show identical timing and failure semantics.
- Do not split large files solely for length. The maintainer explicitly excluded
  mechanical file-size cleanup.

## Stage 0 — Capture current behavior

1. Read both repositories' instructions. Record current status, including
   uncommitted work. Never revert, stash, or overwrite another change.
2. Compare current source with the evidence above:
   `git diff --stat bf4e8fe7..HEAD -- packages apps tests` in Solus and
   `git diff --stat d879934..HEAD -- src` in solus-cloud.
   Include working-tree diffs in the review; HEAD alone is not the baseline.
3. Repair the stale `works-store-move-to-cloud.test.ts` fixture to use current
   `worksCloudExport/worksCloudImport/worksCloudRemove` calls. Do not change
   product behavior to fit old mocks.
4. Run the baseline tests and affected package checks below. Record unrelated
   pre-existing diagnostics. Changed paths must have no new diagnostics.

**Gate:** baseline tests pass, or a specific pre-existing failure is recorded
and isolated. Do not use the stale fixture as evidence until repaired.

## Stage 1 — Group current Data implementations

1. Move the separable record/schema modules from the map. Update immediate
   importers, tests, registration and package references in the same change.
2. Preserve schema definitions, SQL, transactions, defaults, stored encodings,
   row projections, errors and events.
3. Keep existing mixed runtime dependencies as explicit exceptions when moving
   them would require a new feature operation. Do not create pass-through
   wrappers or replacement query behavior to make the folder tree look complete.
4. Update existing schema registration paths without altering registration order.

**Gate:** Data test subset and server/contracts checks pass. Compare generated
table definitions and SQL behavior before/after; no schema or query change.
Run changed adapter-sensitive tests with both SQLite and disposable Postgres.

## Stage 2 — Name and locate Execution

1. Rename `ControlPlane` to `SessionRuntime` and move it under Execution.
   Update types, construction sites, callers, test imports and mocks.
2. Move runtime-only helpers/adapters where this makes their responsibility clear.
   Preserve generated provider output paths and generation tooling.
3. Keep provider lifecycle, seat selection, prompt admission, title generation,
   cwd resolution, approvals, cancellation and event normalization unchanged.
4. Do not split the coordinator merely for size.

**Gate:** existing Claude/Codex runtime and observation tests plus server and
affected client/entry checks pass. New imports resolve without compatibility
re-export files; no provider behavior or emitted telemetry schema changes.

## Stage 3 — Locate current Sync and Transport

1. Move existing mirror/outbox/runner delivery code under Sync and update imports.
   Keep `cloud-ownership.ts`, current stream identity, gating and receipts
   unchanged until the feature plan replaces them.
2. Move current handler/transport mechanics under Transport. Preserve admission
   order, method classification, wire payloads, events, guest behavior and roles.
3. Put shared admission types where existing same-process callers can import
   them without pulling in WebSocket mechanics. Do not change policy decisions.
4. Update boot wiring and path-dependent mocks. Keep what each role initializes
   and exposes identical to the baseline.
5. Add `tests/unit/server-module-boundaries.test.ts` for the dependency boundaries
   actually achieved. Name remaining exceptions explicitly; do not weaken the
   test with a broad wildcard or claim all dependencies are separated.

**Gate:** mirror/intake/delivery/admission tests, boundary test, and package checks
pass. Current API-role startup and host-role startup retain the same capabilities
and side effects. A new role-initialization defect found here is a separate fix.

## Stage 4 — Reconcile consumers, docs, and both repositories

1. Update direct importers in desktop, standalone server, CLI, tests and client
   packages as required by moved symbols. Do not change UI or demo behavior.
2. In solus-cloud, update only actual source imports/types affected by this
   refactor. Its Effect/Workers/account architecture already has clear boundaries;
   do not impose the Solus server folder tree on it.
3. Use Solus API terminology in architecture documentation while explaining that
   old wire/config identifiers are unchanged. Update codebase maps to new paths.
4. Check the shared contract copy is unchanged and matches its source. Do not
   run a protocol bump or change service configuration under this plan.
5. Update the plan index with evidence and explicit dependency exceptions. Any
   unresolved behavior change stays in the original feature plan.

**Gate:** all relevant checks below pass or retain only documented pre-existing
diagnostics; focused moved-code tests pass; no schema, protocol, settings, auth,
delivery or UI behavior change appears in the diff.

## Verification commands

Run from `/Users/sidhu/solus`. Use the stage's relevant subset, not every test
after every edit. The isolated runner provides temporary data per file.

```sh
# Baseline.
bun scripts/test-unit.ts principal.test.ts access-policy.test.ts works-store-move-to-cloud.test.ts

# Data.
bun scripts/test-unit.ts session-records.test.ts task-store.test.ts work-export-payload.test.ts

# Execution.
bun scripts/test-unit.ts session-runtime-observability.test.ts session-runtime-claude-observability.test.ts agent-runner-observability.test.ts session-emitter.test.ts

# Sync and Transport.
bun scripts/test-unit.ts transcript-mirror.test.ts insight-mirror.test.ts mirror-sinks.test.ts runner-delivery.test.ts runner-intake.test.ts outbox-changed.test.ts principal.test.ts access-policy.test.ts

# New architecture test, after creating it.
bun scripts/test-unit.ts server-module-boundaries.test.ts

bun run --cwd packages/contracts check
bun run --cwd packages/server check
bun run --cwd packages/client-core check
bun run --cwd packages/workspace-ui check
bun run --cwd apps/client check
git diff --check
```

Expected: each selected test runs and passes; changed packages have no new
diagnostics. Update test filename filters if test files are renamed. Root
`bun run check` does not cover all these packages.

For moved database behavior, use the same runner with `--engine=postgres` and
an explicitly disposable `POSTGRES_ADMIN_URL`. Never use live database settings.
No migrations or resets are required for the refactor.

In solus-cloud run `bun run check` if consumers/types changed. Check contract
copy fidelity using Node-hosted Vitest and a disposable config outside the repos:

```js
export default {
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000
  }
};
```

```sh
# From /Users/sidhu/solus-cloud; substitute the real temporary config path.
SOLUS_REPO=/Users/sidhu/solus node node_modules/vitest/vitest.mjs run --config <config> src/lib/shared/uplink.test.ts src/lib/server/uplink/grants.test.ts
```

Expected: exit 0, selected tests pass, contract content unchanged. Remove the
temporary config afterwards. A refactor-only change should not require
`contracts:sync`; investigate a byte change rather than automatically accepting it.

Do not run builds, root test commands that invoke builds, development servers,
browser sessions, deploys, or live-data operations. No visual verification is
required when no UI behavior/markup changes; UI changes belong in feature work.

## Outcome (2026-09-28)

The layout under `packages/server/src/` after the move. Old folders are gone;
no re-export or alias file was left behind. Paths are server-relative.

| Area | Contents (former location) |
| --- | --- |
| `data/sessions/` | `schema`, `session-records`, `session-read-state`, `pinned-sessions`, `session-delegations`, `async-questions`, `claude-goal-store`, `session-lineage` (`sessions/`); `transcript-reads` and `transcript-schema` (`mirror/`); `result-projection`, `session-tool-inputs` (`server/`) |
| `data/tasks/` | all of `tasks/` except the agent tool |
| `data/works/` | all of `folio/` except the agent tools; `work-sync.ts` stays here (doc-provider sync, not host-to-API Sync) |
| `data/automations/` | `automations-store`, `automation-schedule` |
| `data/insights/` | `metrics-db`, `migrations`, `span-table`, `rollups`, `rollover`, `turn-page`, `turn-flags`, `saved-queries`, `query-compiler`, `sql-guard`, `nl-compile`, `field-registry`, `registries`, `trace-timing` (`observability/`); `insight-schema` (`mirror/schema`) |
| `data/assets/` | `assets`, `asset-paths`, `byte-range` (`server/`) |
| `execution/` | `session-runtime.ts` (`control-plane.ts`, class `SessionRuntime`); `agents/` (with every agent tool under `agents/tools/`: `session-tools`, `task-tools`, `work-tools`, `artifact-tools`, `automation-tools`, `insights-tools`, `config-tools`); `sessions/` (`pending-input`, `response-text-buffer`, `session-title`, `history-page`); `orchestration/` (`orchestrate-sessions.ts` was `control-plane-runtime.ts`); `seats/`; `automations/` (runner, scheduler, cwd, compose-prompt); `observability/` (emitter, tracer, exporter, timing, shutdown, pricing); `rate-limits`; `activity-leases` |
| `sync/` | `mirror/` (log, sinks, transcript and insight mirrors), `outbox/` (store, cloud-ownership, schema), `runner-delivery`, `runner-protocol`, `runner-intake` |
| `transport/` | `server`, `http`, `websocket`, `response-receipt-cache`, `endpoints`, `bind-policy`, `rate-limit`, `trusted-requesters`, `lan-discovery`, `ssh-bootstrap`, `attachment-utils`, `handlers/` (with `handlers/lib/ssh-options`, `temp-secret-script`), `events/`, `uplink/` (`connector`, `link`) |
| `admission/` | `principal`, `access-policy`, `auth`, `host-grants`, `signed-token` |
| `host/` | `settings`, `roles`, `managed-mode`, `workspace-mode` |
| `files/` | `file-finder`, `index-root`, `file-preview`, `file-browse`, `content-search`, `host-path`, `host-path-mutations`, `path-suffix-match`, `project-listing`, `project-mutations` |
| top level | `boot-server.ts` (was `server/index.ts`) beside `boot-core.ts` |

The mirror table definitions moved to their owning domains; `db/schema/index.ts`
registers `session_transcripts`, `insight_spans`, `insight_log_events` in the
same order as before, and the boundary test asserts that order. The
orchestrator's dependency interface was renamed `OrchestratedRuntime` so the
class could take the `SessionRuntime` name. The `file` and `tag` values the
runtime writes on its own log lines and dispatch steps now name
`session-runtime.ts`; no span service name, column, or field changed.

Tests named after the old class were renamed (`control-plane-*.test.ts` →
`session-runtime-*.test.ts`, and the two `*-control-plane.test.ts` files).
The test build alias for the mock backend registry, the Codex type generator
path, the tsconfig exclude, and the oxlint rule roots follow the new paths.

**Boundary exceptions** (`tests/unit/server-module-boundaries.test.ts`), each
assigned to the original feature plan:

- `data/tasks/task-applier.ts` and `data/works/work-applier.ts` register into
  `sync/outbox/outbox-store.ts` (the applier registry; scoped delivery work).
- `data/tasks/foreign-tasks.ts` reads pending outbox ops (scoped delivery work).
- `data/tasks/linked-content.ts` reads a live session through
  `execution/agents/tools/session-tools.ts` (publication work).

Known behaviors the plan keeps unchanged: `admission/principal.ts` still maps
personal and managed hosts to Local; `sync/mirror/mirror-log.ts` still gates on
the process-wide cloud-owned organization; `data/tasks/host-records.ts` still
reads host-local session indexes.

**Evidence.** Server typecheck: the same 152 pre-existing diagnostics before
and after (provider SDK type drift in `execution/agents/`; identical message
set). Contracts, CLI: clean. Client-core, workspace-ui, apps/client: only
pre-existing diagnostics, none naming the server package. `bun run lint` and
`bun run lint:rules` pass. Full unit suite: 805 files pass; the 34 failing
files fail identically at `bf4e8fe7` (missing `runed` package, Svelte runes
outside the compiler, `node:sqlite` in the runner, git and GitHub environment).
`git diff --check` clean. solus-cloud is untouched: `packages/contracts` has no
change from this refactor, so the contract copy is unchanged.

## Completion criteria

- Current implementations are grouped by responsibility and current callers use
  the new paths/internal names.
- Focused behavior-preservation tests and achieved-boundary tests pass.
- Existing schemas, wire contracts, route/config identifiers, permissions,
  defaults, queue semantics, provider lifecycle and visible behavior are unchanged.
- No new product feature is necessary to finish the refactor.
- No compatibility aliases or pass-through wrappers remain from file moves.
- Mixed-module exceptions are explicit, bounded, and assigned to feature work.
- Architecture maps and the index describe the structure that actually exists.
- No live data, deployment, source implementation or feature completion is
  claimed by writing this plan.

If a structural step requires changing a business rule or public contract,
keep that part where it is and record the dependency for the original feature
plan. Resolve routine import/typecheck failures normally. Ask for a product
decision only when feature work needs one, not to finish a behavior-preserving move.

Do not push, create a PR, or deploy without an explicit request. Keep each
structural unit reviewable; do not mix feature commits into the refactor.
