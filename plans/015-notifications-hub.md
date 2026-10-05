# Plan 015 v2: Build a simple notifications hub

## Status

- **Status:** PLAN v2, 2026-10-03. This replaces the v1 design in this file.
- **Baseline:** Solus `d1ae9bc43` plus the current, changing working tree. Notification and native mobile source now exist; their presence is not proof of completion.
- **Priority / effort / risk:** P1 / L / medium. Access control and correct source routing remain the main risks.
- **Dependencies:** Existing host/organization admission, record APIs, activity, and connections. Plan 017 owns the native client foundation. This plan owns notification behavior for all clients and the hub named by plan 004 D15/D16.
- **Scope of this revision:** Planning only. Do not modify or discard another agent's source work while revising this document. Implementation, native device verification, PR creation, and deployment are separate actions.

Read AGENTS.md and the live files below before implementation. Compare committed and uncommitted changes; never reset or stash another person's work:

```sh
git status --short
git diff --stat d1ae9bc43..HEAD -- packages/contracts packages/server packages/client-core packages/workspace-ui apps/client apps/desktop apps/mobile tests/unit plans
git diff --stat -- packages/contracts packages/server packages/client-core packages/workspace-ui apps/client apps/desktop apps/mobile tests/unit plans
```

## 1. The model

**One notification table at each record home, one shared client feed, and existing domain actions.**

```text
Domain operation → save notification → signal clients
                                         ↓
Client reads each authorized source → one merged hub
                                         ↓
                           existing resource/action flow
```

The SDK runs on the server. Notifications exist even when no client is open. Desktop reads its local host through IPC; web and mobile read hosts through their existing authenticated connections. The same Data implementation runs on standalone hosts, self-hosted APIs, and Solus Cloud.

| Event | Where its notification lives |
| --- | --- |
| Local work/task change | Its Local host |
| Work/task change saved by an organization API | That API |
| Automation finishes | The host that stores the run |
| Guide/lens finishes | The host that stores the result |
| Provider assignment observed | The server that performs the authorized provider refresh |

An agent calling the organization API creates the notification there through the normal domain operation. Its VM does not create a second copy. Host-owned automation and review results stay host-owned, including runs made for an organization. No notification summary replication is needed for this release.

The hub combines notifications addressed to the person across all authorized sources and organizations. This is a narrow exception to the selected-organization view filter. Resource access and credentials remain scoped. Other boards keep their existing filter.

A phone must be paired with a standalone host or authorized for the relevant service. It connects directly through the configured reachable route; the desktop is not a relay. Unreachable sources cannot provide new notifications. Already loaded rows may remain visible as stale, with source writes and source-dependent actions disabled. No persistent offline inbox is required.

## 2. Keep the scope small

| Keep | Remove from this release |
| --- | --- |
| Durable notification rows and event deduplication | Change journal, watermarks, replay protocol, and compaction worker |
| Normal history pagination | Offline receipt queue, conflict merge, and persistent client cache |
| Existing host connections and organization credentials | Cross-host notification replication and global duplicate grouping |
| Existing provider refreshes | New notification-specific polling service or webhook deployment |
| Existing review/task/automation commands | Notification action dispatcher, job ledger, and command recovery framework |
| Shared hub plus native presentation | New native push gateway, device registration service, and APNs/FCM infrastructure |

Read/archive state is server-owned. Use explicit set-read/set-unread and archive/restore operations, not toggles. Concurrent accepted changes to the same field use server order; a change to read state does not overwrite archive state. Do not persist or automatically retry writes after a failed or ambiguous response. Refetch and show the server's result before another user action.

Opening the hub does not mark every notification read. Opening an item can mark that item read. Reading or archiving does not approve a review, complete a task, or cancel work. Current action availability comes from the owning domain; no generic notification resolution state machine is needed.

## 3. Reuse the current work

The 2026-10-03 working tree already contains these implementations. Read and simplify them rather than building a second version alongside them.

