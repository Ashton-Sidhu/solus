# Implementation plans

| Plan | Status | Dependencies |
| --- | --- | --- |
| [001 Owned server installation](001-owned-server-installation.md) | IMPLEMENTED — verification evidence in .solus-local/owned-server-qa | Current working-tree server update implementation (baseline, no migration required) |
| [002 Session message persistence](002-session-exchange.md) | SUPERSEDED 2026-09-23 (no table) — DESIGN PROOF — single-table schema, write-only-when-depended-on rule, SQL trace; not integrated | Existing control-plane design; no dependency on plan 001 |
| [003 Session message integration](003-session-message-integration.md) | SUPERSEDED 2026-09-23 (no table, no coordinator); stages 1–2 shipped in c3f2b044 — PLAN — four stages: fewer calls today, reliable in memory, durable messages, coordinator; decisions 1–6 need sign-off | 002 |
| [004 Shared host collaboration](004-shared-host-collaboration.md) | PLAN — revised 2026-09-29 against `bf4e8fe7` plus plans 007–009 in the working tree; decisions D1–D17 (Stop keeps the queue; prompt authors live-only for now; chats private until shared; @mentions without notifications until the notifications hub); execution plan of 17 steps in 6 stages; work not started, waits on 007–009 being committed; plan 009 §9 needs a correction (D14) | Feature plan `de142de0` P7 owns every scope/actor change it lists; plan 009; `docs/plans/workspace-and-machines.md` |
| 005 Host and organization refactor audit | SUPERSEDED by 007; file is deleted in the working tree | Historical audit; do not restore as another work queue |
| 006 Host and organization refactor | SUPERSEDED by 007; file is deleted in the working tree | Earlier model; do not restore as another implementation plan |
| [007 Server structure refactor](007-solus-api-organization-refactor.md) | IMPLEMENTED 2026-09-28 (working tree, uncommitted) — Data / Execution / Sync / Transport / admission / host / files layout, `SessionRuntime` name, boundary test with four named exceptions; behavior, schemas and contracts unchanged | Current behavior and regression baseline; no new product decisions |
| [008 Workspace HTTP API](008-workspace-http-api.md) | IMPLEMENTED 2026-09-28 in the working tree — focused SQLite/Postgres checks recorded in docs/api/validation.md; interactive client verification remains outstanding | 007 layout; current organization/resource access policy; host-owned automation exception |
| [009 Organization VMs](009-organization-vms.md) | IMPLEMENTED in the working trees 2026-09-28 (uncommitted, not deployed) — org attachment changes new work only; API admission before the provider; run authority from the person's own grant; agent tools follow the record home; one setup wizard entered at the account plane with link codes; `SOLUS_MANAGED` removed. Limits in §9 | Implemented 008 API; existing organization/link/mirror/outbox machinery; coordinated Solus and solus-cloud contracts/bootstrap |
| [010 Standard OAuth](010-standard-oauth.md) | IMPLEMENTED 2026-09-29 (uncommitted; Workers not proven) — app.solus.sh becomes an OAuth 2.1 / OpenID Connect server (Better Auth `oauth-provider`); hosts are confidential clients that act for a person by token exchange; one 5-minute access token and a rotating refresh token replace host, workspace, and runner grants and the run authority; removal ends everything. Stage 0 proves the provider first | 009 (replaces its §4 credentials, keeps its product rules); solus-cloud Better Auth 1.7.6 |
| [012 One user, one actor, and one activity record](012-user-actor-and-activity.md) | IMPLEMENTED (uncommitted, 2026-09-29) — all eight stages built; stage 8 sends session activity through the transcript mirror and serves record activity and "activity naming me" on the Solus API — one `User` with a typed `UserId` (account, local, guest); `HOST_OWNER_USER_ID` and stored `'you'` labels removed (host-login seat, minted local owner, rows moved on link); one `Attribution` for every doer; the actor resolved once per request in every domain; one host-stored activity record for sessions, tasks and works (absorbs `task_events`, feeds the notifications hub); one user chip. Eight stages; O1 decided (`local` stays) | Plan 004 working tree; plan 010 account ids; P7 decides whose actor agent and automation turns carry |
| [013 Unified cloud application](013-unified-cloud-application.md) | PLAN — architecture accepted 2026-10-01; one Node cloud application and release; local desktop/host APIs preserved; Better Auth server stays cloud-only | Current implementations of 007–010 and 012; existing live collaboration and runner delivery |

