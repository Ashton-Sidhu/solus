# Lab-issuer triage (2026-10-13)

The failing checks of the Lab-issuer scenarios, one row for each check, with a verdict:

- **outdated**: the product changed on purpose and the scenario tested the old design. The scenario now tests the new design with the same intent.
- **regression**: the scenario tests the documented design and the product does not do it. Not fixed. A person must decide.
- **unclear**: no document decides it. Not fixed. A person must decide.
- **fixed**: a regression or unclear row that the maintainers decided; the product now does it (see "Fixes" below).

Baseline: `bun lab run all` before this triage (73 failed checks in 13 runs). Final: `bun lab run all` after it (see the end of this file). No product code changed.

## Changes to the Lab fixture (they apply to many rows)

- **F1. A Solus API for the run.** `src/cli.ts` boots one Solus API (SQLite) before the hosts and names it with `issuer.setWorkspaceRoute`, so every link the issuer issues names it (`apiUrl`). A scenario that boots its own Solus API puts the route back after it (`issuer.workspaceRoute`, new getter in `src/issuer.ts`). Evidence: plans/009-organization-vms.md §4 "API unavailable for a new organization session: … do not run the provider before API acceptance"; §9 "Existing links have no `apiUrl` … API-owned sessions cannot start"; §9 "Not run: … the Lab scenarios"; `sync/delegations.ts:232`.
- **F2. The personal host is shared with the organization and holds its key.** `src/cli.ts` boots the personal flavor with `runnerOf: ORGANIZATION_ID` (registration, link, host key, attachment), so the host can act for a member (token exchange). Evidence: ADR 0001 stage 4 (delegations); `sync/delegations.ts:182` ("does not act for you here yet"); plans/009 §9 "Attachment".
- **F3. The owner's client names the organization.** `src/scenario.ts`: a host owner's tunnel connection names `org-lab`, as a real client names the window's organization for a host shared with it (`client-core/src/server-connection.ts` `dialOrganizationId`). The ticket door then makes her organization delegation.
- **F4. A new root names the window's organization.** Prompt contexts set `session.organizationId = org-lab`. Evidence: plans/009 §1 "Organization linking", §9 "New root versus continuation": on an attached machine a new root needs the member's organization or the owner's window organization; `execution/sessions/turn-organization.ts:96-110`.
- **F5. `expectNotServed`** (`src/scenario.ts`): the Solus API registers no execution handler, so it answers `Unknown method`; `PLANE_DISABLED` also passes. Evidence: tests/unit/solus-api-service.test.ts:28 (commit 2a8c22695) "exposes no execution … handlers"; plans/013-unified-cloud-application.md §4 and stage 1 item 3.

## Fixes (decided by the maintainers, 2026-10-13)

