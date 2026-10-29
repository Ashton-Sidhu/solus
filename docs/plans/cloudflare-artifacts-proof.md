# Cloudflare Artifacts proof

Date: 2026-10-13. Solus source: `a27f9f43b96e6949a29f09895185c2643eed88ff`.
Branch: `solus/proofcloudflare-artifacts`.

The agreed product rule is local first. Local works retain their current
database storage and offline behavior. Publication transfers their history to
Artifacts. The organization becomes the authority through the existing location
handoff. The source keeps its local copy.

This branch contains an experimental fixture runner and evidence. It changes no
product storage path. Instructions are in
[the proof README](../../scripts/proof/artifacts/README.md).

## Outcome

Artifacts passed the tested storage operations for both works and repositories.
The current ArtifactFS configuration did not provide sustained disk savings in
the synthetic coding task. Do not change managed-host checkout behavior based
on its small initial footprint.

| Proof | Result |
|---|---|
| Existing work version, revision, review, live-edit and write-path tests on SQLite | 63 passed |
| The same five files on disposable Postgres 17 | All passed when run separately; concurrent run exposed a timing-sensitive existing test |
| Work snapshot and recovery prototype against real Artifacts | 9 passed |
| Work history scale check against real Artifacts | 1 passed |
| Partial-clone repository comparison | 11 passed; 3 product lanes explicitly blocked |
| ArtifactFS against real Artifacts on the Omarchy VM | 6 passed after fetching all branches and tags explicitly |
| Deployed Worker binding | 5 passed |
| Targeted proof TypeScript, lint and whitespace checks | Passed |

## Works

The fixtures use real Solus work creation, edits, immutable checkpoints, restore,
comments and exports. They cover docs, diagrams, slides and HTML artifacts.
The final human edit is newer than the final checkpoint. Its current body and
the saved history both survive the Git round trip. Asset and work references
are preserved as text; asset serving is not tested.

The Git prototype uses one repo per work. Historical commits hold the native
body and revision metadata. The current commit holds the current body and a
metadata index. A separate SQLite journal records a pending operation before
push and marks it complete afterward. Tests inject failure before push and
after remote acceptance, reopen the journal, and prove recovery without duplicate
commits. Concurrent writers use the expected remote ref; one push succeeds.

A fresh Git reader reconstructs the transfer. The existing Solus importer
accepts it in a separate SQLite fixture database under the destination
organization, with the same fingerprint. A changed source refuses the old
publication handoff and remains local.

The scale fixture has 40 revisions containing 5 MiB of historical bodies. A
small next edit uses 248 KiB of temporary Git storage and takes about 2.03 s.
The one-revision comparison uses 240 KiB and about 1.45 s. Historical bodies are
not downloaded for that ordinary remote update. However, this prototype still
accepts a complete exported snapshot as input and journals it. This result does
not establish bounded application memory or the final incremental write model.

**Existing publication gap:** a fixture with one recorded reviewer and an
approval has zero reviewers after the existing transfer/import. `WorkTransfer`
carries work metadata, history and annotations, but not reviewer records. A
production migration must resolve this before claiming review preservation.

Evidence: [work storage](../../scripts/proof/artifacts/results/works-cloud.json),
[scale](../../scripts/proof/artifacts/results/works-scale.json).

## Git repositories

The fixture has complete history, branches, a tag, a merge commit, executable
files and a symlink. It has approximately 16 MiB of obsolete binary bodies,
8 MiB of current assets, 100 source modules, one real npm dependency, 16 MiB of
synthetic dependencies and 8 MiB of synthetic output.

The partial-clone runs preserve the selected commit, merge base, history,
branches and tag. Search, tests, linked worktrees and independent commits work.
A tar checkpoint restores staged changes, unstaged changes, untracked files,
ignored configuration and installed dependencies. A competing upstream push is
refused, and rebasing conflicting changes exposes a conflict. Read-scoped
Artifacts tokens cannot push.

