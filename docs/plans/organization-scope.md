# Hosts, organizations, and record homes

Status: implemented in the working tree on 2026-09-28 (Solus and solus-cloud,
uncommitted) for the organization model (§3), scoped delivery (§6), publication
on Share/Move (§4, §7), the organization-managed Insights policy with its
attribution columns (§6.1 of the feature plan), the allowed-host policy, and the
Local-plus-one-organization client (§2, §7). Not part of this delivery: P6
execution transfer, P9 portable review results, and P10 GitHub-entry cloud
review jobs, which the feature plan keeps as separate designs. The cloud
Insights decision below was added on 2026-09-27. It replaces the earlier
proposal that selecting an organization automatically uploads new scratch work.
The existing host/service split in `workspace-and-machines.md` remains valid.

## 0. Where the implementation lives

| Concern | Solus | solus-cloud |
|---|---|---|
| Canonical `organization_id` and read scopes | `admission/principal.ts` (`RecordScope`, `recordScopeOf`, `organizationForNew`), `data/scope.ts`, every ported store | — |
| Host category and standing | `host/host-category.ts`, `host/organizations.ts` (`GET /v1/hosts/:id/organizations`) | `host.category`, `host_organization` shares, `uplink/hosts.ts readHostOrganizations` |
| Organization policy | held against in `execution/sessions/turn-organization.ts` and `sync/mirror/insight-mirror.ts` | `organization_host_policy.allow_personal_hosts`, `sync_all_insights`; owner-only edit |
| Per-organization delivery | `sync/mirror/mirror-log.ts`, `sync/outbox/outbox-store.ts`, `sync/runner-delivery.ts` (one queue per organization and person), `sync/delegations.ts` | OAuth token endpoint: token exchange and refresh for the host's client (plans/010-standard-oauth.md) |
| Share on a Local work or task | client upload with the person's sign-in (`cloud-sharing.md`); `workExportForCloud`, `workMarkMoved`, `taskExportForCloud`, `taskMarkMoved` | — |
| Insights attribution | `spans.user_id/user_email/organization_id`, `insight_spans` copies, `data/insights/api-turns.ts` | — |
| Client window scope | `packages/client-core/src/organization-selection.ts`, `workspace-ui/src/lib/organization-filter.ts`, the switcher, Share on submit, Insights settings | console: organization settings and host shares |

## 1. The model

**A record has a home. A session runs on a host. Sharing grants access to a
cloud resource. The selected organization supplies context for the window.**

These are separate facts. Sharing one conversation must not require sharing
the machine that runs it. Selecting an organization must not publish scratch
work. Signing in, linking a host, and joining an organization do not publish
Local sessions or works. The default-enabled Insights copy below is separate
from record publication.

| Concept | Responsibility | Identity |
|---|---|---|
| Organization | Membership and the boundary for cloud records | Account service + organization ID |
| Host | Runs agents and holds runtime files | Stable host identity |
| Record home | Authority for durable collaboration records | Local host, or cloud organization |
| Execution scope | Bounds an admitted session or operation on a host | Local, or account service + organization ID |
| Host share | Lets organization members use a personal host | Host + organization |
| Resource share | Grants access to a session, task, work, or published report | Resource home + resource ID + access rules |
| Window selection | Chooses organization records and eligible shared hosts to show beside Local | Local only, or one organization |
| Connection | Access to an endpoint with verified identity and fixed scope | Endpoint + account identity + scope |

In the implementation, use the existing `organization_id` field on sessions,
tasks, works, and their dependent rows: `'local'` names machine-local records;
an organization ID names cloud records. A Local record's storing host is known
from its server, and a cross-server reference carries that host ID. A cloud
reference carries the account service and organization ID. Do not add a second
ownership record or a `home_host_id` column to every asset. The session's
`runner_host_id` says where it executes, which can differ from where its
collaboration record lives. Keep `'local'` non-null in the database: existing
scope filters and composite mirror keys depend on it.

Local means machine-local records. It is not an organization or a shared
cloud database. A personally controlled remote VM can hold Local work too.
Every Local record retains the identity of its host.

Use **Solus Cloud** for the account and collaboration services together.
The **collaboration service** stores organization records and serves cloud
share links. It is available independently of managed execution hosts. A
linked laptop can be the person's only execution host. The existing
`SessionRuntime` class (`execution/session-runtime.ts`) coordinates sessions within a server; do not confuse it
with the collaboration service. “Workspace” remains the user interface.

## 2. What the person can see

