# Artifacts storage and live updates

Updated: 2026-10-15. Local Git and Cloudflare Artifacts work history are implemented
in this worktree, reconciled with main at `889dde187`. No production migration or deployment was performed. Repository
provisioning adapters, shared sync-status UI and cloud repair jobs remain planned.
This replaces the earlier archive-only proposal in this file.

## Agreed scope

Local works keep drafts in SQLite and committed history in local Git repositories.
They remain offline-capable. When Share moves
one to the cloud, Artifacts can become the durable owner of its published
current content, content metadata and history. Postgres keeps identity,
organization, access rules, comments, reviews, live-edit state, pending saves
and derived search/list projections. A current Postgres body newer than the
accepted Artifacts commit is a durable pending draft, not committed content.

For code repositories, Artifacts is an optional Git remote used by managed
cloud hosts. Hosts still run ordinary Git in a container with a real checkout.
ArtifactFS is excluded. No automatic commit of dirty code is introduced.

A moved local work follows the cloud owner as it does today. Keeping its local
copy does not introduce offline editing of that cloud-owned work.

## Settings and record ownership

Read and validate these server settings once at startup:

```env
SOLUS_REPOSITORY_STORAGE=upstream
SOLUS_WORK_STORAGE=database
```

The alternative value for each setting is `cloudflare-artifacts`. The cloud defaults
preserve the existing behavior. These are separate settings: enabling one does not
require enabling the other.

`SOLUS_REPOSITORY_STORAGE` controls newly provisioned managed checkouts.
`SOLUS_WORK_STORAGE` controls newly created or published works in the cloud
record service. Ordinary hosts default to `local-git`. Local works always use the
local Git target; organization membership alone does not select Cloudflare.
`database` remains the default for an unconfigured cloud service and the fallback
for legacy cloud records. The code-repository setting is still planned.

Persist the provider on each work and managed project with its namespace,
repository and remote mapping. Changing a default affects new records only.
Existing records keep their provider and continue to need its credentials.
Invalid values or missing required configuration fail startup with a clear
error. A later Artifacts outage keeps pending saves and reports failure; it
never silently changes providers.

Both Worker configuration and container startup must carry the applicable
settings. Bind the selected Artifacts namespace explicitly; generate binding
types. Bindings are capabilities, not text environment variables. Use a narrow,
authenticated server connection between the Node container and Worker for
repository operations and short-lived token issuance. Do not expose it or its
tokens to clients or agent tools. Reuse the private host control path where
appropriate, rather than creating a generic public Git-token endpoint.

## Modules and code locations

Keep domain behavior in `packages/server/src/data/works/work.ts`: content
versions, immutable checkpoints, previous revision, restore, authors, validation
and conflict checks. Introduce a small work-content storage interface with a
database fallback and one Git archive adapter with local and Cloudflare targets. The interface must distinguish
capturing a durable draft from completing a remote commit.

Implement work records and pending-operation persistence in `data/works/`.
Compose an archive writer and the selected adapter at server boot. Keep network
scheduling outside database transactions and outside the data layer's
persistence helpers. Use the existing layer rules: data does not import sync,
execution or transport. Worker-specific credentials and repository management
stay in solus-cloud; Solus consumes an injected transport-neutral interface.

Read current content and manifests at the recorded accepted commit id. Read
revision bodies by their persisted commit/path/hash. Check their content hashes.
`Work.revision`, `previous`, `restoreRevision`, creation, all write paths,
export and deletion must use the same storage owner. Clients retain the same
work methods. Git hashes remain private storage references; Solus content
versions and revision ids keep their current meanings.

Code-repository provisioning is a separate module under `packages/server/src/git/`
with upstream and Artifacts adapters. Keep `CheckoutService` and ordinary Git
operations responsible for checkouts and worktrees. Integrate provisioning
with `project-config/dispatch-checkouts.ts`, `git/partial-clone.ts`, and the
existing Git execution/authentication path. Do not duplicate generic Git
commands inside each provider adapter.

## Work representation

Start with one Artifacts repository per work and one managed main branch.
Store the native content file and a versioned manifest. The manifest includes
work title/type, content version/hash/author, previous revision, revision
summaries and their commit references. Initial publication includes every
existing checkpoint. Preserve all four work types and embedded reference text.