- **X1. A link guest uses the record API with the secret only** (docs/plans/host-sharing.md §9.8). `POST /v1/auth/session` with no bearer takes `shareSecret`, `guestId`, and `displayName` and makes the same guest principal as the ticket door (`ticketForShareSecret`; `transport/solus-api/admission.ts`). The credential reaches only the one shared resource; the role is the link row's at each request; a removed or regenerated link opens nothing (`ShareManager.roleFor`). `SolusApiClient` takes `guestIdentity` and sends no `Authorization` header for a guest; client-core passes it. Tests: `tests/unit/solus-api-records.test.ts` ("a link guest opens only its shared work …").
- **X2. The Solus API ends guests only when `change.guestsRevoked` is true**, as the host does (`boot-solus-api.ts`). Test: `tests/unit/organization-vm-flow.test.ts` ("a mirror guest stays connected …").
- **X3. A `ShareAccessError` keeps its code on the wire** (`transport/websocket.ts`). The record API already maps it to `NOT_FOUND`; there is no other RPC path. Test: `tests/unit/rpc-refusal-codes.test.ts`.
- **X4. `shareSetLink` returns the link as it stands**: the same secret on a role change, a new one when minted or regenerated (contract comment in `contracts/host-api.ts`). The Lab check is now "a role change keeps the same secret".
- **X6. `createHeadlessSession` passes the same turn admission as a prompt** (`transport/handlers/session-handlers.ts` `admitTurn`; `TurnAdmissionContext` in `execution/sessions/turn-organization.ts`). `HeadlessSessionRequest.organizationId` names the organization; a cross-host child sends its parent's (`session-orchestrator.ts` `startRemote`). Tests: `tests/unit/organization-vm-records.test.ts` ("a headless start"), `tests/unit/session-remote-messages.test.ts`.
- **X7. A turn's settled status is not overwritten by its own start** (cloud-sessions "[sqlite] the record settled to idle"). Cause: `persistIndexedSessionStart` (`db/session-indexer.ts`) wrote the start (`running`) only after the git lookup of the project remote. A fast turn wrote `idle` first, then the late start wrote `running`, and the runner reported `running` to the Solus API until the next turn. The start now writes the record at once; the remote follows in a second write with no status (the merge keeps the larger `lastActivityAt`). Test: `tests/unit/session-record-settle.test.ts`.
- **X8. The boot sweep's `interrupted` reaches the Solus API.** `markOwnRunningSessionRecordsInterrupted` is one update with no change event, and it runs before the delivery follows records. `startRunnerCloud` (`boot-server.ts`) now gives the swept ids to `RunnerDelivery.reportStoredSessions`, which reports each through the same `reportSession` as any record change; the report waits in the queue until the delivery starts. Test: `tests/unit/runner-interrupt-report.test.ts`.
- **X9. A record that a runner report creates on the Solus API is published** (`sync/runner-intake.ts`; `upsertSessionRecord` takes the birth for a new record). A runner reports only published sessions. Before, the API read `publication: "local"` for them. Test: `tests/unit/organization-vm-records.test.ts` ("a record a runner report creates reads published …").
- **X10. One turn admission for every new session** (plans/009-organization-vms.md §9 "One admission for every turn"). `PromptDispatch.admitTurn` is the only admission; `PromptDispatch.createSession` calls it for a headless start and for a local child (`start_session` on this machine). Boot gives it its dependencies; the handlers no longer hold them. A local child follows its parent's record as a fork follows its source, for the parent's person. A child of a person whose authority was removed is refused before its provider starts. Tests: `tests/unit/organization-vm-records.test.ts` ("every new session passes the turn admission").
- **X11. `promptHeadlessSession` passes the same admission as `prompt`** (`transport/handlers/session-handlers.ts`). A link guest has no account, so a guest's continuation acts for the person who shared the link, on that person's seat (docs/plans/host-sharing.md §4.2 step 5); this keeps the cloud-sessions guest prompt checks passing. Tests: `tests/unit/organization-vm-records.test.ts` ("a prompt from another host …", "a link guest's prompt …").

## Rows