**Client rule: Local + the selected organization.** Organization selection is
a view filter. Switching from A to B replaces A's organization content with
B's while keeping Local visible. Each window has one such selection; separate
windows can select different organizations. With no selection, show Local.
The filter does not move records or grant access; the server still checks
authority for each requested scope and resource.

Keep all three sources accessible, subject to access and availability:

| Source | Contents | Availability |
|---|---|---|
| Own machines / Local | Local sessions, tasks, works, projects, and insights | Read from the relevant machine; a remote machine must be reachable |
| Shared hosts, including managed VMs | Authorized sessions, runtime state, checkouts, and host insights in the selected organization | Runtime operations require a reachable host |
| Organization cloud | Cloud tasks, works, session mirrors, shared reports, and their access rules | Published content remains readable when its execution host is offline |

Local remains available while an organization is selected. The organization
selection changes the cloud and shared-host context; it does not hide the
person's Local work. Another organization's records are reached by selecting
that organization or opening another window. Do not combine all organizations
into one unscoped view.

**One exception: the notifications hub** ([notifications-hub.md](notifications-hub.md)).
It shows what is addressed to the person from every host and every
organization home the client reaches, whatever organization the window
selected. Each source is still read through its own admitted connection and
answers only the caller's rows in the scopes that admission allows; the client
merges the feeds. No read spans organizations on the server, and every other
board keeps the Local + selected-organization rule.

These are sources, not three copies of every record. A VM session and its
cloud mirror are one logical session, with one execution host and one record
home. Merge them by stable identity. Show where records live and where work
runs, and distinguish offline, access lost, loading, and not yet synchronized.

“Always accessible” does not promise an offline copy of unuploaded Local data
or continued access after permission is removed. A signed-out ordinary window
shows Local only. An explicit public share link opens its limited guest view.

## 3. How records get their home

| Starting action | Record home |
|---|---|
| New scratch session on an owned personal host | That host, even if an organization is selected |
| Start from an organization cloud task or project | That organization's cloud records |
| Explicitly start a new session in an organization | That organization's cloud records |
| Start on an organization's managed host, or as a member using a shared host | That organization's cloud records |
| Start a new root session on a self-hosted server attached for organization work | That organization's cloud records, admitted by the Solus API before the provider starts; new personal roots are refused there (plans/009-organization-vms.md §9) |
| Continue a session admitted before the server was attached | Its saved home, Local included; the attachment converts nothing |
| Move a Local session to an organization | Changes its collaboration home to that organization |
| Share a Local resource | Publishes that resource to a chosen organization before creating its cloud share |

The host is a separate choice. An organization session can run on the owner's
laptop without granting other members general access to that laptop.
A task created by an agent normally inherits its session's record home.
An operation on an existing record always uses that record's explicit home.

A cloud home does not mean every member can read the record. Preserve the
resource's existing owner, team, organization, task-inherited, and link access
rules. Do not silently change the current managed-host sharing defaults as
part of this work.

The host keeps its checkout, files, running process, and runtime transcript.
The cloud stores the collaboration records and synchronized session content.
A cloud-bound write remains assigned to its organization while delivery is
pending. Do not fall back to Local or another organization on a network error.

## 4. Move sessions and share resources

Session moves, task and work publication, and insights access and sharing are
all in scope. A fix limited to the Share dialog's error message is incomplete.

### One cloud sharing path

Keep the existing cloud-resource links. Do not add a second public link path
that asks guests to connect directly to a laptop.

1. Resolve the record's existing home. An existing cloud record stays in its
   organization; the current window selection cannot redirect it.
2. For Local content, show the destination organization in the Share flow.
   Use the selected organization as a default only when the person can publish
   there. If none is selected, offer the account's eligible organizations.
3. Verify the person's authority to read the source and publish to that
   destination. Host attachment to the organization is not a prerequisite.
4. Publish the selected content and required assets; wait for cloud receipt.
5. Apply the selected access rules and return the existing cloud link format.