Keep comments, reviewer decisions and permissions in Postgres as domain data.
Publication must transfer comments and reviewer records correctly, including
identity rules for local users and guests. Today `WorkTransfer` omits reviewer
records: the proof measured one source reviewer becoming zero after import.
Fix its contract, fingerprint and upload validation before enabling migration.
Publishing content does not copy source authorization into the destination.

Postgres projections support work lists, search and the active editor. Record
which Artifacts commit each projection represents. Persist each revision's
archive reference. Historical body columns may be cleared only after verified
upload. Current projections are rebuildable from the accepted commit; permissions,
reviews and live-edit receipts still require normal database backup.

Do not send the entire exported history for an ordinary save. Send the current
body, changed manifest fields and new immutable revision bodies. Page initial
history transfer and migration so memory does not grow with the whole archive.

## Live updates and commit policy

Yes: debounce automatic work commits and pushes on the server, per work.
Debounce network archiving only. Never debounce the durable receipt for an
accepted live update or its broadcast behind a Git push.

Keep the existing `WorkLiveManager` behavior: save Yjs state and client sequence
receipts before acknowledging and broadcasting. Keep the existing readable-body
projection cadence: 800 ms idle, maximum 4 seconds. Its flush stays a local
projection operation; an agent read must not trigger a network push.

Start the Artifacts writer with these proposed internal defaults:

| Trigger | Archive behavior |
|---|---|
| Ordinary edits pause | Commit and push after 3 seconds without a new durable content edit |
| Edits continue | Make the latest accepted state eligible within 30 seconds of the first unarchived edit |
| Explicit checkpoint, agent write, restore, upstream pull, review request | Preserve the exact version and schedule it immediately; never coalesce it away |
| First publication | Wait for complete verified upload before returning success and permitting location handoff |
| Last live client leaves | Flush the readable projection and make pending content eligible immediately |
| Process shutdown or planned host stop | Drain within the shutdown budget; retain every unfinished payload durably |

These timings control eligibility, not a guarantee that network completion
occurs within 30 seconds. Keep them as testable policy constants initially,
not another set of user settings. Tune after measuring realistic edit traffic.

Set archive dirtiness, a monotonic pending generation, first-dirty time and
last-edit time in durable storage alongside accepted cloud live updates. A
client receipt must not commit without the information needed to archive it.
At execution, project the latest durably accepted Yjs state into a consistent
snapshot; do not rely on a body projection timer having fired. After restart,
scan durable pending generations and reconstruct due work without waiting
for a client to reconnect. No memory-only timer is a durability guarantee.

Coalesce ordinary drafts only. Git autosave commits do not add a visible Solus
checkpoint for every batch. Preserve the existing history semantics: agent
writes retain displaced and new bodies; restore creates a new revision; a
review points at the exact requested checkpoint. Capture required bodies and
attribution before coalescing. Multiple live contributors must not all be
credited to the last typist merely because one batch became one Git commit.

A review request or explicit checkpoint may be durable but awaiting archive;
show that state and retain its fixed body. It must not claim remote completion
until confirmed. Publication is stricter: it cannot finish with a pending archive.
The timing policy does not change Google-linked read-only behavior.

## Push ordering, recovery and client state

Allow one in-flight operation per work across writer instances, using a database
lease with expiry and fencing. The next operation must not push until the prior
one has been reconciled. Snapshot generation N, its expected remote head,
operation id, immutable payload and proposed commit are durable before pushing.
A Git commit contains the operation id for response-loss reconciliation.

A database transaction captures the operation. Push outside the transaction.
A second transaction records the accepted commit and archived generation.
Update accepted state only if the operation still holds its fence. Edits received
during a push remain pending as N+1; completing N must not mark them committed.

Build commits from the expected head and use a checked ref update. If the
remote already contains the recorded operation, finalize it without a duplicate
commit. A different remote head is a conflict to reconcile or report, not a
reason to overwrite it. Never rewrite existing work checkpoints.

Use bounded retry backoff with jitter. Keep immutable checkpoint operations and
pending drafts through outage, token expiry, process restart and a lost response.
Cap concurrent Git processes and scratch storage across works. On sustained
failure, retain payloads and report the failure; define queue size limits and
backpressure without deleting accepted edits. Delete completed scratch storage.