| Scenario | Check | Symptom | Verdict | Evidence | Change (outdated) / question (regression, unclear) |
|---|---|---|---|---|---|
| seats [personal] | dan's prompt is refused with SEAT_REQUIRED | `ORGANIZATION_AUTHORITY_MISSING` | outdated | F1, F2 | F1, F2, F4. Passes. |
| seats [personal] | dan's prompt is accepted | `ORGANIZATION_AUTHORITY_MISSING` | outdated | F1, F2 | F1, F2, F4. Passes. |
| seats [personal] | the prompt started | follows the row above | outdated | F1, F2 | as above. Passes. |
| seats [personal] | oracle/seats: a run for "dan with a seat" reached the provider | no run | outdated | F1, F2 | as above. Passes. |
| seats [personal] | the run carries dan's token in the env | no run | outdated | F1, F2 | as above. Passes. |
| seats [personal] | the seat lives beside the data directory, under dan's own directory | no run; then the folder is `dan-userda`, not `user-dan` | outdated | commit 010992d89 "name member folders by name and id slug"; `host/member-folders.ts:9-21` | The check expects `<dataDir>-seats/claude/dan-…`, dan's member folder. Passes. |
| seats [personal] | alice prompts on it | `ORGANIZATION_REQUIRED` | outdated | F3, F4 | F3, F4. Passes. |
| seats [personal] | oracle/seats: a run for "alice as the owner" reached the provider | no run | outdated | F3, F4 | as above; the owner's run is still on the host login. Passes. |
| seats [personal] | the run is the host login, not a member seat | no run | outdated | F3, F4 | as above. Passes. |
| seats [personal] | dan prompts | `ORGANIZATION_AUTHORITY_MISSING` | outdated | F1, F2 | F1, F2, F4. Passes. |
| seats [personal] | cara prompts | `ORGANIZATION_AUTHORITY_MISSING` | outdated | F1, F2 | as above. Passes. |
| seats [personal] | oracle/seats: a run for "dan second turn" reached the provider | no run | outdated | F1, F2 | as above. Passes. |
| seats [personal] | oracle/seats: a run for "cara first turn" reached the provider | no run | outdated | F1, F2 | as above. Passes. |
| seats [personal] | cara's next prompt is refused | `ORGANIZATION_AUTHORITY_MISSING`, not `SEAT_REQUIRED` | outdated | F1, F2 | as above. Passes. |
| seats [personal] | dan is back to no seat | `ORGANIZATION_AUTHORITY_MISSING`, not `SEAT_REQUIRED` | outdated | F1, F2 | as above. Passes. |
| seats [managed] | dan's prompt is refused with SEAT_REQUIRED | `ORGANIZATION_API_UNAVAILABLE` ("registration names no Solus API") | outdated | F1 | F1, F4. Passes. |
| seats [managed] | dan's prompt is accepted | as above | outdated | F1 | as above. Passes. |
| seats [managed] | the prompt started | as above | outdated | F1 | as above. Passes. |
| seats [managed] | oracle/seats: a run for "dan with a seat" reached the provider | no run | outdated | F1 | as above. Passes. |
| seats [managed] | the run carries dan's token in the env | no run | outdated | F1 | as above. Passes. |
| seats [managed] | the seat lives beside the data directory, under dan's own directory | no run; then member folder name | outdated | F1; commit 010992d89 | as for personal. Passes. |
| seats [managed] | alice, an organization owner without a seat, is refused like any member | `ORGANIZATION_API_UNAVAILABLE` | outdated | F1 | F1. Passes. |
| seats [managed] | dan prompts | `ORGANIZATION_API_UNAVAILABLE` | outdated | F1 | F1. Passes. |
| seats [managed] | cara prompts | as above | outdated | F1 | F1. Passes. |
| seats [managed] | oracle/seats: a run for "dan second turn" reached the provider | no run | outdated | F1 | F1. Passes. |
| seats [managed] | oracle/seats: a run for "cara first turn" reached the provider | no run | outdated | F1 | F1. Passes. |
| seats [managed] | cara's next prompt is refused | `ORGANIZATION_API_UNAVAILABLE` | outdated | F1 | F1. Passes. |
| seats [managed] | dan is back to no seat | `ORGANIZATION_API_UNAVAILABLE` | outdated | F1 | F1. Passes. |
| presence [personal] | scenario completed without an unexpected error | `shareSet` to the organization on a session with no record: "cannot be shared with that organization" | outdated | plans/009 §9 "Live access on the VM": the first turn of a new organization root gives the organization editor access; `sharing/share-manager.ts:602-624` (sharing with an organization moves the record into it, and an unborn session has no record) | alice's first turn (with F4) opens the session to the organization; bob watches after it settles (`turn_settled`). The "unindexed session rests" check moves to a new session that alice alone has focused. Passes. |
| presence [managed] | bob watches the session | `FORBIDDEN` "not shared with you" | outdated | `transport/handlers/session-handlers.ts:283-296` (a new session waits for the prompt that names its folder); plans/009 §9 "Live access on the VM" | as above. Passes. |
| presence [managed] | alice hears the room grow | follows the row above | outdated | as above | as above. Passes. |
| presence [managed] | the room names both | follows | outdated | as above | as above. Passes. |
| presence [managed] | nothing is running | follows | outdated | as above | as above. Passes. |
| presence [managed] | bob hears the room too | follows | outdated | as above | as above. Passes. |
| presence [managed] | bob reports a draft | `FORBIDDEN` | outdated | as above | as above. Passes. |
| presence [managed] | alice sees bob typing | follows | outdated | as above | as above. Passes. |
| presence [managed] | bob reports the draft gone | `FORBIDDEN` | outdated | as above | as above. Passes. |
| presence [managed] | alice sees bob stop | follows | outdated | as above | as above. Passes. |
| presence [managed] | bob drafts in the session he has focused | `FORBIDDEN` | outdated | as above | as above. Passes. |
| presence [managed] | alice sees the draft on the roster row | follows | outdated | as above | as above. Passes. |
| presence [managed] | bob drops the draft | `FORBIDDEN` | outdated | as above | as above. Passes. |
| presence [managed] | alice prompts the session bob is looking at | `ORGANIZATION_API_UNAVAILABLE` | outdated | F1 | F1, F4; alice pastes her seat before the first turn. Passes. |
| presence [managed] | alice hears bob's row say the agent runs | follows | outdated | F1 | as above. Passes. |
| presence [managed] | then say it waits for input | follows | outdated | F1 | as above. Passes. |
| presence [managed] | the parked row names alice as the turn's author | follows | outdated | F1 | as above. Passes. |
| presence [managed] | the indexed session now has a name from the host | follows | outdated | F1 | as above. Passes. |
| presence [managed] | bob hears the same row about himself | follows | outdated | F1 | as above. Passes. |
| presence [managed] | alice sees bob leave the session | bob was never in the room | outdated | as for "bob watches the session" | as above. Passes. |
| presence [managed] | the room keeps alice | follows | outdated | as above | as above. Passes. |
| ownership [personal] | scenario completed without an unexpected error | "This session is not shared with you": the scenario shared `created.agentSessionId` (`mock-session-001`, the mock's one thread id) | outdated | commit 92be9c508; docs/plans/session-identity.md (the session id names a session everywhere; the thread id is a locator) | Uses `created.sessionId`. Passes (20 checks). |
| ownership [managed] | oracle/ownership: bob sees session … owned by user-bob | the thread id named another session | outdated | as above | as above. Passes. |
| ownership [managed] | oracle/ownership: cara sees session … owned by user-bob | as above | outdated | as above | as above. Passes. |
| ownership [managed] | oracle/ownership: alice sees session … owned by user-bob | as above | outdated | as above | as above. Passes. |
| ownership [managed] | the organization owner cannot transfer a member's work on a managed host | Refused, but with no code ("Only the owner can transfer ownership") | fixed (X3) | `admission/access-policy.ts:309` lets a host admin through to the share manager (plan 004 item 10); `share-manager.ts:357` throws `ShareAccessError('FORBIDDEN')`; `transport/websocket.ts:415-438` forwards the code of `RpcAccessError` and others, not of `ShareAccessError` | Must a share-manager refusal reach the client with its code (`FORBIDDEN`), as an access-policy refusal does? If yes, forward `ShareAccessError.code` in `websocket.ts`. |
| managed-bootstrap [managed] | bob's default project path is his own directory | `/home/projects/bob-userbo`, not `/user-bob` | outdated | commit 010992d89; `host/member-folders.ts:9-21` | The check expects bob's member folder (`bob-…`). Passes. |
| cloud-workspace [personal] | [sqlite] bob sees the task the agent created on the service | the task stayed on the runner | outdated | plans/009 §9 "Agent tools follow the record home", §1 "Organization linking"; the owner's `createHeadlessSession` made a Local root (no turn admission) | The owner opens a new session and prompts it with the organization selected (F3, F4), so the runner admits it on the Solus API and its tools write there. Passes. See note N1. |
| cloud-workspace [personal] | [sqlite] bob sees the work the agent created on the service | as above | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] the runner's own tables hold no such task | as above | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] nor such a work | as above | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] the service lists the runner's session, naming the runner | Local session, not reported; the scenario also used `agentSessionId` | outdated | as above; docs/plans/session-identity.md | as above, and the record is looked up by the session id. Passes. |
| cloud-workspace [personal] | [sqlite] the task is still there | follows | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] the work is still there | follows | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] the session is still there | follows | outdated | as above | as above. Passes. |
| cloud-workspace [personal] | [sqlite] git is refused with PLANE_DISABLED | `Unknown method "gitRefreshState"` | outdated | F5 | `expectNotServed`. Passes. |
| cloud-workspace [personal] | [sqlite] a headless session is refused with PLANE_DISABLED | `Unknown method "createHeadlessSession"` | outdated | F5 | `expectNotServed`. Passes. |
| host-auth [personal] | service cannot store Claude credentials | `Unknown method "seatConnectToken"` | outdated | F5 | `expectNotServed`. Passes. |
| host-auth [personal] | service cannot start Codex login | `Unknown method "seatConnectStart"` | outdated | F5 | `expectNotServed`. Passes. |
| cloud-sessions [personal] | scenario completed without an unexpected error | "This session is not shared with you": the owner's `createHeadlessSession` made a Local session and the scenario used `agentSessionId` | outdated | plans/009 §9; docs/plans/session-identity.md | The owner starts the session with a prompt in the organization (F4). The guest part follows docs/plans/host-sharing.md: the link is made on the runner (§4.2 step 1, §9.10); the guest reads the mirror while the runner is dead, and the mirror refuses a prompt (§4.2 step 6, F5); the guest dials the restarted runner with the secret and prompts with `promptHeadlessSession` (§4.1 step 4-5); the shared-prompt relay (`sharedSessionAvailable`, `sharedSessionPrompt`) is removed (§7). A guest runs on the seat of whoever shared the link, the host login here (plans/012-user-actor-and-activity.md; `admission/actor.ts:95-103`). Now 33 checks; 2 fail (rows below). |
| cloud-sharing [personal] | scenario completed without an unexpected error | "Work … moved to organization org-lab" from the source's read | outdated | docs/plans/cloud-sharing.md §3a (decision 2026-10-06): the source keeps the row with a location and answers `MOVED` | The check expects `MOVED` naming `org-lab` and no row in the source's list. Now 20 checks; 8 fail (rows below). |
| share-matrix [personal] | sqlite: maya loads the work | "Sign in or pair with this host." | fixed (X1) | docs/plans/host-sharing.md §9.8 "The secret is the whole credential, at the host and at the Solus API alike", §4.1 step 5, §10 (the guest workspace opens a work); `contracts/solus-api/client.ts:43` refuses a null source, `admission/workspace-credentials.ts:54` refuses an empty bearer; ADR 0001 removed guest grants | How does a link guest (secret only, no token) read and edit a work, now that works load only through the record API? Either `/v1/auth/session` admits a share secret with no bearer, or the guest reads works over the socket. |
| share-matrix [personal] | scenario completed without an unexpected error | the guest list call threw | fixed (X1) | as above | Not fixed. The list call is now a check (`maya lists works`), so the run goes on to the transfer and delete checks, which pass. |
| guest-revoke [personal] | scenario completed without an unexpected error | "Sign in or pair with this host." | fixed (X1) | as for share-matrix | Not fixed. The load is now a check (`maya loads the work`), so the run goes on: the socket revocation checks pass. |