On macOS, the local upstream and Artifacts partial clones both use about
16.6 MiB at checkout and 40.6 MiB after dependencies and output. Changing the
remote alone does not provide a useful disk saving in this fixture.

ArtifactFS was built from Cloudflare commit
`2b87a48691ef4ae82d391b7bbe4976c06c7fadf7` and run on the Omarchy Linux VM
against a real Artifacts HTTPS remote. Disk measurements count backing files,
including its Git objects, cache, SQLite state and writable overlay.

| Phase on the same VM and remote | Partial clone | ArtifactFS |
|---|---:|---:|
| Ready | 16.59 MiB | 0.31 MiB |
| After status, source search and tests | 16.59 MiB | 18.55 MiB |
| After dependencies and output | 40.62 MiB | 43.42 MiB |

Preparation took 1.71 s for the partial clone and 0.58 s for ArtifactFS.
The first clean status took 59 ms for the partial clone and 42.59 s for
ArtifactFS. During the reads, the cache reached 114 blobs and 8.35 MiB. These
are observations from one synthetic workload, not general performance limits.

The default ArtifactFS acquisition omitted the baseline tag. The proof then
fetched all branch refs and tags explicitly. Commit, rename, deletion, new
files, push, linked worktrees and recovery of staged, unstaged, untracked and
ignored changes after daemon restart all passed.

The first cloud transfer returned HTTP 500. A later run used bounded retries
with remote-ref verification and completed. Production transfer must reconcile
a successful remote write whose response was lost.

Evidence: [partial clones](../../scripts/proof/artifacts/results/repositories-cloud.json),
[first ArtifactFS run](../../scripts/proof/artifacts/results/fuse-first.json),
[ArtifactFS on Artifacts](../../scripts/proof/artifacts/results/fuse-cloud.json).

## Worker and cleanup

A disposable Worker used the actual Artifacts binding. It read current and
historical file content, listed commits, forked a repo, deleted the fork,
revoked a read token and refused unauthenticated access. It had no repository
checkout. A repeat run initially received 401 while its new secret deployment
reached the edge. The harness now waits for authenticated readiness; the next
run passed. Git writes in the work prototype run in Node/Bun, which matches the
current cloud application's container execution model. A Worker-only writer
and Worker peak memory were not measured.

All test repositories, the fork, the test Worker and the disposable Postgres
container were removed. The Artifacts proof namespace was checked empty.
The empty namespace remains available for future runs. No live Solus data,
existing cloud deployments, user repositories or provider credentials were
used as fixtures. Reports contain no token values.

Evidence: [Worker](../../scripts/proof/artifacts/results/worker.json),
[FUSE resource cleanup](../../scripts/proof/artifacts/results/fuse-cleanup.json).

## Remaining acceptance checks

The full product proof is incomplete. The branch does not install an Artifacts
storage adapter in the publication or work-edit paths. It therefore cannot
prove those paths through desktop, web, mobile or real Claude/Codex turns.
Postgres domain behavior is tested, but an Artifacts transfer into Postgres is
not. Google-linked works and actual asset serving are not exercised.

The tar and daemon-restart proofs do not establish managed Cloudflare container
loss recovery, R2 restore or native snapshot recovery. The Git disk-saving
condition already failed in this fixture, so a managed-host rollout is not
supported by these results.

The concurrent Postgres baseline failed
`when the last client leaves, the body is written and the doc leaves memory`.
That existing test sleeps 10 ms before reading. It passed alone, and all five
files passed when run separately. This is recorded as a timing-sensitive test
finding; the proof does not change live-editing code.

Recommended next implementation: cloud work revision storage at publication,
with a durable incremental-write receipt and a complete review transfer.
Retain the current managed-host partial clone while investigating cache and
status behavior separately.

## Current cf login verification

On 2026-10-13, the current cf OAuth login was used for fresh disposable repos
in the `default` namespace. No Worker was deployed or application server
started. The five existing SQLite files again passed all 63 tests.

