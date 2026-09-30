# Plan 009: One record API for local, personal VM, and organization work

**Status:** Implemented in the Solus and solus-cloud working trees on 2026-09-28 (uncommitted, not deployed). Decisions made during implementation, which replace parts of §5, and the verification record are in §9.
**Depends on:** Plan 008's workspace API and existing organization, link, mirror, outbox, and publication machinery.
**Scope:** Customer-owned execution VMs connected to a configured shared Solus API, hosted by Solus or self-hosted. API-first setup and the authentication/registration handoff for that endpoint are included. A complete self-hosted control-plane distribution and infrastructure operations are separate.

## 1. Product model

Use one Solus server and one record API contract. A host runs agents. A record's saved home determines which API stores and serves it. Solus provisioning determines who installs, updates, and stops the machine; it does not determine record operations.

| Source | Record API endpoint | Execution |
| --- | --- | --- |
| Laptop Local work | Desktop's local API | Laptop |
| Personal runner work | VM's API | That VM |
| Organization work | Configured shared Solus API (hosted or self-hosted) | Selected permitted host |

The desktop combines authorized records from its local API, connected personal VMs, and configured shared APIs. In this plan, cloud/API-owned records include records on a self-hosted shared API. Web and mobile use the same contract for the sources they can reach. Record references retain their source so list, open, search, edit, and delete use the correct endpoint. Cloud copies and execution caches must not create duplicate list entries. WebSockets carry live events; execution remains addressed to the selected host.

Local record APIs use host storage. The cloud API writes to its configured shared database. The VM never receives the shared database credential. One API contract does not require routing personal records through the cloud or making same-process domain calls use a network round trip.

### Personal use

A user can connect directly to a lab VM through the existing connection method without a Solus account. Sessions and works remain on that VM. Clients can show both laptop and VM records. The VM must be reachable to read its records. Preserve existing connection authentication; account-free does not mean arbitrary callers gain access.

A personal VM may also link to the user's Solus account for discovery and remote access from their clients. This account link keeps the VM personal and its records on the VM. Direct use remains available without a Solus account. Distinguish account linking from explicit organization attachment: only organization attachment changes the default home for new work. Account linking and authorized Insights delivery alone do not trigger that transition.

The user's own laptop keeps Local scratch as its default, including when an organization is selected. Do not add a Local label as part of this change.

### Organization linking

Explicitly linking a remote VM for organization execution changes **new work from that point forward**:

- New root sessions/tasks/works use the authenticated client's active organization and cloud API home. Selecting the VM is sufficient; no additional storage or organization choice is required.
- The VM can serve several permitted organizations. Do not choose the first membership or introduce one general owner organization for the machine.
- New account-free personal sessions on that VM are blocked after linking.
- Existing personal records are not moved, uploaded, re-owned, or shared by linking. Existing personal sessions can continue under their original access rules and Local home. Their turns and owned outputs retain that context.
- Resume, children, watches, and other work attached to an existing session inherit its saved context. Creation paths must distinguish a new root from continuation of an existing session.
- Record organization and home are saved at admission; later client filter changes do not redirect them. Explicit Local publication remains a separate action. Assigned organizations cannot be changed to another organization.

Setup selects the shared API endpoint (the hosted default or an explicit API URL). Authenticated organization linking binds that service to the machine credentials and permitted organizations. An API URL alone supplies no authority. Do not add a separate managed-behavior, storage-mode, or user-facing authentication-policy setting.

Customer and Solus-provisioned organization VMs use the same record behavior. Customer VMs remain category `self-hosted`; Solus does not gain machine lifecycle control.

### Access and attribution

Cloud-created work retains existing organization editor access. It is not public. Keep the verified initiating user as owner; the VM registrar is not the author of every run. Existing restrictions remain effective: replay or later delivery must not restore a removed grant.

Organization membership does not expose old personal records on a newly linked VM. Existing personal credentials may access those records, but cannot use that exception to create new personal root sessions or enter organization records.