### Failures that an abort hid (now visible)

| Scenario | Check | Symptom | Verdict | Evidence | Question |
|---|---|---|---|---|---|
| share-matrix | sqlite: maya lists works; maya lists nothing beyond her resource; the deleted work is gone for maya too | "Sign in or pair with this host." / `UNAUTHENTICATED` | fixed (X1) | as for "maya loads the work" | as above |
| share-matrix | sqlite: maya cannot list projects | `Unknown method "listProjects"`, not `PLANE_DISABLED` | outdated | F5 | Changed to `expectNotServed`. Passes. |
| guest-revoke | sqlite: maya is now a viewer and cannot edit; maya still reads | `UNAUTHENTICATED` | fixed (X1) | as for share-matrix | as above |
| guest-revoke | sqlite: maya stays connected | A link role change ends the guest's socket on the Solus API | fixed (X2) | `boot-solus-api.ts:146-154` ends every guest of the resource on any share change; the host ends guests only when `guestsRevoked` (`boot-server.ts:1260-1270`); `share-manager.ts:686-708` sets `guestsRevoked` only for a removed or regenerated link; docs/plans/host-sharing.md §4.2 step 6 | Must the Solus API end a resource's guests only when `change.guestsRevoked` is true, as the host does? |
| guest-revoke | sqlite: a role change mints no new secret | `shareSetLink` with a role only returns the existing secret, not `null` | fixed (X4) | `contracts/host-api.ts:339` "The secret comes back only … when it was minted or regenerated"; `share-manager.ts:693` returns the stored secret on a role change | Which is right: the contract comment (answer `null`) or the code (answer the same secret)? The secret does not change in either case. |
| cloud-sharing | a task has no share link | Refused, with no code | fixed (X3) | `share-manager.ts:135` `ShareAccessError('FORBIDDEN')`; `websocket.ts:415-438` | Same question as the ownership row: forward `ShareAccessError.code`? |
| cloud-sharing | sqlite: guest loads the work; guest reads work; viewer cannot edit work; guest saves as an editor; reader detects another editor's save; stale copy cannot overwrite the saved change; role upgrade applies to live guest | "Sign in or pair with this host." (the last three follow from the failed guest save) | fixed (X1) | as for share-matrix "maya loads the work" | as above |
| cloud-sessions | [sqlite] the record settled to idle | The Solus API record stays `running` for 20 s after the resumed turn ends; the runner's own record is `idle` and its report queue is empty; the next turn makes it `idle` | fixed (X7, X8, X9) | The scenario's P2 exit test names `docs/plans/cloud-service-model.md` §18-§19, which no longer exists. Root cause (X7): the start of the resumed turn wrote `running` after the turn wrote `idle`, because the start waited for the git lookup. The record also read `publication: "local"` on the API (X9), and the boot sweep's `interrupted` never reached the API (X8). | Decided: yes. Passes. |
| cloud-sessions | sqlite: guest stays on the mirror while the link is unchanged | The runner sends unchanged share rows again and the Solus API ends the mirror guest ("Share access changed", `guestsRevoked: false`) | fixed (X2) | as for guest-revoke "maya stays connected" | as above |