Expose shared work archive state: database storage, pending, syncing, synced,
or error. Include latest saved generation, committed content version, last
accepted commit internally, and a safe last error. Derive the state from durable
records. Add the shared RPC/HTTP shape, events and client store refresh guards.
Desktop/web and native mobile must show the same state after reconnect. Presence
and live updates continue through the existing transport; Artifacts is not the
collaboration event channel.

## Code repositories on cloud hosts

Persist a project repository mapping independently of the selected default:
provider, canonical project identity, upstream URL when present, Artifacts repo,
clone remote and the last verified pushed refs. A ref observation is evidence
of remote state, not a promise that every dirty file was saved.

With upstream storage, preserve current clone and push behavior. With Artifacts,
create/import a repo, acquire a short-lived scoped token, and clone using the
existing full-history partial-clone policy. Explicitly verify needed branches
and tags. Preserve the upstream as `origin` when it exists; add `artifacts` as a
separate remote and choose clone source and push destination through the stored
mapping. For an Artifacts-only project, its remote may be `origin`.

Project identity currently follows `origin` in `project-identities.ts`. Keep the
canonical upstream identity stable even when the clone source is Artifacts.
Update dispatch, review checkout, branch tracking and restoration code to use
explicit mappings instead of assuming one remote serves every role. GitHub PR
operations continue to target the appropriate GitHub repo. Artifacts-only
projects must state that GitHub PR creation is unavailable without an upstream.

Import is an initial copy, not continuous two-way sync. Fetching upstream and
publishing branches there are explicit operations. Never automatically push
private Solus branches to upstream. Push already committed Solus branches to
Artifacts at the selected checkpoint/turn-completion policy and verify refs.
Do not debounce `git add` or `git commit` over arbitrary coding changes.

Tokens stay out of URLs, argv, persistent Git config and logs. Extend the existing
auth path with a scoped temporary helper without bypassing acting-user rules.
Cover automatic lazy fetches, linked worktrees and token refresh. Never put a
Cloudflare account token in an agent's environment.

The active checkout, staged/unstaged/untracked files, ignored configuration,
dependencies and output still occupy host disk. Artifacts restores pushed commits;
R2/native snapshots restore the rest of the host. Reconcile Git state after
restore, and do not overwrite dirty worktrees. The environment variable cannot
remove checkpoint requirements or close the unexpected-container-loss window.
Our proof did not establish useful checkout disk savings from Artifacts alone.

## Delivery sequence

1. Lock the storage ownership decision in an ADR. Add validated settings and
   persisted per-record provider mappings. Defaults keep current behavior.
2. Fix complete reviewer transfer and its identity rules. Add round-trip tests.
3. Implement the database work adapter and lazy revision/current-content reads
   without changing existing SQLite behavior. Add Artifacts representation and
   cloud credentials through the Worker/container connection.
4. Add durable pending capture, per-work writer, leases, bounded retries and
   restart reconciliation. Integrate Yjs save/projection, all body writers and
   metadata changes. Add shared archive state and all client displays.
5. Route cloud creation/publication through Artifacts when selected. Wait for
   verified history before the existing `workMarkMoved` call. Retain the local
   fingerprint guard and existing ids, task links and work embeds.
6. Add managed repository provisioning with explicit remote mappings, credential
   renewal, upstream policy and checkpoint integration. Keep ordinary Git and
   provider behavior unchanged. Verify on a disposable cloud host.
7. Backfill existing works and migrate repositories only through explicit jobs.
   Verify every body/ref before clearing old archive bodies or changing mapping.
   Add repo deletion, retention and orphan cleanup. Changing a default is not a
   migration or rollback of existing records.

## Acceptance tests

Use fixtures and disposable services; no live data or deployments in this plan.
Inject a clock and transport barriers instead of tests based on arbitrary sleep.

- All four combinations of the two settings; invalid configuration; settings
  changed while existing provider mappings remain fixed; database-only startup
  without Artifacts credentials.
- Existing work tests on SQLite and disposable Postgres; four work types,
  current content, every immutable checkpoint, comments, reviewer decisions,
  linked tasks, embeds, Google read-only pulls and actual asset serving.
- Two editors receive updates before archiving; idle and continuous-edit batch
  deadlines; duplicate live sequences; identical body avoids duplicate commits;
  edits during an in-flight push remain pending; immutable versions survive
  coalescing and restore.
- Crash after live receipt, before projection, before push, after push and before
  finalization. Resume without missing accepted edits or duplicate revisions.
  Competing writer leases, expired tokens, failed hashes and remote-head conflict.