## 2. Insights use the same organization, with separate upload eligibility

A personal runner can send Insights without being registered as an organization execution host. The authenticated originating client supplies authorized organization context; it is not enough for a caller to send an organization ID.

Before the first eligible upload, an unassigned Local session establishes its single organization from that context. Once assigned, every turn, child span, queued event, and resumed operation retains that organization. Acting users can differ by turn. A client switching organizations never changes the session's assignment. Without authenticated organization context, Insights stay local.

Preserve the accepted policy:

- Organization `syncAllInsights` defaults on; users cannot disable delivery while that policy is on.
- When the policy is off, retain the managed-compute exception, client opt-in, and explicit Insights sharing. Customer organization VMs use the same organization-execution Insights behavior as Solus-provisioned VMs.
- Send the existing full Insights fields with verified user ID, email, and canonical organization. Do not add historical backfill.
- Insights upload does not publish transcripts, works, or attachments, and does not change the session's record home.

Permission to deliver Insights is separate from registering the VM for organization execution. Reuse scoped delivery authority and the existing mirror. Do not turn a personal runner into an organization host because it sends Insights. Do not add an independent per-turn organization or `insightsOrgId`.

## 3. One record path for clients and agents

Reuse Plan 008's WorkspaceOperations, HTTP contract/client, and local API. Extend the existing contract where a required record operation is missing; do not create another API layer or a generic routing framework.

- Clients use the same record operations across local, VM, and cloud endpoints. Each window shows Local sources plus its selected organization's authorized content. Scope caches, subscriptions, cursors, and references to their source and organization.
- Agent tools resolve their saved session/record home and call the same authorized operations. Create, read, update, list, search, and delete must agree on the destination.
- Same-process code may call domain operations directly with the same admitted context. Data stores do not gain network or execution imports.
- Comments, sharing, and assets follow the record's home. Reuse existing routes and extend the common API as needed; the original API does not already cover every operation.
- Keep execution dispatch on the host and reuse existing session routes. A new central job queue or per-token HTTP write is not needed.
- API-owned session creation must be accepted durably by the API before provider execution begins. Reuse existing session/intake machinery, adding only the admission/receipt support needed for that guarantee.
- Use synchronous API operations for interactive task/work edits: success means an immediate authorized read sees the object. Queued operations must report pending status and preserve read-your-write behavior.
- Keep existing bulk transcript/Insights mirrors and outboxes for delivery. Persist destination and actor/stream identity; retain ordered receipts, retries, hashing, and safe acknowledgement boundaries.

The API stores session records and the existing readable transcript projection. Provider session files, checkpoints, checkouts, and execution state remain on the VM. Offline API reads do not imply execution can transfer to another host.

## 4. Link transition and authority

Persist the organization-link transition before admitting new organization work. Define an atomic boundary: a session admitted before linking retains its saved context; a new root admitted afterward requires authorized organization/API context. Do not classify old records from the current machine setting.

Reuse existing link/enrollment and host-organization relations. Bind enrollment and additional-org attachment to the authenticated actor, host, and requested organizations; check membership and existing permissions at issue and redemption. Preserve one-use tickets, expiry, protected credential storage, and idempotent retries. Adding B does not re-enroll the host or move A's records.

API/user authority and machine delivery authority remain distinct. Keep machine-only runner tokens out of ordinary user CRUD. Reuse existing issuer, API exchange, and executor-bound grants. Save bounded run authority when a user starts work so closing clients does not stop it. Bind user, organization, executor, run, API service, allowed operations, and expiry. Host credentials must not authorize an arbitrary user ID.

Creation/intake establishes the owner from verified authority once. Subsequent delivery cannot change owner or restore sharing. Partition receipts so one actor or organization cannot acknowledge another's blocked stream.

Replace broad paired/owner shortcuts with record-aware admission where needed: old personal access is limited to existing personal context; organization work requires organization authority. An issuer outage or unlink must not silently widen network access. Preserve protected local setup/status. Exact behavior for new work after the last organization is explicitly removed remains an onboarding decision; no automatic personal fallback is assumed.