## Notes

- **N1 (fixed, X6; no failing check).** `createHeadlessSession` does not pass turn admission (`transport/handlers/session-handlers.ts:310-327` calls `dispatch.createSession`, not `admitTurn`). On a machine attached for organization work, a headless new root therefore starts Local, with no organization and no Solus API admission. plans/009 §1 says "New account-free personal sessions on that VM are blocked after linking" and §9 says a Local window is refused with `ORGANIZATION_REQUIRED`. Question: must `createHeadlessSession` (also used by cross-host sessions, docs/plans/cross-host-sessions.md) pass the same admission, and how does it name its organization?
- **N2.** The cloud-sharing check "runner refuses guest admission" still passes, but only because its secret is made up: every host now has the secret door (docs/plans/host-sharing.md §4.1 step 4). Its intent ("no runner guest door") is no longer the design. It did not fail, so it was not changed.

## Final run

`time bun lab run all` (Lab issuer, both flavors), 2026-10-13: 40.8 s wall time (the baseline took 103 s; `cloud-workspace` alone waited 47 s for delivery that never came). 10 runs pass, 5 fail, 20 failed checks. Every failed check is a row above with the verdict regression or unclear.

| Run | Checks | Failed |
|---|---|---|
| cloud-sessions [personal] | 33 | 2 |
| cloud-sharing [personal] | 20 | 8 |
| cloud-workspace [personal] | 40 | 0 |
| guest-revoke [personal] | 18 | 5 |
| host-auth [personal] | 21 | 0 |
| ownership [personal] | 20 | 0 |
| presence [personal] | 38 | 0 |
| seats [personal] | 39 | 0 |
| share-matrix [personal] | 46 | 4 |
| uplink-admission [personal] | 8 | 0 |
| managed-bootstrap [managed] | 14 | 0 |
| ownership [managed] | 24 | 1 |
| presence [managed] | 40 | 0 |
| seats [managed] | 31 | 0 |
| uplink-admission [managed] | 8 | 0 |