## Refactor and feature execution order

Plan [013 Unified cloud application](013-unified-cloud-application.md) is PLAN
(2026-10-01; architecture accepted, implementation not started). It combines the
SvelteKit/Better Auth account application and Solus record API in one Node cloud
deployment and one tested release. Desktop and standalone hosts keep their local
APIs and shared record implementation; Better Auth server code stays cloud-only.
It follows the current implementations of 007–010 and 012. It changes deployment
composition, not the feature plans' record ownership or access rules. Source work,
packaged verification, staging, and production cutover have separate gates; the
plan does not authorize a deployment.

Plan [011 Cloud coding primitives](011-cloud-coding-primitives.md) is
IMPLEMENTED (2026-09-29), not committed. It follows the local-to-cloud task's
uncommitted implementation: GitIdentityManager → full-history partial clones;
AgentProfileManager is independent. A member's token is held in a 0600 file for
each identity revision, only while it is in use; the standalone helper could not
use the member's authority. Open items are in the plan's implementation record. It replaces the review's proposed profile
revision store and comparison-time history-deepening layer. Stage tests and scope
are in the plan. Plans 004 and 009 retain their ownership decisions.

007 is done: baseline → Data modules → Execution naming and placement → Sync
and Transport → consumers, docs and regression proof. It preserved schemas,
contracts, access rules, delivery and visible behavior; its Outcome section lists
the layout and the boundary exceptions the feature plan owns.

All net-new behavior now belongs to the original saved feature plan,
**Solus Cloud — Service Model: Cloud-Owned Collaboration, Host-Owned Execution**,
work ID `de142de0-7fbf-4ed2-a7e6-4cb982a733f2`, revision 10. Its feature sequence is
P7 organization/authority/delivery and client scope → P4 publication completion →
P8 managed Insights → P9 portable reviews → P10 GitHub-entry cloud jobs. P6 host
transfer remains separate after the organization foundations.

That feature plan owns new scope/actor infrastructure shared with 004; do not
implement it twice. Plan 004's unrelated collaboration work remains valid.
Automation storage, historical Insights backfill, and temporary-worker provider
authorization remain feature decisions. None blocks the pure refactor. No
implementation completion is claimed by these documentation changes.

## API implementation plan

008 implements a small API beneath the original feature work's product model.
The generated contract in `docs/api/openapi.json` contains task/work CRUD, stored session
reads and Insights list/get, plus authentication and discovery. Organization
context comes from verified credentials. Cursor pagination, bounded time ranges
and database query limits address scale. GitHub operations, sharing administration
and session creation remain outside this initial contract. Automation storage and
scheduling remain on the execution host.

The API can deploy independently; desktop keeps the API and execution bundled
in its current process. Cloud provider login, execution transfer and review
workers remain separate features. Deployment is not authorized by the plan's
existence, and it does not duplicate 004's scope/actor model.

## Organization VM implementation order

009 follows the implemented API: saved record context → common client/agent
record access → API-first setup and organization link transition → API-owned starts,
delivery and Insights → removal of managed routing and surface verification.
Reuse the existing API, session routes, mirrors, and outboxes.

Account-free personal VMs keep records on the VM. Organization linking changes
new work to API storage; existing personal sessions stay in place and can continue.
Personal Insights may sync under organization policy without publishing content
or registering the machine for organization execution. Cloud-created work retains
existing organization visibility. `solus setup` is the end-to-end wizard;
`solus connect` reuses its linking steps. As implemented, setup is entered at the
account plane (`--cloud-url`, hosted default), which names the Solus API the link
then fixes; a link code (`<ticket>@<host>`) carries the account plane, and
`--link CODE` is the unattended path (009 §9 replaces the earlier `--api-url` design).

009 is the current guidance for this scope. Turnkey control-plane packaging and new
private-route enrollment remain separate. Implemented in the working trees; not
committed or deployed.