The work proof passed all 10 tests. This run extended real cloud coverage to
import into a separate Solus SQLite database, restore through `Work`, recovery
after a lost push response and journal reopen, failure before push, corrupt or
rewritten history refusal, and competing writers. All four native work types
round-tripped with exact current content, history, author metadata, comments
and reference text. A read token could read but could not push.

An additional focused run passed the strengthened import test: restore in
Solus, export the new content version, publish it back to Artifacts, and read
the same transfer from a fresh Git store. This uses the actual domain methods
and an experimental adapter, not the product cloud upload handler.

The 40-revision fixture held 5 MiB of history. Its next small save used 248 KiB
of temporary Git storage and took 2.98 s. The one-revision fixture used 240 KiB
and took 2.67 s. The full-history input limitation still applies. The reviewer
gap was reproduced: one source reviewer, zero imported reviewers.

Both runs verified deletion of their owned cloud repos and reported no cleanup
errors. Git credentials now pass through askpass, not Git configuration or
remote URLs; tracing is disabled. Targeted lint, proof TypeScript, helper syntax
and whitespace checks passed. No production storage or client behavior changed.

Evidence: [fresh cf run](../../scripts/proof/artifacts/results/works-cf-refresh.json),
[restore and republish](../../scripts/proof/artifacts/results/works-cf-restore.json).
The proposed product changes are in
[Cloud work history in Artifacts](cloud-work-artifacts-integration.md).


## Work adapter implementation

The worktree now contains database and real Artifacts content adapters, persisted
provider/account/namespace mappings, and a durable archive writer. All work body
and revision paths use the interface. Cloud publication waits for confirmed
archive acceptance. Local and legacy works retain database storage.

The latest focused SQLite run passed 81 tests across six files, with the real
cloud test skipped in that run. The separately enabled cloud test passed all
18 assertions: all four work types, agent edits, exact archived reads, restore,
recovery of a lost push response to the identical commit, and verified deletion.
The default namespace was checked afterward and contains only `starter-repo`.

The adapter test file passed on a disposable Postgres 17 server. Two cases are
intentionally excluded there: the separate SQLite source/destination fixture
and the real cloud integration. The five existing work files passed separately
on Postgres; the live file was rerun after the projection-version change.

New tests cover stable defaults, account/namespace mismatch, stale writes,
rollback, bounded draft coalescing, idle/max deadlines, edits during push,
claim fencing, deletion retries, and two live restart races. A durable live
receipt arriving after projection cannot be recorded as archived with an older
body. An older live state cannot overwrite an agent body committed before its
live absorption callback. Legacy NULL empty bodies remain compatible.

Targeted lint and whitespace checks passed. Typechecking remains blocked by
errors in unchanged dependencies; no diagnostics name the changed storage
modules. The module-boundary check reports two crossings in unchanged files:
`admission/scope.ts -> data/sessions/session-lineage.ts` and
`execution/sessions/background-session-title.ts -> transport/events/host-event-publisher.ts`.
These checks are not reported as passing. No UI or real provider turn was run.

The disposable Postgres container and cloud repositories were removed. No
production deployment or live data migration was performed. Repository
provisioning, visible sync state, reviewer transfer and explicit migration/repair
jobs remain separate planned work. Implementation notes and configuration are
in [the integration plan](cloud-work-artifacts-integration.md).
Evidence: [adapter verification](../../scripts/proof/artifacts/results/work-adapters.json).


## Lab verification (2026-10-13)

The multiplayer Lab skill was run against the adapter worktree with its isolated
server build and disposable homes. The cloud record service has its own composition
root (`boot-solus-api.ts`), which previously did not start the work adapter. The Lab
found this defect; the service now starts and stops the adapter and closes its
database after a storage configuration failure. A regression test covers that path.