A run while another session runs `bun lab build` fails at boot ("No standalone build"): the build removes the bundle first. Run again when the build is done.

## Run after the fixes

`bun lab run all` (Lab issuer, both flavors), 2026-10-13, after X1-X6: 42.2 s wall time. 14 runs pass, 1 fails, 1 failed check: cloud-sessions "[sqlite] the record settled to idle" (item 5, unclear, not part of these fixes). cloud-sessions has one check fewer because the mirror guest now stays connected, so "guest dials the mirror again" does not run. `bun lab run all --cloud`: the 9 cloud scenarios pass.

| Run | Checks | Failed |
|---|---|---|
| cloud-sessions [personal] | 32 | 1 |
| cloud-sharing [personal] | 20 | 0 |
| cloud-workspace [personal] | 40 | 0 |
| guest-revoke [personal] | 19 | 0 |
| host-auth [personal] | 21 | 0 |
| ownership [personal] | 20 | 0 |
| presence [personal] | 38 | 0 |
| seats [personal] | 39 | 0 |
| share-matrix [personal] | 47 | 0 |
| uplink-admission [personal] | 8 | 0 |
| managed-bootstrap [managed] | 14 | 0 |
| ownership [managed] | 24 | 0 |
| presence [managed] | 40 | 0 |
| seats [managed] | 31 | 0 |
| uplink-admission [managed] | 8 | 0 |