| Current files | v2 treatment |
| --- | --- |
| `packages/contracts/src/notification-hub.ts` | Keep typed kinds, bounded facts, resource references, and list/state contracts. Remove journal/change-feed and queued-write requirements. |
| `packages/server/src/data/notifications/{schema,store,access,api-operations}.ts` | Keep recipient rows, validation, event uniqueness, and resource checks. Stop using the journal/counter and field-specific receipt revisions. |
| `packages/server/src/data/notifications/intents.ts` | Replace ongoing automation intent capture with a write to the notification table in the run's existing transaction. Reconcile already captured intents before retiring the old path. |
| `packages/client-core/src/notifications/{sources,server-link,hub-client,merge,cache}.ts` | Keep source enumeration, connection ownership, and basic merging. Replace change replay with refresh; remove offline receipt/cache and duplicate grouping machinery. |
| `packages/server/src/data/works/work-reviews.ts` | Preserve current producer hooks and review/access transaction. |
| `packages/server/src/data/tasks/task-activity.ts` | Preserve verified assignee mapping and task producer hooks. Do not revert typed assignee work merely because v1 requested it. |
| `packages/server/src/data/automations/automations-store.ts` | `finishRun` now captures an intent inside synchronous `withTx`. Preserve atomicity while removing the extra queue. |
| `packages/server/src/notifications/pr-observer.ts` | Reuse tested observation/identity logic where useful, but attach it to existing authorized provider refreshes; remove the independent timer/boot service. |
| `packages/server/src/notifications/review-job-results.ts` | Reuse result notification behavior. Do not add a new job execution system. |
| `packages/server/src/notifications/hub-events.ts` | Keep recipient-scoped invalidation after commit. Remove journal upkeep once unused. |
| `apps/mobile/`, `plans/017-native-mobile-client.md` | Native source now exists. Reuse its transport and navigation; add a native hub using the shared client logic. Its runtime/parity proof remains separate from source presence. |

Load-bearing existing conventions:

```ts
// packages/server/src/db/database.ts
// SQLite's ported and legacy tables use the same connection.
export async function afterDatabaseCommit(callback: () => Promise<void>): Promise<void>

// packages/server/src/data/notifications/store.ts
export async function recordNotification(tx: Db, input: NotificationInput): Promise<string[]>

// packages/server/src/data/notifications/schema.ts
// Unique: organization_id + recipient_key + event_id
```

There are already generated `0003_notifications_hub.sql` migrations for SQLite and Postgres, and host-side intent/observation storage. Before changing schemas, determine whether those migrations were applied or released. Never erase migration history or delete live rows to reach the simpler model. Stop using surplus tables first; an additive migration may relax obsolete required columns. Legacy tables can remain inert until a separate safe cleanup. The target has one active notification table, not a destructive migration requirement.

## 4. Storage, SDK, and API

Each notification needs an ID, organization, recipient, stable event key, typed kind/resource/facts, bounded display text and actor, creation time, read time, and archive time. Retain an optional activity reference where one exists. Reuse current naming and schemas. Keep existing useful fields if removing them would only cause churn; they must not require journal or conflict machinery.

Use one row per recipient/event and the existing unique constraint. The event key identifies an occurrence, not just a resource: one automation run, one assignment change, one review request. A deliberate re-request is new; replay of the same occurrence is not. No full transcript, work body, or automation output belongs in the row.

Keep `recordNotification` as the SDK entry rather than introducing a class or registry. It validates typed payloads, removes duplicate recipients, applies the event's self-notification rule, and inserts rows. Scope, actor, and recipient authority come from the domain operation, never arbitrary renderer input. A feature adds a kind, a producer call, and display/action handling.

For work/task changes, write the row inside the existing `Db` transaction. For legacy automation SQLite, use a narrow synchronous insertion helper into the same notification table and transaction, sharing input validation with the async path. Publish only after the outer commit. Do not call an async helper without awaiting it inside `withTx`. Do not move the automation store or introduce a new queue. Verify the actual engine/connection; if automation and notification tables are in different databases in a supported configuration, stop that integration and report the ownership decision needed.

Preserve these public operations across IPC/WS and the record HTTP API:

```ts
notificationsList({ filter, cursor, limit })
notificationsCount()
notificationsSetRead({ id, read })
notificationsSetArchived({ id, archived })
// notifications.changed: a small recipient-scoped invalidation
```

Retain capability detection so unsupported hosts report that state. A default page has 50 rows, capped at 100; use a stable created-time/ID cursor. Bind cursors to their source, recipient, and filter. Lists and counts must check resource access before deciding the result/page end. Clients never select another recipient by supplying a user ID. Scope each organization request through its admitted credentials and combine feeds on the client.