The Share action is the opt-in to publish. No additional confirmation dialog
is needed: choosing Share on Local content starts its upload at once, and the
dialog shows the upload until the receipt, then the usual people, general
access, and Copy link (maintainer decision 2026-09-30, like a document's Share).
Closing the dialog does not cancel an upload that started.
Do not return a working-looking link before its content is available.
A failed upload keeps the dialog on the upload with its reason and a Retry.

A session stays on its host for now (maintainer decision 2026-10-07): Share on a
session uploads nothing and opens the host's own share list at once. There is
no server publication operation.

A work or a task uploads with the person's sign-in, and the host link plays no
part (`cloud-sharing.md`). Concurrent actions for one resource join the same
upload and keep its original destination. An uploaded work or task leaves its
host only after the Solus API has it, and only if it did not change after it
was read. Insights reports are not shared (`cloud-sharing.md` §8, decision 7).

Sharing an individual work publishes that work and the assets needed to read
it. It does not publish its surrounding scratch conversation. Task sharing
retains its existing access inheritance for linked sessions and works; a task's
linked Local works upload with it, and its linked sessions keep their homes:
the organization's task lists them by title and host, and the host keeps the
task's row with its location and links (`cloud-sharing.md` §3a, §8). Do not sweep every session in the project into the upload.

Revoking a link removes link access. It does not delete cloud content, move it
back to Local, or remove access independently granted through a task or team.
Records cannot move from one organization to another (maintainer decision
2026-09-27). Local content can be published to an authorized organization; once
published, its organization home is fixed. A change of execution host does not
change that home. Existing organization references and links must not be retargeted.

### Session publication and movement

Not implemented (maintainer decision 2026-10-07): a session stays on its host,
and the publication operation below was removed. This section is the design
to start from if sessions move to the cloud later.

“Move session to Acme” publishes the selected session's history and its
session-owned Solus content, records its cloud home, and continues to sync
future session content there. Sharing a Local session uses the same operation
before it grants access. Unrelated Local sessions and separately owned linked
records retain their homes. Checkouts and agent execution stay on the host.

This needs a durable transition, not just a new label on a tab:

- Keep stable Solus session identity and explicit source/destination references.
- Establish authorized cloud delivery and access rules for the destination.
- Publish a consistent history snapshot, then deliver subsequent events in
  order. Retry safely without duplicate records or lost transcript events.
- Change the authoritative home and update tabs, search results, task links,
  works, and session insights references only after cloud receipt. Retain the
  host data required for execution and retry.
- For an active turn, keep its admitted execution context unchanged; do not
  reinterpret tools already running under Local authority. Publishing does not
  wait for the turn to end: the snapshot is sent at once, and the mirror sends
  the turn's rows again as they change (decision 2026-10-02).
- After commitment, subsequent turns, agent tools, child sessions, and queued
  work use the new saved context. Independently scheduled automations retain
  their own saved authority unless explicitly changed.
- On failure, preserve the source and show a retryable state. Do not delete
  Local data before receipt or leave two independent writable record homes.

### Insights

**Decision, 2026-09-27:** when Insights are available and the signed-in user
belongs to an organization, default **Send Insights to organization cloud**
to `true`. Include Local coding sessions as well as organization sessions.
The organization can observe coding activity, token usage, and cost across
execution hosts. Local Insights remain available. This setting does not
publish full session transcripts, works, or attachments and does not change
a Local session's record home.

Expose the setting and its destination on desktop, web, and mobile. Turning
it off stops further Insights uploads, including unsent delivery, while local
capture continues. It does not delete previously delivered cloud records.
Keep this separate from product analytics consent and explicit report sharing.

**One session, at most one organization.** Insights use the session's saved
organization for every turn. Organization selection is a client filter; it
cannot assign different turns of an existing session to different organizations.

An organization session uses its existing organization. For an unassigned
Local session, use the active organization once when establishing the session's
organization for cloud Insights, and save that association before delivery.
This does not itself publish its transcript or works. Any later publication of
the session must use that same organization; it cannot create a second
organization association. With no assigned organization, keep Insights Local.
The implementation must preserve this session-level association alongside the
existing Local/cloud publication state; a per-turn destination is not a separate
ownership choice.

Turns, child events, and delivery items inherit the session's saved organization.
Switching organizations, changing focus, resuming a session, and retrying uploads
must not change it. Background work also inherits the saved organization rather
than reading whichever window has focus when the work runs. The acting user may
differ between turns; the session's organization does not.

Cloud observability records must carry queryable `user_id`, `user_email`, and
`organization_id`. Use the verified acting account user for each turn, rather
than the session owner, host owner, or current reader. Email is a captured
account attribute; the stable user ID is the identity key. Carry this context
through child spans, correlated logs, local storage, mirror payloads, cloud
storage, query fields, and reports. Keep host, session, turn/trace, provider,
model, token, and cost fields so totals can be grouped by user and organization.
Retain whether cost is provider-reported or estimated; missing cost is unknown.
Signed-out Local capture must not invent an account user or organization.

Authorize cloud delivery and queries for the recorded organization. Insights
from Local work do not require sharing the execution host. Use the existing
mirror with scoped destinations and idempotent receipts so retries do not
double-count usage or cost. Do not gate Insights delivery only on a session's
cloud record home: Local Insights can have an authorized cloud destination.
The implementation must define historical backfill before enabling it; this
decision does not specify how much existing history to upload.

Insights remain available for authorized Local and shared-host sessions,
including after a session acquires a cloud home. Live diagnostics follow the
execution host. A cloud connection must not call execution-only metrics RPCs
as though the collaboration service were a machine.

Include sharing a selected insights report in this work. Recommended shape:
a read-only report saved as a work, with its selected session/turn data and
required chart data, published through the same cloud sharing path. Label the
report's capture time; live metrics still require the execution host. This
uses the existing work and share model instead of adding a public SQL endpoint.
Confirm the report fields during implementation against the Insights UI.

Moving a session must preserve links to its turns and insights. Publishing a
report must include enough data to read that report while its host is offline.
It must not upload the whole metrics database, unrelated sessions, or host-wide
logs. A copied Insights navigation URL is not a public share link.

Scope metrics queries, traces, flags, saved reports, and derived comparisons
before exposing shared-host insights. A baseline must not reveal another
organization's work. Retain the execution-host identity for source diagnostics
and the cloud home for a published report's permissions.

## 5. Sign-in and sharing

The ordinary cloud publishing path requires authenticated account authority
and permission in the destination organization. If signed out, Share can lead
to sign-in and then resume with the selected resource. Do not use a saved host
credential as silent permission to publish when the person is signed out.
An existing valid account session needs no fresh login for every share.

Anyone-with-link recipients can use guest access without signing in. Restricted
person/team/organization access requires a verified identity. Signing out does
not revoke existing links or delete published records. Shared-session prompts
still require the execution host and the existing provider/approval rules;
a cloud link does not grant general host administration or new-session access.

Accountless creation of cloud shares is technically possible, but it is a
separate ownership mode, not a relaxation of organization access. An anonymous
publisher would need a durable secret to update or revoke a share, bounded
storage/retention and upload limits, and an explicit later claim into an
account if supported. Losing that secret would affect control of the share.
This option is not selected for the first implementation. Do not invent a
hidden organization or broadly authorize anonymous organization writes.

A downloaded report or file can be sent without a Solus account. That is an
export, with no live updates or remotely revocable Solus link. Keep exports
available; do not require a managed VM for export or authenticated sharing.

## 6. Host ownership, admission, and delivery

A personal host has one owner and zero or more organization shares. A managed
host has exactly one owning organization. The share relation controls machine
use, not the destination of a published resource.

| Connection purpose | Required authority |
|---|---|
| Owner's Local work | Local owner, paired device, or verified remote owner |
| Owner's organization work on their own host | Host ownership and membership in that organization |
| Member's own sessions on someone else's personal host | Membership and a host share with that organization |
| Work on a managed host | Membership in its owning organization |
| Collaborating through a cloud session share | That resource's permissions and the existing scoped shared-prompt path |

A local/IPC transport proves local owner authority, not organization membership.
Use trusted admission evidence on IPC, direct sockets, and tunnels alike.
Directory metadata and renderer-supplied organization IDs are not authority.
Host administration, organization role, and resource access remain distinct.
Use the account user ID for cloud authorship; retain the Local owner sentinel
for Local records only.

The host needs cloud delivery for an owner's authorized session/publication
without being shared with that organization. A host token only identifies the
machine. Establish the actor, destination, and allowed work through an
authorized start or publication; do not grant the machine unrestricted access
to all organizations its owner belongs to. Renew that authority with current
membership and resource/host permission checks.

Persist destination scope on pending operations, session reports, delivery
cursors, and acknowledgements. An A grant cannot drain B's queue. Closing a
window does not stop delivery. Internal system calls and automations carry
their saved context rather than a process-wide current organization.

### Organization settings

An organization's owners can change Sync all Insights from Settings in any client
(plans/018). It is the only organization setting a client can change. Hosts get it in
the policy of their standing, as before. See `docs/settings.md`.

## 7. Window state and connections

Local and organization records can be visible together, but their connection
scopes remain separate. A window may need both a Local and an organization
connection to the same personal host. Deduplicate by endpoint, account identity,
and scope, not endpoint alone. Keep host health independent of these scopes.

One collaboration endpoint serves many organizations. Open its connection for
the selected organization, plus explicit temporary connections when needed.
Do not dial every organization at boot. An API handle never changes its scope;
admission supplies scope to handlers, while ordinary domain arguments do not
choose which organization a request is allowed to read.

Durable references contain the host home or account service + organization
home, together with the record ID. A bare `solus-cloud` ID is insufficient.
The current `workspace:<organizationId>` encoding is replaced outright; Solus
has no users, so nothing keeps reading it (decision 2026-09-26).
Cache keys, event subscriptions, pending loads, and snapshots include scope
and account identity wherever needed. IPC context belongs to the admitted
window/connection, not a shared main-process organization variable.

Keep Local tabs and drafts per window, and organization tabs and drafts per
organization within that window. Local tabs remain available across organization
switches; do not duplicate their sessions or drafts into every organization.
On an organization switch, save its tab state, stop its subscriptions, invalidate
late responses, and restore the next organization's set beside Local. Unmount
inactive organization conversations to bound memory. Restore input focus when
typing is the next action. Running sessions keep their own saved context.

Web routes, desktop window snapshots, and mobile selection all use the same
model. Two windows may select different organizations. An account default only
seeds new windows. Store immutable organization IDs; slugs are for navigation.
The client core owns one in-memory selection per window. Storage seeds that
selection once; it is not read again as a live selection source. Directory
refresh retains the selection while membership permits it. Denied browser
storage must not cause API routing and the visible selection to disagree.
Cross-organization links select the appropriate context or open another window.

Sign-out closes organization connections, clears rendered organization data
and credentials, and leaves Local available. Account-specific saved drafts
must not load for a different account or while signed out. Revocation denies
new admission and work; active authority lasts no longer than its bounded
expiry unless ended sooner. Retain pending output in its original destination
when renewal fails. Show access lost, not an unrelated host-offline error.

The directory lists machines once and exposes only shares the caller may see.
Account metadata supplies the collaboration endpoint and memberships. A host
removed from the directory can still have readable cloud records; its old
sessions do not silently switch execution hosts. With no execution host,
cloud boards work and the composer asks for a machine.

## 8. Isolation and existing implementation gaps

Scope checks must precede owner/resource shortcuts on list, get-by-ID,
mutation, search, event, asset, mirror, and resume paths. A fixed connection
scope alone is not proof of isolation. Scope presence and invalidation events
too. Preserve explicit resource-bound guest authority on the cloud service.

Use stable organization IDs for default checkout roots from the first
organization onward. Sharing with a second organization or renaming one must
not move paths. Explicit session publication does not relocate its checkout.
Record path ownership and scope rather than treating a prefix as authority.
Agents under one OS user can still reach that user's files and credentials;
this plan does not claim OS isolation. Hard isolation needs a separate
execution design with distinct OS users, containers, or VMs.

| Verified current path | Required change |
|---|---|
| `contexts/sharing/shares.store.svelte.ts`: destination from host identity, requires organization attachment | Resolve existing record home or selected publication destination; remove host-sharing gate and advice |
| Same store: moves works on opening Share; sessions/tasks must already be in cloud | Publish on the explicit share action; add session/task publication and cancellation/failure handling |
| `server/handlers/sharing-handlers.ts`: links only in API mode | Preserve cloud-resource links |
| `server/principal.ts`: host principals mostly map to Local; system has no scope | Carry verified scope through admitted and background operations |
| `sharing/share-manager.ts`, `sharing/event-audience.ts`: owner/system shortcuts | Enforce scope before resource permissions and delivery |
| `outbox/cloud-ownership.ts`: one global organization, managed-only task ownership | Route from the saved session/record home |
| Cloud delegations (`auth/host-access.ts` `delegationStanding`): a host shared with the organization | Done: the host owner acts for themselves in an organization they belong to without sharing the machine |
| `outbox/outbox-store.ts`: shown cloud operation rows lack destination organization | Persist scope through send, retry, and acknowledgement |
| `server/handlers/observability-handlers.ts`: host metrics queries without scope in these handlers | Audit access policy and queries; support scoped host insights and bounded report publication |
| `servers.store.svelte.ts`: execution filter checks roles only | Filter by actor, purpose, and organization without hiding Local data |

These findings come from a focused source review, not a complete storage and
handler audit. Older file comments sometimes describe retired host-based
sharing. The current server's cloud-only link guard is the implementation to
preserve. Keep backend scope checks even when the client hides an action.

## 9. Implementation order and scope

1. **Map record and execution ownership.** Inventory source stores, session
   metadata, task dependencies, works/assets, insight data, share entry points,
   background calls, caches, and transport boundaries. Define transfer receipts
   and recoverable states. Resolve the bounded report payload for Insights.
2. **Contracts and admission.** Add explicit scope, home and actor context,
   personal-host shares, and authorized publication/delivery. Implement cloud
   issuance and host validation together. Keep old Local flows working; do not
   enable multi-org host use until the host enforces it.
3. **Host records and delivery.** Scope sessions, tools, stores, paths, history,
  events, automations, outboxes, metrics, and mirrors. Remove global organization
  routing. Add the default-enabled cloud Insights setting and verified user,
  email, and organization fields through capture, delivery, and query surfaces.
  Prove concurrent Local/A/B work and scope-safe transfers.
4. **Move and share flows.** Remove host-sharing coupling across sessions,
   tasks, works, and insights. Implement destination selection, publication,
   receipts, retries, cloud links, and explicit Local-to-cloud session moves.
   Preserve existing shared-prompt provider and approval semantics.
5. **Window and client integration.** Keep Local plus selected-organization
   host/cloud data accessible. Update tabs, routes, snapshots, stale guards,
   record deduplication, and all Share/Move/Insights entry points on desktop,
   web, and mobile. Include command palette and keyboard paths.
6. **Directory cleanup and removal.** Read collaboration service metadata
   from the account. Delete the old service catalog and every reader of the
   retired encoding in the same release. Preserve scope in saved homes.

Solus has no users (maintainer decision 2026-09-26): there is no backward
compatibility, no data migration, and no dual model. The developer resets
their own data directories and the cloud database when schemas change; an
agent still never touches live data. Do not add anonymous publishing or a new
metrics platform as an incidental extension. Per-user push changes are separate
unless existing notification delivery prevents the scoped model from working.
The structural refactor that preceded this feature work is
[plan 007](../../plans/007-solus-api-organization-refactor.md); §0 above names
where each concern now lives.

## 10. Required proofs

- Organization selection, sign-in, and host sharing do not publish Local
  sessions, works, or attachments. The separate cloud Insights setting can
  copy their observability records. Local remains visible beside A's records.
- Cloud Insights defaults on for a member with Insights available. A Local
  session keeps its Local home while its activity and cost reach the resolved
  organization. Turning the setting off stops unsent and future uploads without
  stopping local capture. Signed-out use does not upload with a stale identity.
- Two authors in one session retain their own user IDs and emails on turns and
  child events. Organization filters apply to cloud reads and aggregates;
  retries, reconnects, and session publication do not count the same cost twice.
- A session assigned to A reports all turns to A. Switching the client filter
  to B, then resuming that session, does not send its next turn or pending
  uploads to B. Separate sessions assigned to A and B stay isolated. A Local
  session that already sends Insights to A cannot later be published to B.
- A laptop is the only execution host, is not shared with A, and its owner can
  publish a session/work/report to A. Another member gains no general host use.
- An existing cloud resource keeps its organization when shared from a window
  with another selection. Cancelled Share performs no upload.
- Local session move preserves identity, history, task/work references and
  insights links. Active-turn movement waits for a safe boundary. Retry after
  partial receipt loses no data and produces no duplicate writable authority.
- Sharing one work leaves its scratch session Local. Task publication carries
  the intended linked resources and preserves the existing permission rules.
- Cloud share links remain readable while the source host is offline; prompts
  retain existing runner/account/approval requirements. Revocation is effective.
- Anonymous anyone-with-link access works. Restricted shares verify identity.
  Signed-out publication requests sign-in and resumes the selected operation.
- Local, A, and B work on the same host cannot read, write, stream, export,
  acknowledge, or discover each other's records through the wrong scope.
- Shared-host Insights cannot expose other organizations through queries,
  traces, flags, or baselines. Published reports work offline and contain only
  their selected data; live views use the execution host.
- Switching A to B preserves Local tabs and restores B's tabs. Late A results
  cannot populate B. Two windows do not change each other's scope or snapshots.
- Sign-out/account change removes organization views while preserving Local.
  Pending cloud writes never fall back to Local or a different organization.
- VM sessions and cloud mirrors appear once. Host removal preserves available
  cloud history; cloud-only accounts can browse before choosing any machine.
- Exercise Claude and Codex, desktop IPC, direct/remote sockets, and desktop,
  web, and mobile. Scoped insights must work for both providers' available data.

Use focused contract, admission, transfer, delivery, permission, store, and
client tests. This documentation revision did not start an app or run runtime
tests; those checks belong to implementation.