## Run after X7-X11

`time bun lab run all` (Lab issuer, both flavors), 2026-10-13, after X7-X11: 19.9 s wall time. 15 of 15 runs pass, 0 failed checks. cloud-sessions takes 5.1 s (35 s before: the check "[sqlite] the record settled to idle" waited 20 s and failed).

| Run | Checks | Failed |
|---|---|---|
| cloud-sessions [personal] | 32 | 0 |
| cloud-sharing [personal] | 20 | 0 |
| cloud-workspace [personal] | 40 | 0 |
| guest-revoke [personal] | 19 | 0 |
| host-auth [personal] | 21 | 0 |
| ownership [personal] | 20 | 0 |
| presence [personal] | 38 | 0 |
| seats [personal] | 39 | 0 |
| share-matrix [personal] | 47 | 0 |
| uplink-admission [personal] | 8 | 0 |
| managed-bootstrap [managed] | 14 | 0 |
| ownership [managed] | 24 | 0 |
| presence [managed] | 40 | 0 |
| seats [managed] | 31 | 0 |
| uplink-admission [managed] | 8 | 0 |

`bun lab up --cloud && time bun lab run all --cloud && bun lab down`: 106.2 s wall time for the run. 9 of 9 pass.

| Scenario | Checks | Failed | Time |
|---|---|---|---|
| account-reads | 6 | 0 | 1.1 s |
| cloud-machine | 26 | 0 | 1.5 s |
| cloud-signin | 12 | 0 | 1.1 s |
| delegation-kept-alive | 20 | 0 | 61.8 s |
| link | 22 | 0 | 1.3 s |
| organization-work | 18 | 0 | 3.0 s |
| registration | 21 | 0 | 1.9 s |
| settings-sync | 13 | 0 | 1.4 s |
| sign-out | 19 | 0 | 32.8 s |