Keep the existing access code and tests. Revalidate reads and state changes. On known revocation, source removal, or sign-out, clear that identity's rows and actions. A network loss is stale state, not proof of revocation. Resource actions always recheck access. Source identity includes the verified host or service/organization; ambiguous source routes must fail visibly rather than pick another service.

## 5. Producers and actions

| Producer | Recipient / event identity | Hub action |
| --- | --- | --- |
| Work review request | Requested reviewer; persisted request occurrence | Open requested revision and existing review controls |
| Work review decision | Original requester; decision occurrence | Open work/review |
| Task assignment | Verified Solus assignee; assignment activity ID | Open task; use existing task session flow |
| PR assignment/review request | Verified connected provider identity; provider occurrence or observed request | Open PR; existing Guide/Lens flow |
| Automation result | Responsible person from stored creator attribution; run ID | Open run/result/session; existing Run again flow |
| Guide/lens result | Generation requester; existing generation identity | Open result |
| Existing mention activity | Mentioned user; activity ID | Open its resource/comment |

Never map an external login or display name to a Solus user by guessing. Preserve current native assignee identity validation. Do not add new assignment or mention editors as a hidden dependency. Missing verified identities must be reported as unsupported coverage, not broadened to every host user.

**PR coverage:** record events when existing authorized provider refreshes discover them. Reuse an upstream event ID where available. Otherwise preserve a small, existing observation baseline to recognize observed removal/re-request; it is provider observation state, not a notification journal. A failed, partial, or truncated response cannot imply removal. Seed current requests quietly on first observation. Without a continuously running provider integration, the hub does not guarantee immediate PR updates while no refresh runs or complete history between observations. State that limitation in the product documentation; broader monitoring is separate work.

For actions, use a small exhaustive mapping from notification kind to existing domain store/navigation commands. No callbacks or executable commands are stored in rows. “Generate lens” opens the PR lens flow with its target filled in so the user can select a saved lens or enter a prompt. “Generate guide” uses the existing review flow and host selection. Preserve the existing job progress, cancellation, result, and provider rules.

The hub must not silently resubmit a generation after a network error. Disable repeat clicks while a command is pending and use the existing domain status to show its outcome. An explicit new action retains the domain's current regenerate/replacement semantics. Existing retry deficiencies belong to the domain; do not add an independent request ledger here. No action may substitute the active organization or an unrelated host for the source-qualified target.

## 6. Shared client behavior

Keep protocol and merge logic in `packages/client-core/src/notifications/`, with injected source links and no browser/Svelte dependency. The Svelte store and native state adapter consume this same logic.

1. Enumerate authorized hosts and all known authorized organization homes, independently of the window's selected organization. Use existing connections and admission.
2. Subscribe to invalidations, then load the first page/count from each source with bounded concurrency. A slow source does not block others.
3. Refresh that source on a change event, reconnect, app foreground, or manual refresh. Coalesce bursts; if a change arrives during a fetch, perform one follow-up fetch. Discard responses from an old identity/source or superseded request.
4. On refresh, invalidate that source's older page chain and replace its active page with a fresh first page. Older history remains available through Load more. Do not leave stale archived/revoked rows in old cached pages. Preserve the visible anchor when possible and show that history refreshed if it cannot be retained.
5. Merge loaded rows by event time with source/ID tie-breakers. Keep per-source pagination; Load more obtains the next bounded page from sources that still have history. A stable label names the organization/host.
6. Send receipt writes only while the source is connected. Await the answer and refresh. Keep only in-flight UI state; do not save a queue. A lost response produces an error and refetch, not a silent replay.

Use one source subscription for the hub/badge, not one per row or mounted conversation. Refresh bounded lists, not full resource stores or transcripts. Use per-row mutation and `SvelteMap` in the Svelte adapter. Do not restore private cached rows across sign-out. Keep incomplete/offline counts visibly qualified.

Each row key is source + notification ID. Routes to the same verified source share a feed. Independent servers observing the same PR can each contribute a row; v2 does not coordinate receipt state or hide them behind a global grouping layer.

Add the shared Notifications destination with All/Unread/Archived, kind/source filters, read/unread and archive/restore, source/error status, and existing resource actions. Add a navigation entry, command-palette entry, and an available keyboard binding. Preserve keyboard/touch access, light/dark colors, focus continuity, and container layout.