The real Cloudflare proof is `scripts/proof/artifacts/lab-proof.ts`. It checks all
four work types through real client admission and record RPC/HTTP calls. Bob reads
Alice's agent edit, archived original and restore. Two clients open the live diagram;
Bob receives Alice's Yjs update, reads its body, and the same body reaches a Cloudflare
Git commit. Carol cannot read the works. A separate local host publishes an HTML
work; archive acceptance is checked before upload returns and Bob reads it. Every
new remote repository is deleted and its 404 response checked.

The broader Lab-issuer multiplayer suite is **not green**: 2 of 15 scenarios passed,
13 failed (285 checks; 82 failed). Failures include missing runner delegations,
session permissions, presence, seats, and a scenario expecting null for a moved
work where the service returns MOVED. These results do not establish regressions
caused by the adapter; they establish that this worktree's full multiplayer proof
is incomplete. Account sign-in against a local Solus cloud and client screens were
not driven. The older Lab in this worktree does not have the new cloud-stack CLI.

Focused regression tests: 25 passed, 1 optional real-cloud case skipped, 0 failed.
The real-cloud test ran separately through the Lab proof. Changed files pass targeted
oxlint and whitespace validation. No full application build or deployment was run.

Evidence: `.solus-local/lab-cloud/evidence/artifacts/summary.json`,
`artifacts-final.txt`, `multiplayer-summary.json`, `multiplayer-current.txt`, and
`regression-focused.txt`. Failed first attempts are retained alongside these results.

## Local Git revision — 2026-10-15

This result supersedes the earlier multiplayer failures above. Main was fetched
and merged at `889dde187` (0.36.1). The new ownership rules were retained and the
archive migration was regenerated as `0021_work_storage_adapters` after main's
migrations. Both database engines retain their own generated migration.

Local work history now uses bare repositories under the configured data directory.
Local and Cloudflare repositories share the same archive adapter and commit writer.
Existing local history migrates in small batches; accepted Git bodies replace the
inline history copies without changing Solus versions. The current draft remains
in the database. Publication preserves Solus revision history in a new destination
snapshot, not the source Git commit graph.

| Verification | Result |
|---|---|
| Local Git Lab: four types, restart, publication, guest editing and revocation | 49 checks passed |
| Same Lab with real Cloudflare Artifacts | 50 checks passed; remote deleted and 404 confirmed |
| Full multiplayer Lab, personal and managed hosts | 20 scenarios, 720 checks, zero failures |
| Local cloud with real account sign-in | 12 checks passed |
| Local cloud organization work and cross-organization access | 18 checks passed |
| Focused storage, work, live-edit, review and API unit tests | 91 passed; one optional cloud unit test skipped |
| Targeted oxlint and whitespace validation | Passed |

The skipped unit test is the optional real-cloud unit test; the real service was
verified separately through the 50-check Lab run. An initial combined unit command
had API-mode mock interference. Running the composition and service tests in
separate processes passed. An initial Lab expectation used CONFLICT for a stale
save; the contract returns STALE_VERSION, and the corrected check passed.

The targeted TypeScript check reports seven errors in unchanged dependency files:
Lab scenario host-kind narrowing, broken-pipe error typing, database engine env
shape, and API-mode env shape. No diagnostic names the changed storage files.
The module-boundary test reports the same two existing crossings in admission/scope
and background-session-title. The requested `lint:types` script is absent on main.
These checks are not reported as green. Client screens were not driven.

Evidence in `.solus-local/`: `local-git-lab-final.txt`, `cloudflare-git-lab.txt`,
`multiplayer-git-all.txt`, `local-git-unit.txt`, `local-git-works-final.txt`,
`local-git-composition.txt`, `local-git-service.txt`, `local-git-organization-work.txt`,
`local-git-cloud-signin.txt`, and `lab-cloud/evidence/`. A portable summary is
`scripts/proof/artifacts/results/local-git-lab.json`. The local cloud stack was
stopped through `bun lab down`; nothing was deployed or pushed to GitHub.