- Publish, turn off the source host, reopen, edit, review, restore, restart the
  cloud process and reopen again. Verify accepted commit hashes and permissions.
  Repeat through desktop-local, desktop-hosted, standalone remote, web and mobile,
  and one real Claude and one real Codex flow.
- Repo clone/history/branches/tags, lazy fetch, linked worktrees, token renewal,
  push/ref verification, upstream/GitHub PR routing and project identity.
  Restore pushed commits after host loss separately from R2/snapshot recovery of
  dirty and ignored files. Refuse conflicting upstream changes without overwrite.
- Measure initial publication peak memory, ordinary-save bytes/time, Git scratch
  disk, concurrent queue growth, checkpoint time and failure recovery. Assert
  resource claims only after measuring, not from the selected provider name.

## Evidence and release limits

The [proof report](cloudflare-artifacts-proof.md) records 63 existing work tests,
10 storage proof tests, and a focused real Solus restore-and-republish test.
The current prototype accepts full exported history and is not the product
adapter. It does not prove bounded memory, full client behavior, or the final
pending/live-update architecture. No production migration is authorized by this
plan. Implementation spans Solus and solus-cloud, their schemas and coordinated
release inputs. Migration and deployment remain separate work.

Cloudflare documents [binding reads and repository operations](https://developers.cloudflare.com/artifacts/api/workers-binding/)
and [sandbox Git integration](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/).
Use native Git in the existing Node container for the first writer. A Worker-only
writer is possible but needs separate resource measurements for Solus workloads.


## Implemented work adapter

`data/works/work-storage.ts` is the content I/O interface and provider resolver.
`database-work-storage.ts` retains transactional draft and legacy body storage.
`git-work-storage.ts` captures durable pending bodies and reads immutable
archived bodies with hash checks. `sync/works/work-archive-writer.ts` handles
batching, leases, frozen operations and response-loss reconciliation.
`git-work-transport.ts` constructs and pushes Git objects without a checkout.
`cloudflare-work-repositories.ts` implements real scoped repository access.
`local-work-repositories.ts` provides the same operations on bare repositories
under `<dataDir>/works/history/work-<hash>.git`. `dataDir()` honors the desktop
data path and `SOLUS_DATA_DIR`; the default standalone path is `~/.solus`.

Work creation, body writes, checkpoints, revision reads, restore, duplication,
export and deletion now use this storage path. Metadata mutations schedule an
archive manifest update. Existing local works migrate in batches of five.
The migration preserves content versions and revision ids; archived revision
bodies leave the database only after Git accepts the commit. Legacy cloud rows
keep their existing provider.
Provider, repository and account/namespace identity are persisted, so changing
configuration does not reinterpret existing records. Cloud upload waits for
archive acceptance before returning to the location-handoff client flow.

The server reads these settings; do not put a real token in source control:

```env
SOLUS_WORK_STORAGE=cloudflare-artifacts
SOLUS_ARTIFACTS_ACCOUNT_ID=<account-id>
SOLUS_ARTIFACTS_NAMESPACE=<namespace>
SOLUS_ARTIFACTS_API_TOKEN=<server-secret-with-Artifacts-access>
```

The first implementation uses the REST control plane from the Node service.
The injected transport interface also allows a future Worker binding connection.
The secret is server-only. Git receives a short-lived repo token through a
temporary askpass helper; neither token is saved to a remote URL or Git config.
The host's local work storage default is `local-git`. Existing Artifacts
records continue to require their original account/namespace configuration even
when the new-work default is switched back to `database`.

Autosaves use a 3-second idle deadline and a 30-second maximum batch deadline.
Checkpoints and deletion become eligible immediately. An operation already in
flight keeps its immutable payload; newer edits stay pending. The runtime polls
durable deadlines with one in-flight background batch per process. Shutdown
cancels network work and preserves incomplete operations for startup recovery.

The live store records archive dirtiness, last edit attribution, body version
and projection state with the Yjs state and client receipts. The version guard
repairs stale live state after an external body commit; it cannot overwrite a
newer agent body. Ordinary drafts coalesce without discarding bodies referenced
by checkpoints or a frozen in-flight operation. After restart, the writer can project that saved
state without waiting for a client to open the work. Restoring an archived body
reads it before taking the mutable work lock. Exports capture a consistent
snapshot before reading immutable archived revision bodies.

Current content and metadata remain Postgres editing/search projections. The
accepted manifest and all referenced bodies live in the selected Git repository; reconstructing a
whole missing database projection from a manifest is not yet an exposed repair
operation. Reviewer transfer still needs the separate fix above. The adapters
are not a claim that asset serving, client sync status or cloud repair jobs
are complete. The code-repository environment setting remains planned and is
not accepted by this work-content runtime.

The existing `boot-server.ts` exceeds the repository file-size guideline. This
change adds only the storage startup and shutdown calls; the implementation
lives in the new focused modules.


## Local Git and publication proof

Local and Cloudflare targets use the same commit builder, durable operation writer,
revision-body reader, and work domain methods. Publication imports the Solus revision
history into the destination repository. It does not preserve the source repository's
Git commit ids or graph: the destination records a new publication snapshot. Direct
external edits to these internal repositories are not supported.

Tests cover local create/edit/restore/delete for all four work types, legacy history
migration, native Git commits, restart, publication, member and guest reads, guest
edits, stale-save refusal, cross-organization refusal, and share-link revocation.
The maintained Lab recipe is `.claude/skills/verify-multiplayer/features/work-git-storage.md`.
No frontend contract changed; desktop, web, and mobile continue to call the same
record and live-edit APIs. Client screens were not driven.

## Work history source comparisons

Desktop and web History now offer a source diff for documents, slides, HTML
artifacts, and diagrams. Readers can select a base version, switch between
unified and side-by-side layouts, toggle word highlights, and see added and
removed line counts. The shared code diff renderer also marks moved blocks.
Whitespace changes stay open because they can affect prose and HTML output.
The existing rendered comparisons and restore action remain available.

Comparisons read immutable revision bodies through the existing work history
store and storage adapter. They do not compare archive heads: an unsaved draft
can be newer than the latest Git commit, and publication creates a new Git
graph. Current draft changes remain selectable, an explicit empty base stays
empty, and stale body requests cannot replace a newer comparison. Failed
revision reads can be retried.

No new RPC, Git process, or cloud credential is needed in the client. Local Git
and Cloudflare Artifacts use the same revision API. Native mobile work history
is a separate task, as explicitly agreed for this UI change.


## Integration with main, 2026-10-29

The proof implementation is reconciled with main at `240c0d511`. New migrations
are generated as `0029_work_storage_adapters` for SQLite and Postgres; the old
proof branch's `0021` migrations are not installed over main's newer history.
Service-owned Git operations use the current `hostCliEnv` API. The reviewed
acting-identity rule names why these private archive operations act as the host.

Main's live-document write batching is retained: pushes update the room in
memory, and clients keep device copies until edits pause. The pause/read/close
flush saves the live document, author, receipt and projection marker before
writing the readable body. Recovery can project that saved document after a
restart, including a failure between saving the document and writing its body.
This supersedes the earlier proof's write-on-every-push behavior.

The Lab's guest record requests now use the authenticated socket transport,
which is how current clients make these requests. Member HTTP checks retain
their existing transport. Review-role fixtures use current resource standings.
The composition test accounts for the newer standalone webhook receiver route.

Verification on the integrated checkout:

- Work storage, live editing and history: 45 unit tests pass; one optional real
  Cloudflare test is skipped.
- Work versions, revisions, writes, reviews and shared diff utilities: 66 pass.
- Access policy and review fixtures: 48 pass (the review tests overlap the
  preceding group).
- API composition: 5 pass. API service: 2 pass.
- Acting-identity lint rule: 1 pass. Focused lint and Svelte compilation pass.
- Targeted TypeScript checking has no diagnostics in the changed implementation;
  six diagnostics remain in existing Lab host-kind, broken-pipe, database engine,
  and API-mode dependencies.
- Multiplayer Lab `work-git-storage`: 49 checks, zero failures, including local
  Git, restart, publication, member and guest reads, guest editing, stale-save
  refusal, link revocation, and cleanup. Evidence is kept in
  `.solus-local/lab-cloud/evidence/work-git-1793294580641/`.

The real Cloudflare proof from October 15 remains historical evidence; it is
not claimed as a new integration run. Cloud activation still requires the
server's Artifacts configuration. This integration performs no deployment and
uses only disposable test data. Desktop and web use the shared History view;
interactive screen verification and native mobile history remain outstanding.