For native, add `apps/mobile/src/features/notifications/`, register its screen in `navigation/RootNavigator.tsx` and `navigation/routes.ts`, and use its existing host/account connections. Plan 017 owns missing native work/task/review destination surfaces. Those actions remain pending parity until the destinations work; a disabled button is not proof of complete native support. Desktop/web implementation can proceed independently, but report native parity separately.

## 7. Four implementation stages

### Stage 1 — Simplify storage and the existing API

Owners: `packages/contracts/src/notification-hub.ts`; `packages/server/src/data/notifications/`; current notification handlers, API registry/client, `boot-server.ts`, `boot-solus-api.ts`, RPC planes/topics, preload, and event audience rules.

Keep the active recipient table and current access rules. Replace journal APIs with list refresh. Remove per-field receipt revisions/operation IDs from active contracts. Use explicit updates with server-order semantics. Simplify `hub-events.ts`. Preserve rows and migration history; verify existing schema deployment before retiring old paths. Update RPC, HTTP, and clients together, with a capability/version change if required by deployed consumers.

Update existing `notification-hub-contract.test.ts`, `notification-hub-store.test.ts`, `notification-hub-api.test.ts`, and `notification-hub-audience.test.ts`. Replace journal-specific assertions with intended behavior: event deduplication, rollback, two recipients, scoped pagination/counts, independent read/archive fields, and access removal. Do not remove access tests simply to make checks pass.

**Verify:** `bun test tests/unit/notification-hub-contract.test.ts tests/unit/notification-hub-store.test.ts tests/unit/notification-hub-api.test.ts tests/unit/notification-hub-audience.test.ts tests/unit/rpc-planes.test.ts` → pass. Run `bun run --cwd packages/contracts check` and `bun run --cwd packages/server check`. Regenerate API output with `bun run api:generate`, then `bun run api:check`. If schema changes are needed, use `bun run db:generate --name notifications_hub_v2`; prove them on disposable SQLite and Postgres. Record unavailable Postgres verification as pending.

### Stage 2 — Keep producers at their source

Owners: work review operations; `data/tasks/task-activity.ts`; existing activity writes; `data/automations/automations-store.ts`; `notifications/pr-observer.ts`, `review-job-results.ts`; existing provider refresh callers and boot registration.

Reuse current producer code and stable identities. Replace automation intent capture with the same-table transaction helper and a tested transition for pending v1 intents. Stop adding new intents before retiring their drain. Attach PR observation to current authenticated refreshes and remove its separate timer. Keep useful baseline logic. Remove notification-only runner replication where it has no other owner; preserve existing generic runner delivery. Do not remove producer access or identity checks.

**Verify:** `bun test tests/unit/notification-hub-producers.test.ts tests/unit/notification-hub-provider.test.ts tests/unit/work-reviews.test.ts tests/unit/automation-run-health.test.ts` → pass. Update `notification-hub-intents.test.ts` into a transition/atomic automation test rather than asserting that new events require a queue. Check completion with zero clients, transaction rollback, restart persistence, task identity, replayed requests, partial provider responses, and quiet initial observations. Inspect `notification-hub-delivery.test.ts` and retain only tests of supported source behavior. Run server module boundaries and the server package check.

### Stage 3 — Replace replay with shared refresh

Owners: `packages/client-core/src/notifications/{sources,server-link,hub-client,merge,cache}.ts`, their immediate callers, and source connection identity handling.

Remove the persistent cache/pending receipt APIs and global duplicate grouping. Keep source discovery, basic merge, connection ownership, request stale guards, and independent failure handling. Implement section 6. Preserve existing ambiguous-identity checks; fixing an ambiguous transport route is not the same as adding a global identity system.

**Verify:** `bun test tests/unit/notification-hub-sources.test.ts tests/unit/notification-hub-client.test.ts tests/unit/organization-selection.test.ts tests/unit/organization-filter.test.ts` and `bun run --cwd packages/client-core check` → pass. Test two independent VMs plus two organization feeds, no cloud for standalone, a change during fetch, a lost connection, stale response after sign-out, equal local IDs, older pages invalidated on refresh, and disabled offline writes. Tests must no longer require change cursors, persistent pending operations, or cross-host grouping.