### Agreed run behavior

| Event | Behavior |
| --- | --- |
| API unavailable for a new organization session | Wait; retain draft for retry; do not run the provider before API acceptance |
| VM offline | Saved cloud conversations and works remain readable; more execution waits for that VM |
| All clients close | Admitted runs continue and save results |
| User membership or VM's organization access removed | Active runs and already-running children may finish and save; block new turns, submissions, child runs, and automation runs for that authority |
| Removed authority reaches a new approval/question | Stop there; do not accept new approval or input to continue |
| API outage during a run | Continue VM-local work and queue output; pause API-dependent reads/writes; no substitute Local records |

Removal from A does not affect B. Credential renewal must preserve bounded completion of already-admitted work after membership/host removal without permitting new work. Distinguish that completion permission from explicit run cancellation, expiry, and credential compromise. Tokens cannot extend their own authority. Pending delivery retains its original destination and visible failure state.

## 5. API-first configuration and CLI onboarding

### One shared API address

The operator supplies the service where organization records should live. All VMs targeting that deployment use the same API address, but each retains a distinct installation identity and credential. Organization and resource permissions still partition access within the shared service.

Target command (not supported by the current CLI yet):

```sh
solus setup --api-url https://solus.example.com
```

Plain `solus setup` uses the hosted Solus API default for account/organization connection steps. Direct personal setup still works without any cloud service. Supplying an API URL selects the service; it does not itself attach the machine to an organization or upload personal records.

The API provides the trusted information needed for sign-in and host registration. Reuse the existing identity, enrollment, and grant services behind that entry point. They may run separately from the record API; the operator must not have to find or type their URLs during VM setup. Define the smallest typed setup metadata or handoff on the existing API surface, rather than another discovery service. Bind the returned identity/registration information and issued credentials to the selected API service. Require HTTPS outside isolated local tests; do not forward stored credentials to an unrelated redirect, issuer, or service.

The flow is: select API → authenticate or redeem an API-bound setup ticket → select/verify organization → register or attach VM → persist service identity, endpoint, and credentials → use that home for new organization work. An organization-issued setup command already carries the selected service and organization context. Unattended setup uses the same flow without prompts. Retain short-lived scoped grants and renewal rather than give every VM one shared API secret.

| Configuration | Where it belongs |
| --- | --- |
| Public shared API URL | Setup's hosted default or `--api-url`; saved in the VM's service link and record references |
| Identity/enrollment integration | Deployment configuration exposed through the API's trusted setup handoff; no second user-facing control-plane URL |
| Machine and scoped user/run credentials | Existing protected stores and grant machinery; separate for each VM/user/run |
| `DATABASE_URL` | Shared API service only, never execution VMs |

For a self-hosted deployment, configure the API's public address, database, and supported identity/registration integration once. Then point multiple VMs at that API through the same setup command. Missing or incompatible identity/registration configuration must produce a clear setup error; a bare record endpoint is not sufficient for organization enrollment. Include a documented minimal deployment configuration and a proof against a non-default API/issuer. This does not include a turnkey account-site installer, a new identity provider, or fleet management.

**Difference from current code:** `--cloud-url` currently selects the account/control plane; its runner-grant response discovers the record endpoint from `SOLUS_API_URL`. This plan changes the public entry flow to the API. The existing service setting may remain internal, but it must agree with the API the operator selected; a grant response must not silently substitute a different record service. Update CLI options, setup links, API setup contract, identity/enrollment handoff, and docs together. Do not describe `--cloud-url` as an existing API override or add a second required URL. Exact setup-route naming is an implementation detail, not a new product decision.

### One setup command

The accepted starting point is Organization Settings → Add your own VM, with a command to install/connect the machine. It also works for an existing personal server and leaves old records in place. Keep CLI sign-in as another entry point and support unattended deployment scripts.