### Stage 4 — Add the hub and wire existing actions

Owners: new `packages/workspace-ui/src/components/notifications/`; the hub adapter beside `contexts/notifications/notifications.store.svelte.ts`; route registry/location, resource routes, navigation/command/keybinding owners; `apps/mobile/src/features/notifications/` and existing native navigation.

Build the shared web/desktop page and native screen using the same feed contract. Keep loading/empty/error/offline/unsupported states. Use existing work/task/PR/automation navigation and domain commands. Add no new execution framework. Keep existing channel delivery behavior; do not derive a burst of alerts from a history refresh. Any reused toast path must avoid duplicate presentation of an event already announced by its producer.

Add `notification-hub-presentation.test.ts` and `notification-hub-actions.test.ts` for filters, source-qualified navigation, offline controls, lost access, and pending-click handling. Add native logic tests through plan 017's existing test setup. Test behavior outside rendering where practical.

**Verify:** `bun test tests/unit/notification-hub-presentation.test.ts tests/unit/notification-hub-actions.test.ts tests/unit/notification-preferences.test.ts tests/unit/pr-guide-jobs.test.ts tests/unit/review-lens-jobs.test.ts` → pass. Run `bun run --cwd packages/workspace-ui check`, `bun run --cwd apps/mobile check`, and `bun run --cwd apps/mobile test:logic`; record baseline failures separately. Run targeted `bunx oxlint` on changed files and existing surface/layout checks. Verify desktop, remote web, phone, and tablet layouts/focus on permitted existing test targets; starting servers or native device runs requires the normal authorization. Never test against live records.

## 8. Delivery scope and completion

This release is the durable in-app hub. Existing sound/toast/system delivery remains in its current owner. New background push delivery is a separate feature: do not send personal rows through the current device-only Web Push subscriptions without recipient authorization. No native push service or gateway is required for the hub to work. A suspended phone catches up when reopened; background alerts require separately configured delivery.