`solus setup` is the single end-to-end onboarding command. It starts the service, completes the chosen connection path, optionally configures a provider, and reports readiness without requiring another command midway. Re-running it detects completed steps and resumes unfinished setup. Keep `solus connect` as a shortcut to the same linking steps for an existing server; do not create a separate `solus link` command. The new `--api-url` interface is accepted scope; exact unattended credential flags and explicit unlink behavior remain to settle. Do not implement the earlier draft's `--auth account` interface.

### Accepted interactive flow

`solus setup` installs/starts the personal runner, then offers direct connection details, optional personal account linking, or organization attachment. These actions can also be completed later. Over SSH, account/organization linking shows the existing device sign-in URL and code for use on another device. Organization attachment then lists permitted organizations; an org-bound setup ticket skips that selection.

After linking, interactive setup offers existing Claude/Codex provider configuration with Skip for now. Non-interactive setup never starts that provider wizard or an implicit login. Report connected state separately from provider readiness; do not copy laptop provider credentials.

Use a terminal UI framework for a sequential interactive wizard. A full-screen terminal interface is not part of this onboarding design. Current CLI code has hand-written dispatch and console output, with no prompt/TUI framework dependency. Recommended framework: `@clack/prompts` for this sequential wizard (https://github.com/bombshell-dev/clack); the framework requirement is accepted, the specific library remains a recommendation. Keep setup/link operations independent of rendering, and use the same operations for unattended flags/tickets. Interactive prompts require a terminal; unattended mode must never wait for input and must report missing required inputs clearly.

Required capabilities:

- Personal account-free setup and direct client connection, plus optional account linking for personal-host discovery and remote access without changing record storage.
- Explicit organization linking with a clear statement that new work will use organization API storage while existing personal work stays in place.
- Interactive sign-in or an authenticated one-use enrollment ticket supplied through a protected file/stdin. No account credential means a clear unattended failure, not a browser wait.
- Existing authenticated deployment callers can mint ordinary per-VM tickets. No new PAT/service-account product, fleet keys, pending approval, or approve/reject UI.
- Add/remove an organization, show current state, and unlink without duplicate hosts or silently re-adding removed organizations.
- Start from the hosted API default or explicit `--api-url`. Obtain sign-in and registration information through that API; users do not supply a second control-plane address or shared database credential.
- Show category, organization access, API/VM reachability, and pending/failed delivery without exposing secrets. Preserve keyboard access and equivalent desktop/web/mobile capability.

Remaining onboarding details: protected unattended input and explicit unlink behavior. Reuse the existing hosted tunnel path and preserve personal direct connectivity. Configurable shared API setup and its identity/registration handoff are in scope, including self-hosted endpoints. A new execution-host network tunnel protocol and full private control-plane packaging remain separate; document required network reach instead of assuming a custom API URL supplies it.

## 6. Implementation map

These source notes are carried from the prior inspection, not a claim of a fresh runtime audit. Both repositories had substantial uncommitted work. Recheck current source and Plan 008's validation report before editing.

| Region | Change |
| --- | --- |
| `packages/server/src/data/workspace/{operations,service,tool-context}.ts` | Reuse domain operations; resolve saved local/remote home instead of unconditional local tool context |
| `packages/client-core/src/solus-api-client.ts` and source/connection stores | Common endpoint-aware record access, credentials, cache/event identity |
| `packages/server/src/execution/agents/tools/{task-tools,work-tools}.ts` | Replace managed-only routing; make reads and writes use the same home |
| `data/sessions/session-records.ts`, `execution/session-runtime.ts`, `execution/sessions/turn-organization.ts` | Persist home/actor/org at admission; distinguish new roots from old personal continuations; wait for API acceptance |
| `sync/{runner-intake,runner-delivery,publication}.ts`, `sync/mirror/`, `sync/outbox/` | Automatic organization persistence, Insights-only personal delivery, scoped receipts and recovery |
| `sharing/share-manager.ts`, `transport/handlers/session-handlers.ts` | Verified creator, existing cloud access defaults, no implicit exposure of old personal records |
| `admission/{principal,workspace-credentials}.ts`, `transport/solus-api/admission.ts` | Record-aware authority and bounded execution-user API grants; no machine-token impersonation |
| `host/{managed-mode,host-category,organizations}.ts`, HTTP/WS admission, trusted-requester checks | Remove process-wide managed data/security decisions; retain old personal access within its saved context |
| `transport/uplink/link.ts`, `apps/cli/src/lib/connect.ts`, CLI setup/start parsers | Enrollment transition, additional organizations, protected bootstrap, agreed onboarding |
| Cloud `src/lib/server/uplink/{hosts,grants}.ts` and enrollment routes | API/service-bound enrollment, permitted orgs, setup handoff integration, run authority; returned routes agree with selected service |
| `packages/contracts/src/solus-api/`, `transport/solus-api/`, `boot-solus-api.ts`, API deployment configuration | Typed API setup entry/handoff for hosted and self-hosted services; issuer/registration configuration, service identity, actionable setup errors |
| `boot-server.ts`, `boot-solus-api.ts`, packaging and cloud managed bootstrap | Same record behavior on both VM categories; preserve secure startup and lifecycle facts |

Delete `SOLUS_MANAGED`, `isManagedHost()`, and `managedCloudOrganization()` after replacing every responsibility with its actual fact: saved record home, admitted organization/user, permitted operations, or provisioning category. No substitute all-purpose boolean. The API-only service still admits no local/paired owner bypass.

Rename the protected `SOLUS_MANAGED_LINK` bootstrap payload to a neutral host-link name, coordinating cloud producers and release consumers. Keep stripping it before child processes start. Retain managed lifecycle/category concepts and independent API boot configuration such as `SOLUS_API`. Do not widen provider credential access.

## 7. Delivery stages

1. **Baseline and context.** Inspect current working trees, Plan 008, and `docs/api/validation.md`. Establish saved home/organization/actor contracts and tests for new roots versus old-session continuation. Extend existing fields; no duplicate ownership table.
2. **Common record access.** Route client and agent reads/writes through the same endpoint-aware contract. Preserve direct personal operation and source-aware combined lists.
3. **API-first setup and organization link transition.** Implement the hosted default and `--api-url`, API setup handoff, service-bound tickets/grants, and one resumable setup wizard. Verify a non-default self-hosted API with its configured identity/registration service. Persist org attachment before new work and enforce narrow old-personal access. Update canonical contracts, cloud copies, deployment examples, and CLI docs together.
4. **API-owned starts and delivery.** Wait for durable session acceptance, carry verified run authority, automatically persist organization output, and support policy-driven personal Insights without publishing content. Reuse mirrors/outboxes and prove scoped receipt recovery.
5. **Remove managed routing and finish surfaces.** Replace all old flag responsibilities, coordinate bootstrap, update setup/API docs, and verify desktop/web/mobile source/status behavior. Keep Solus-managed lifecycle controls exclusive to Solus-provisioned machines.

Use existing folder boundaries. Do not mechanically split large files or add pass-through services. Keep automation definitions/scheduling on execution machines. New provider authentication designs, cloud review workers, host execution transfer, turnkey self-hosted control-plane packaging, and multiple live API replicas remain separate features. The setup wizard may call existing provider setup interactively. Configurable self-hosted shared API onboarding is included.

## 8. Proof and completion

Required focused proofs:

- Hosted-default setup and `--api-url` setup both complete sign-in/enrollment without requiring a control-plane URL. Re-running setup resumes safely; `connect` uses the same steps. Non-interactive mode never opens a wizard or provider login.
- Two distinct VMs attach through a non-default API and configured non-default issuer/registration service, create records in the same disposable shared database, and retain separate host/user authority. The client reads these records from that service even when a VM is offline.
- Missing setup metadata, untrusted redirects, API/issuer/audience mismatch, and a ticket or grant naming a different record service fail before credentials or data are sent to that service. A changed setup URL cannot move existing records or queued delivery.

- One client reads laptop, personal VM, and selected-org cloud records using the same contract; updates reach the proper endpoint without duplicate copies or cross-org cache/event leakage.
- Account-free personal operation still works. Optional personal account linking makes the host discoverable without changing record homes or new-personal-session behavior. Organization linking with existing sessions converts nothing; old personal sessions can continue; new personal roots are refused; new org roots use the API. Restart and concurrent link/start preserve the boundary.
- Old personal credentials cannot read organization records; organization members cannot read old personal records merely because the VM was linked.
- One VM serves A and B; every record keeps its admitted organization. Alice linking the VM does not make her owner of Bob's work.
- Both VM categories create/read/update API records consistently. API refusal prevents new provider execution. Retry cannot duplicate a session or restore removed grants.
- Personal Insights obey policy and fixed session organization without uploading transcript/works or registering the VM for organization execution. No account context means no organization upload; no historical backfill.
- Client closure permits run completion. Membership/host removal permits existing runs/children to finish but blocks new work and new approvals/answers. Test token renewal and output delivery under that bounded completion rule.
- API outage pauses dependent operations while preserving queued output. Lost responses, restart, permanent failure, and scoped acknowledgements never delete undelivered data or redirect it.
- Cloud reads work with the runner offline for the supported transcript projection. Execution does not silently transfer hosts.
- Enrollment replay/expiry, changed membership, invalid actor/executor/org, and API endpoint substitution fail without leaking secrets.

Use the isolated test runner and disposable SQLite/Postgres data. Existing useful suites: `solus-api`, `record-organization`, `publication`, `sync-organization`, `uplink-link`, `runner-intake`, `mirror-sinks`, `principal`, and `server-module-boundaries`. Run `runner-delivery` separately. Add focused `organization-vm-records`, `host-authentication`, and `cli-org-connect` tests; these names are proposed, not current passing evidence.

Run contracts check, `api:check`, targeted lint/typechecks, cloud contract sync/copy tests and relevant grant/enrollment tests, and `git diff --check`. Run changed persistence/intake cases on disposable Postgres as well. Search affected runtime/config/tests for retired managed flags; preserve lifecycle-only category usage. Check bootstrap shell syntax and producer/consumer agreement. Record existing failures separately.

Completion requires all accepted record, link-transition, authority, and Insights behavior above, focused test evidence, updated setup docs, and recorded client-surface verification or an explicit outstanding limitation. Completion also requires API-first hosted and self-hosted setup evidence and documented API/identity/database configuration. Keep the remaining unattended-input and unlink decisions explicit rather than inventing behavior.

No compatibility aliases, live-data migrations/resets, builds, app starts, installs, commits, pushes, PRs, or deployments are authorized by this document edit. Do not run `bun run build`, its variants, or the root test command that includes a build. Preserve unrelated working-tree changes. This revision replaces conflicting guidance in the prior 009, especially VM-wide account-only conversion, simultaneous new personal/org sessions after linking, and control-plane-first onboarding. Configurable self-hosted shared API entry is now included; full deployment packaging remains separate.

## 9. Implementation record (2026-09-28)

### Decisions made during implementation

These answers from the maintainer replace the conflicting parts of §5:

- **One setup URL: the account plane.** `solus setup` and `solus connect` take the account plane (default `https://app.solus.sh`, `--cloud-url` to change it). The account plane already owns sign-in, tickets, and grants, and it names the Solus API: the link's new `apiUrl` is fixed at enrollment from its `SOLUS_API_URL` (hosted default `https://solus-sh-api.fly.dev`). No `--api-url` flag and no API setup route were added.
- **The link code carries the account plane.** A code is `<ticket>@<account host>` (`formatLinkCode`/`parseLinkCode` in the uplink contract). `solus setup --link CODE` needs nothing else. A bare ticket still works with `--cloud-url`.
- **Unattended setup is `--link CODE`.** No ticket file, stdin, or environment variable. A script gets a code from a person (console "Add your own VM", ten minutes, one use). A deploy credential for fully unattended fleets is deferred.
- **No new dependency.** The wizard uses `node:readline` (numbered choices, Enter for the default); the prompts stay separate from the setup operations (`apps/cli/src/lib/onboarding.ts`).
- **Unlink resets to personal.** An unlink removes the attachment with the link, and the account plane deletes the host's organization shares, so linking again never brings a removed organization back. Removing the last organization without unlinking keeps new personal roots blocked.

### What was built

> Plan 010 (standard OAuth) replaced the credentials described below: the run
> authority, the runner grant, and remembered grants are gone. A host now holds a
> delegated token per person and organization (token exchange), and every refresh is
> the live check. The product rules below did not change.

- **Attachment.** `host/organization-attachment.ts`; `attachedAt` is persisted in the host's link record. It is set by an enrollment or attach that named organizations, by a standing that lists a shared organization, and before a member's organization work is admitted. A person's own computer (category `personal`) is never attached; the desktop keeps Local scratch.
- **Link codes and attach.** Cloud: `enrollment_ticket.organization_ids` (migration 0009), membership checked at issue and again at redemption, the personal-host policy checked at redemption, `POST /v1/hosts/:id/organizations/attach` (host token + the owner's organization ticket), host-token `DELETE /v1/hosts/:id/organizations/:org`, and unlink/delete clear shares. Host: `uplinkLink` on a linked host redeems the code as an attachment, only from the account plane it is linked to; `uplinkDetachOrganization`.
- **New root versus continuation** (`execution/sessions/turn-organization.ts`). On an attached machine a record's saved home decides a continuation; a personal fork stays personal; an organization fork is a new admission. A new root needs the member's organization or the owner's window organization; a pairing connection, a guest, or a Local window is refused with `ORGANIZATION_REQUIRED`. Refusal codes are in the contract (`turnRefusalSchema`) and reach the client, which puts the draft back in the composer.
- **Run authority** (`sync/run-authority.ts`, cloud `POST /v1/hosts/:id/run-authority`). The host presents the person's own grant for this host (the integration-credential pattern) with its host token; the account plane checks the grant, an open account session, current membership, and the host's attachment to the organization, then mints an authority for one run on one host. It has no expiry (the signer requires an `exp`, so it carries `RUN_AUTHORITY_EXP_SECONDS`, a century ahead), and the Solus API's replay check at start does not apply to it, so an API restart during a run does not end it. The Solus API exchanges it without spending it and refuses it for another session id; a runner grant is refused at exchange. Every new turn and every new approval or answer of an API session needs the person again, so a removed membership or attachment stops new work while the admitted run finishes. An account-plane outage keeps a continuation's current authority; a refusal never does.
- **Admission before the provider** (`POST /v1/session-admissions`, `session_admissions`, SQLite 0016 / Postgres 0005). The session record is born published, owned by the verified person, and its reports name the admission; runner intake takes the owner from the admission, never from the report or the linker, and existing organization editor access is kept.
- **Agent tools follow the record home** (`data/workspace/tool-context.ts`, `sync/remote-operations.ts`). An API session's task and work tools call the Solus API synchronously as the person; a first write waits for the session's report to arrive. Comments and links, which the record API does not carry, stay on the queued delivery and say so. Without authority a tool writes nothing and says why. `managedCloudOrganization()` is gone.
- **Record scope.** On an attached machine a pairing connection (`local-owner`) reads and changes only Local records; members read only their organization; the owner's account and the host itself read the disk.
- **Managed mode removed.** `SOLUS_MANAGED`, `isManagedHost()`, `hostOrganizationId()`, and `host/managed-mode.ts` are deleted. "Managed" is the fact of the link (it names the organization Solus provisioned the machine for). The bootstrap payload is `SOLUS_HOST_LINK` in the cloud bootstrap, `packaging/managed-host/sprite-boot.sh`, and the Lab; the Solus API no longer sets a managed flag. Insights always sync for an organization the machine is attached to.
- **API pinned.** Runner delivery refuses a grant whose route is not the link's `apiUrl`, before any record is sent; a run authority for another API is refused before any credential is sent there.
- **Live access on the VM, like a shared cluster.** At the first turn of a new organization root, the VM gives the organization editor access to that session (`ShareManager.adoptForOrganization`, `sharing/share-manager.ts`). A member of the organization can watch it live on the VM, and can also answer. Answers need the answering member's own run authority. This follows the existing rule that work created in the cloud is visible to the organization. The grant covers that record only. It does not make an organization owner an administrator of the machine. A member of another organization on the same VM gets no access, and an existing record in another organization is never taken over. A chat is the exception: it is organization work, but only its starter sees it until they share it, on the VM and on the Solus API (plan 004 D14).
- **Tools in API sessions.** `find_works` with a query uses the API's content search (`GET /v1/works/search`) for API sessions and the same search for Local sessions. `import_external_doc`, `publish_work`, and `pull_work_upstream` call the API (`POST /v1/works/import`, `/works/{id}/publish`, `/works/{id}/pull`), which uses the person's own account connections.
- **Account connections for the run.** A run authority stands for the person's own GitHub, Google, and Atlassian connections for that run, also after their client has closed, for as long as the run takes. The account plane admits it (`integrations/authorization.ts` `runDelegate`) only for the host it names, while that host reaches the organization and the person is still a member. The VM keeps it for that person (`vault/account-integrations.ts` `rememberRunAuthority`). It never uses another person's connection.
- **Surfaces.** CLI `setup`/`connect` wizard, `connect status` (kind, attachment, API, reachability, delivery backlog), `connect remove ORG`, `connect unlink`. Console: Organization settings → Add your own VM (organization-bound command), and Link a machine shows a link code. Clients: Settings → Connections → Organizations shows the attachment and delivery (shared by desktop, web, and mobile); the in-app install command uses the link code.

### Verification

- Solus focused suites (SQLite): 21 files including the new `organization-vm-records`, `host-authentication`, `organization-vm-flow` (the real Solus API over HTTP with a fake account plane that signs real ES256 grants), `cli-org-connect`, and a run-authority case in `host-grants`.
- The same persistence, intake, and flow suites on a disposable Postgres 17 container: 12 files pass. `runner-delivery` fails one existing SQLite-specific assertion on Postgres (it counts SQLite statement preparations); the test was not changed.
- Full Solus unit suite: every failing file fails for a reason outside this change (`runed` missing, runes outside the compiler, `node:sqlite` loaded by modules not changed here, and other existing assertions); none names a changed module.
- solus-cloud: 221 tests (212 before, 9 new in `organization-vms.test.ts`), `svelte-check` 0 errors, contract copy identical.
- `api:generate`/`api:check`, contracts typecheck, CLI typecheck, server typecheck (the 151 existing errors, no new ones), targeted oxlint on changed files (remaining findings predate this change), `git diff --check`.

### Not done, or limited

- **Session lists from the Solus API.** Another change in this tree does this work: the session history reads `GET /v1/sessions` and reads organization sessions from the Solus API only. The read-only open of a record whose runner is offline already exists (`components/session/lib/session-home.ts`, `SessionRecordPage`). Until that change lands, the lists do not show an organization session when its VM is offline.
- **Run authority lives in memory.** A restarted VM asks again at the next turn. A watch or automation that wakes after a restart cannot write to the API, and cannot use the person's account connections, until someone sends a turn.
- **`read_task` in API sessions** shows no comments or links, because the record API does not carry them.
- **Not run:** interactive desktop, web, and mobile QA; the Lab scenarios (they need `bun run build:test`); a two-VM run against a deployed self-hosted account plane.
- **Deploy order.** Release the server first (it reads `SOLUS_HOST_LINK`), then deploy the control plane that pins that release and applies migration 0009. Existing links have no `apiUrl` until they link again; until then delivery uses the grant's route and API-owned sessions cannot start.