The useful T3 pattern remains source-qualified client notifications and a separate background delivery path. See its [coordinator](https://github.com/pingdotgg/t3code/blob/cc1e634bfa62edd56ff792eea666e436fdef788f/apps/web/src/components/ThreadNotificationCoordinator.tsx) and [mobile delivery guide](https://github.com/pingdotgg/t3code/blob/cc1e634bfa62edd56ff792eea666e436fdef788f/docs/user/mobile-notifications.md), inspected for v1. Do not copy its cloud dependency into standalone hub reads.

Completion requires:

- [ ] Focused stage tests and relevant package checks pass; generated API is current.
- [ ] The active model is one notification table; no journal, offline write queue, notification replication, or new job system is required.
- [ ] Local desktop, standalone VM, self-hosted API, and cloud sources all work through their normal transports. Test independent source failure and no-cloud standalone operation.
- [ ] Two clients see the same server read/archive state after refresh; receipt writes never change another user's rows.
- [ ] All required producers work within their documented observation coverage. PR freshness limits are stated rather than hidden.
- [ ] Desktop/web and native have the hub and required domain actions, with device proof recorded separately. Pending plan 017 destinations are named as remaining parity work.
- [ ] Existing notification rows, assignee identity work, unrelated source changes, and applied migration history are preserved.
- [ ] Update `docs/plans/organization-scope.md` for the narrow hub exception and add a short SDK/ownership note in `docs/plans/notifications-hub.md`. Link plan 004 D15/D16 and plan 012 to this implementation owner.

Stop the affected stage if recipient identity must be guessed, an operation would use another source's credentials, simplifying storage would lose existing data, or an atomic write needs two databases. Report that constraint without adding another framework. Continue independent work where possible.

Do not implement personal-summary replication, cloud-stored review results, a new PR monitoring service, native push infrastructure, authentication replacement, or deployment as part of this plan. Those can be separate plans if requested. Do not run builds or create a PR. Keep tests temporary and deterministic.

## Revision record

- **v1, 2026-10-02:** Proposed journals, offline writes, replication, durable action receipts, and expanded delivery infrastructure.
- **v2, 2026-10-03:** User selected the smaller model. Four stages: storage/API, producers, shared refresh, UI/actions. Reconciled the plan with notification and native source now present in the working tree; no source changes or tests were performed while writing this revision.

## Execution record

**2026-10-03 — stages 1–4 source implemented, uncommitted.** Baseline `cb9ecc5fc` plus the shared working tree.

- **Migration state.** The live `~/.solus/solus.db` already had v1's `0003_notifications_hub` and the v1 legacy slot (`notification_intents`, `notification_pr_observations`, `user_version` 3) applied, with 0 notification rows. Applied history is kept and cleaned forward: generated `0004_notifications_hub_v2` drops `notification_changes`, `notification_journal`, and the columns `resolved_at`, `resolution`, `revision`, `read_revision`, `archived_revision`, `last_operation_id`, and `position`, and declares `notifications_for_recipient` ascending (both engines scan it backwards for newest-first; drizzle-kit's SQLite output for the descending form was broken). A new legacy slot drops `notification_intents`; the unreleased v1 slot no longer creates it, so a fresh file never has it. No hand edits to generated SQL. The live file converges on the next app boot; `notification-hub-automation.test.ts` proves the upgrade from v1's shape keeps rows, and a fresh disposable Postgres ends with only `notifications` in its final columns.
- **Stage 1.** Contract v2 (`NOTIFICATION_HUB_VERSION = 2`): no journal, watermark, revisions, operation ids, or resolution; `{ id, read }` and `{ id, archived }` set-style writes; `notifications.changed` carries no payload. Store, RPC, record API (`/v1/me/notifications`, no `/changes`), and OpenAPI updated.
- **Stage 2.** Automation results are written by `recordNotificationSync` in `finishRun`'s `withTx` (SQLite engine only; on Postgres no row is written, reported below). The v1 intent queue and its reconciler are removed. PR observation runs from `PrSync`'s needs-review read (`observeNeedingAttention`), with no timer of its own. Resolution calls removed from review and task producers. Identity moves on account link are in `host-user-rows.ts`.
- **Stage 3.** `hub-client.ts` reads by refresh: coalesced first-page reads, per-source Load more, writes only while connected and never resent. `cache.ts` and cross-host grouping removed.
- **Stage 4.** `NotificationsPage`, `NotificationRow`, `notification-hub.store.svelte.ts`, route `notifications`, sidebar entry with unread count, phone footer section, `⌥⇧K` (`global.toggle-notifications`) on desktop and web, palette commands on desktop and web, resource route `automation`. Native: `NativeNotificationHub`, `NotificationsScreen`, Hosts entry, foreground refresh.

**Verification run.** `bun test` on every `notification-hub-*` suite, `native-mobile-notifications`, `rpc-planes`, `server-module-boundaries`, `work-reviews`, `automation-run-health`, `pr-sync`, `task-upstream`, `host-user`, `access-policy`, `activity-api`, `solus-api-records`, `mobile-sections`, `organization-selection`, `organization-filter`, `notification-preferences`, `notifications-core`, `attribution`, `mentions`: all pass. `bun run --cwd apps/mobile test:logic`: 12 files pass. Store, API, producer, and delivery suites also pass on a disposable Postgres 17 container (`DATABASE_URL=…`); the three SQLite-only automation/sync tests are skipped there by design. `bun run api:generate` then `api:check`: clean. Package checks: contracts, client-core, mobile clean apart from baseline; server and workspace-ui show no errors in changed files (baseline errors elsewhere). `svelte-check` shows no errors in `components/notifications/`. `bun run lint:surfaces`: clean. Targeted `oxlint` on changed source: clean. `bun run lint:layout` fails only on `TaskPage.svelte`, not changed here.

**Baseline failures seen, not caused here.** `task-store.test.ts` (comment-delete permission change in another person's uncommitted `task.ts`), `work-comment-send` and `cloud-connection-not-a-host` (missing package `runed`).

**Not done or pending.**

- No visual, focus, or device verification of desktop, web, phone, or tablet; no native compile or device run.
- Native opens no resource: plan 017 has no work, task, pull request, or automation screen yet. The native hub reads hosts only; it has no organization-service connections.
- Automation result notifications are not written on a Postgres-engine host (the automation store is SQLite; no atomic write exists). Decision needed only if such hosts are supported.
- Server-side organization membership is not validated for task assignees (no server directory); the key kind is.
- An organization id listed by two directories is shown as a conflict; namespacing connection ids by directory needs a change to grant minting.
