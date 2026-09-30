# Plan 011: Give cloud coding clear owners and full Git history

Status: IMPLEMENTED (2026-09-29), not committed; see "Implementation record" at
the end. Written 2026-09-29 against `fb020ccb` plus the task's uncommitted
changes. Task: `01M3DFVHJYY8XXKHKJ7PNMNG4K`.
Priority: P1. Effort: several days in three stages. Risk: medium.

## Decisions

1. One `GitIdentityManager` owns Git identity resolution, caching, credential
   selection policy, and invalidation. Provider adapters still own processes.
2. One `AgentProfileManager` owns profile reads, writes, removal, validation, and
   manifests. Keep the current copy model. No revision store or rollback journal.
3. Use `git clone --filter=blob:none ...` for Solus-owned dispatch and managed PR
   review clones, with full commit history and all remote branches. Ordinary
   project clone can reuse the same policy; retain its current full-clone default
   until that product choice is made. Imported repositories are never recloned.

The user requested focused classes and questioned shallow clones. This plan
replaces the review's proposed profile revision system and comparison-time history
deepening abstraction. There are no customer compatibility requirements. Remove
superseded internal APIs instead of retaining forwarding wrappers. Preserve all
existing developer files, commits, and checkouts.

## Why

Git identity has policy and lifetime that need one owner. Missing member
credentials currently permit host fallback, while a reused Codex process can keep
an old author after an account change. A class should correct those ownership
rules, not merely wrap the existing functions.

Profile files also have a clear owner. Put their policy behind a small class, but
do not turn a repeatable copy into a storage system. Retain basic path and size
checks; a class alone does not correct them.

Blobless partial clones retain commits and trees while deferring file contents.
Checkout obtains current files; old diffs can require later network access. This
avoids missing merge bases without downloading every historical file version
upfront. The performance gain depends on the repository and is not yet measured.
Sources: [git-clone](https://git-scm.com/docs/git-clone) and
[partial-clone](https://git-scm.com/docs/partial-clone).

## Current state and drift check

Read the operating manual first. Run `git status --short` and inspect the current
diff for the files below. Several tasks have uncommitted changes in this checkout;
a comparison against HEAD alone is insufficient. Do not reset or stash anything.
Compare these excerpts with live source before implementation:

```ts
// packages/server/src/providers/github/member-git.ts
const token = await withCredentialScope(userId, () => loadToken())
if (!token) return null
// Later:
saveDelegation(delegationId, { accessToken: token.accessToken, login })

// packages/server/src/execution/agents/codex/codex-backend.ts
const existing = this.seatClients.get(seat.userId)
if (existing) return existing.client

// packages/server/src/project-config/dispatch-checkouts.ts
export const SHALLOW_CLONE_ARGS = ['--depth=1', '--no-single-branch'] as const
```

Relevant owners under `packages/server/src/`:

- `boot-server.ts`: constructs managers and injects their dependencies.
- `execution/seats/seat-manager.ts`: provider login and member home resolution.
- `execution/seats/agent-profile.ts`: lexical path checks, direct writes, manifest.
- `transport/handlers/seat-handlers.ts`: profile RPC validation and caller identity.
- `providers/github/credentials.ts`: existing GitHub credential selection policy.
- `providers/github/git-credential.ts`: standalone Git helper entry.
- `vault/provider-credentials.ts`: member-scoped account credential reads.
- `git/git-action-manager.ts`: Solus commit and push operations.
- `transport/handlers/setup-handlers.ts`: dispatch clone and reuse preparation.
- `git/pull-request-authoring.ts`: required diff errors currently become empty text.

Match `SeatManager` dependency injection, exact domain types, structured logs,
resolved working directories, and temporary test fixtures. No broad unknown
records or pass-through wrappers.

## Stage 1 — Centralize Git identity

Create `packages/server/src/git/git-identity-manager.ts`. Move the policy from
`member-git.ts` into `GitIdentityManager`, then remove that function API and its
module after callers move. Construct one manager in `boot-server.ts`.

Use an explicit result with `host`, `member`, and `unavailable` cases. Member
contains user ID, author name/email, a non-secret identity revision, and process
configuration. Unavailable contains a useful reason. Only host permits inherited
host defaults. Accept the acting owner explicitly; derive it from existing
principal/turn attribution, not a checkout path or device ID.

The manager owns resolution and invalidation, using injected credential source,
CLI location, and clock. Reuse `providers/github/credentials.ts` and the existing
account authorization policy. Do not create a second fallback chain, OAuth
service, process pool, or checkout manager.

### Credentials

Prefer resolving the current member credential when the Git helper is called,
through the manager and existing account authorization. Remove the new persistent
`member-<id>` token copies. Preserve paired-device delegation on personal hosts.
Add a member-specific argument in the existing CLI helper parser.

First prove that the standalone helper can use the host's existing delegated
authority for that member without booting the whole server. Missing or rejected
authorization must not return a host token or fall through to another helper.
If caching is necessary, bound it to five minutes and invalidate it on known
account changes and membership removal. Cache expiry is not upstream OAuth token
expiry. Do not log tokens or include them in identity revisions.

Bind the helper to the expected account identity: an old process must not combine
its old author with a new account's token. This applies to lazy blob fetches too.

### Consumers

- Claude receives freshly resolved configuration for each process/turn.
- Codex stores the identity revision with its seat process. Reuse only a matching
  revision. Replace an idle process on change. If it has active runs, refuse the
  new turn with an actionable retry error until those runs finish. Do not kill
  their processes or expand the pool without bounds.
- Solus Git actions use the same result and refuse member commit/push when
  identity is unavailable.
- Members without GitHub may still read and edit. Their agent configuration must
  prevent inherited host author and GitHub-helper fallback; identity-dependent
  Git operations fail clearly. This is correct identity handling, not an OS
  sandbox against an agent deliberately changing its environment.
- Route member checkout configuration through the same policy. Preserve personal
  paired-device behavior. Solus-owned Git reads that fetch missing blobs must use
  the acting member's credentials too, not only commit/push commands.

Tests: add `tests/unit/git-identity-manager.test.ts`; update
`member-git-env.test.ts` and focused provider lifecycle tests. Cover host, two
members, missing account, account-service failure, connection/change with an
existing Codex process, idle replacement, busy refusal, revocation, and helper
execution in a fresh process context. Use the existing temporary Git fixture;
replace its assertion that an unconnected member commits as Host. Avoid sleeps.

Verify: `bun scripts/test-unit.ts git-identity member-git-env github-credential seat codex`
must exit 0. Missing-member tests must prove no host-authored commit or host helper
invocation occurs.

## Stage 2 — Put profile files behind one class

Refactor `execution/seats/agent-profile.ts` into `AgentProfileManager` in the same
region. Inject source-home and member-home resolvers plus a clock. Expose `read`,
`apply`, `status`, and `remove`; keep filesystem helpers private. Construct it in
`boot-server.ts` and inject it into seat handlers. Reuse `SeatStore.homeFor`.
Continue deriving the target member from the verified principal, never RPC input.

Keep the existing one-way copy and manifest. Include only these small safeguards:

- Validate all paths, duplicate destinations, file/directory conflicts, decoded
  per-file size and total size before mutation.
- Reject existing destination symlinks, including parent components below the
  resolved seat home. Continue supporting source skill symlinks.
- Preserve previously copied files explicitly reported as skipped; unreadable
  input is not deliberate deletion.
- Report failures, write the success manifest last, and update executable mode
  for existing files as well as new files.

No full atomicity guarantee: an I/O failure after writes begin can leave a partial
copy. Another copy repairs it. Do not add staging trees, revision history, a
database, or rollback machinery. This is the smaller scope requested by the user.

Tests in `tests/unit/agent-profile.test.ts` must cover the class's read/apply/remove,
login preservation, skipped files, oversized input, duplicate paths, and a
destination symlink whose external target remains unchanged. Use temporary homes.
Keep current surface behavior: desktop reads its local source; web and mobile can
inspect and remove the copy. No new profile UI or RPC is required.

Verify: `bun scripts/test-unit.ts agent-profile` must exit 0.

## Stage 3 — Use full-history partial clones

Replace `SHALLOW_CLONE_ARGS` with a clearly named dispatch clone option containing
`--filter=blob:none`. Remove `--depth=1`. Keep all-branch fetch behavior; do not add
`--single-branch`, sparse checkout, or tag restrictions.

Rename the task's new `shallow` request option and direct types/callers to express
partial-clone behavior. Do not retain an unshipped misleading alias. Keep ordinary
clone flows unchanged and reuse setup progress, cancellation, and error handling.
If Git ignores filtering and completes a full clone, accept it. Do not retry auth
or network failures as another clone mode or delete an existing checkout.

On reuse, detect an existing shallow dispatch checkout and fetch full ancestry
once during preparation with the acting identity. Preserve dirty files, local
commits, HEAD, and linked worktrees. No reset or clone replacement. Failure stops
preparation with a retryable error. Do not deepen history in status scans.

Make required PR diff failures in `git/pull-request-authoring.ts` visible. Failed
lazy blob fetches must not look like empty patches. Check its direct review
consumer for the same distinction. No new history manager is required.

Replace/rename `tests/unit/dispatch-shallow-checkout.test.ts` with
`dispatch-partial-checkout.test.ts`. Use a local bare origin with
`uploadpack.allowFilter=true` and `file://` transport. Create divergent main and
feature commits with changed contents and an old blob unnecessary for checkout.
Assert full ancestry and a merge base, complete working files, feature worktree
creation, an initially absent old blob fetched on demand, a real PR diff, and an
error on failed blob fetch. Also cover a non-filtering origin and conversion of a
shallow checkout without changing dirty files, local commits, or HEAD.

Do not use wall-clock speed as a test threshold. Benchmark transfer/time only
when separately requested; the plan does not claim a measured speed improvement.

Verify: `bun scripts/test-unit.ts dispatch-partial-checkout dispatch-history-roots pull-request-authoring run-model-selection run-on-dispatch`
must exit 0.

## Scope and execution order

### Reuse map (added after the follow-up source review)

`GitIdentityManager` owns who an operation acts as and how that choice reaches
Git. Keep command execution, GitHub requests, and checkout lifecycle in their
current modules. Its explicit owner input must also represent the existing paired
device delegation on personal hosts; the original host/member/unavailable result
must not cause that identity to disappear. Keep the resolved result separate from
the credential source (member account, paired device, or host configuration).

| Consumer | Current implementation | Reuse and cleanup |
| --- | --- | --- |
| Claude and Codex runs | `execution/seats/seat-manager.ts`, provider adapters | Resolve once at run admission; consume the manager's identity/configuration and revision. Delete the standalone member-git cache and assembly. |
| Commit/push actions | `git/git-action-manager.ts` | Remove `actingMemberGitEnv`; pass a resolved identity to the action. |
| Clone and dispatch setup | `transport/handlers/setup-handlers.ts` | Move identity/helper selection out of `configureDelegatedCheckout` and token-selection branches. Setup still owns destination, progress, retry, and cancellation. |
| Publish repository | `transport/handlers/git-publish-handlers.ts`, `git/github-publish.ts` | Select identity once for repository creation and initial push, so their accounts agree. Remove independent push credential selection and repeated askpass lifetime code. |
| PR and branch fetches | `git/worktree-manager.ts`, `git/checkout-service.ts` | Carry the acting identity into branch/PR/object fetches. Do not rely on ambient host credentials. CheckoutService keeps checkout state and watchers. |
| Managed PR review | `review/managed-pr-checkout.ts` | Reuse credential selection and command auth setup/cleanup. Remove its independent credential fallback loop and helper precedence assembly after equivalent host/device behavior is covered. Preserve exact revision materialization. |
| Git helper | `providers/github/git-credential.ts`, `apps/cli/src/index.ts`, standalone helper dispatch | Use the same member identity and authorization policy in a short-lived process. Do not attempt to share an in-memory singleton across processes. |
| File-content reads that can fetch | PR authoring, review diffs, `git/session-snapshots.ts` reads | Supply the authorized identity when a missing blob can trigger a network fetch. Resolve at request/run admission, not once per file or status probe. |

Keep `git/git-auth-env.ts` as a small transport utility underneath the manager.
It already serves setup, publish, and managed review. Consolidate its lifetime and
helper-precedence use; do not write a second askpass implementation. Keep
`providers/github/credentials.ts` as the existing credential-policy dependency.
GitHub REST/GraphQL request retries remain in `providers/github/request.ts` and
consume credentials; the Git manager must not become the GitHub API client.

Do not route these through personal Git authorship:

- Snapshot `commit-tree` in `git/session-snapshots.ts:314`: the fixed Solus author
  identifies internal snapshots. Keep it, even if adjacent blob reads need auth.
- Pure local metadata such as branch names and `rev-parse`: no account lookup.
- Background watchers: do not give them the last foreground caller's identity.
  Any background operation that can fetch needs an explicit authorized owner.
- Shared checkout config: do not rewrite its author/helper for every caller.
  Use per-operation config for acting identity; persist only stable ownership
  configuration in checkouts that actually belong to that owner.

### Full-history clone reuse and removable workarounds

Define the shared clone policy in the Git region, not in dispatch path layout.
Dispatch setup and managed review import it. Keep their lifecycle separate: a
member working copy is mutable, while review storage names an exact PR revision.
There is no need for a second clone manager just to share argument policy.

Confirmed cleanup sites:

1. `review/managed-pr-checkout.ts:112,118,124`: remove depth-1 from the clone and
   both revision fetches. Keep `--no-checkout`, then checkout the pinned head.
   Use the partial-clone filter for later exact-ref fetches too; test that they do
   not eagerly download all historical file contents or add shallow boundaries.
2. `review/managed-pr-checkout.ts:41–46`: replace the requirement that a reusable
   checkout be shallow. Require the requested base/head and usable full history.
   Retain the hashed revision path, ref checks, and preparation coalescing. Auth
   scope must be checked before reuse; sharing a cache is not authorization.
3. `git/worktree-manager.ts:681`: remove `--depth=1` from the missing PR-base fetch.
   This fetch can introduce a shallow boundary even into a full-history clone.
   Keep the object-existence check and fetch when the exact revision is absent.
4. `git/worktree-manager.ts:685–688`: stop converting failed base resolution into
   `headSha`, which can make the review appear empty. Report the unresolved base.
5. `git/pull-request-authoring.ts:75–79`: stop converting required log/diff errors
   into empty change context. This is a general error-handling correction, not
   proof that those catches were originally written for shallow clones.
6. `tests/unit/managed-pr-checkout.test.ts:55–57`: replace the assertions that the
   repository is shallow and `.git/shallow` exists with full-history/partial-clone
   behavior assertions. Preserve exact revision and guide-file isolation tests.

Keep the following behavior; full history does not replace it:

- Provider `diffBaseSha`, pinned base/head refs, and two-revision PR comparisons.
  They define the requested review and can cover fork commits outside normal
  remote-tracking branches.
- Normal PR-head fetching: a full clone of normal branches does not necessarily
  include PR-only refs or historical heads. This does not justify retaining the
  removed stacked-PR feature's parent-ref fetching path.
- Session snapshot bases and the default-branch review fallback in `review/ledger.ts`.
  Session changes and branch changes are distinct scopes.
- Missing/mistyped target handling in `review/guide-producer.ts:102–112`. Review
  its product behavior separately; it is not solely a shallow-clone workaround.
- Support for imported shallow repositories. Solus controls its own clone policy,
  not how a developer cloned a repository. Keep `pr-checkout-fetch.test.ts` as an
  imported-shallow compatibility test; do not require a full-repository conversion
  merely to inspect its provider-supplied PR base.

Correction after the user's reminder: stacked PRs were removed on 2026-09-22.
The earlier review mistook residual implementation for supported behavior.
Do not preserve `resolvePrDiffBase`'s parent-PR branch as a product requirement.
Trace and remove the remaining stack-only contract fields (`ownDeltaBase`,
`ownDeltaBaseSha`, `parentPr`), guide-loader option, alternate guide-base logic,
and unused `ActivityFeed.stackChain` input once their remaining consumers are
confirmed. Simplify ordinary PR comparisons to their supplied base/head. Keep
normal PR-head fetching and branch merge-base operations. Do not restore stack
detection or add compatibility machinery for an intentionally removed feature.
This cleanup is part of the touched comparison paths in stage 3; retain any
non-stack use of a shared guide-key helper discovered during the call-site check.

This extends stages 1 and 3 to the listed consumers and focused tests. Add the
managed-review auth and revision tests to the final run:
`bun scripts/test-unit.ts managed-pr-checkout pr-checkout-fetch github-publish git-auth-env github-credential pr-guide-diff`.
All must pass. Add a regression that a PR-base fetch into a full clone leaves it
non-shallow, and that a lazy blob fetch for member A never uses member B or host
credentials. No builds or interactive app run are required to write this plan.

Stage 1 precedes stage 3 because partial clones require correct later credentials.
Stage 2 is independent. Scope includes the named server files, their immediate
constructors and CLI parser, shared types if needed, focused tests, and
`docs/agent-profile.md` / `docs/run-on.md`.

Out of scope: Skills settings ownership, secrets sync, setup-script users, browser
isolation, uncommitted handoff, a provider framework rewrite, and profile-store
retry/stale-response work. Keep those as separate work. Do not alter concurrent
checkout-owner or busy-tree policy.

Both providers and desktop-local, desktop-hosted, web, and mobile requests use
these shared server owners. No new UI is planned. If visible states change,
implement them across clients and arrange surface verification before completion.

## Final gates and handoff

- All stage tests pass; `bun run check` exits 0. Record unrelated existing failures
  separately and prove changed areas if the shared working tree prevents a clean run.
- Run `bunx oxlint` with explicit changed TypeScript paths; no new errors.
- Run `bun run api:check` if RPC types change. Regenerate only through the existing
  generator when required.
- Search the named regions to confirm the old member-git API and depth-1 dispatch
  constant have no remaining callers.
- Update this plan and `plans/README.md` with verification evidence and status.

Do not build, start the app, use live data, commit, or open a PR without a separate
instruction. Preserve other agents' edits. No backward-compatibility framework or
destructive migration is needed for this pre-customer change.

Stop and report if the helper cannot use existing member authority, if changing
Codex identity requires stopping active runs, or if source drift invalidates these
owners. Do not invent a new credential service or restore host fallback to pass
tests. Future identity changes must keep helper credentials and process author
revision consistent; future clone work must preserve full commit ancestry.

## Implementation record (2026-09-29)

### Decision changed during stage 1

The stop condition applied: the standalone helper cannot use a member's
authority. That authority is a rotating refresh token that only the server
process refreshes, under a lock (`sync/delegations.ts`). A second process that
refreshes it makes the server's copy invalid. The user chose this instead:

- The server resolves the member's GitHub token through the account connection.
- `GitIdentityManager.hold` writes it to a 0600 file under
  `<data dir>/git-credentials/<userId>-<revision>` only while a process or Git
  action holds it. The last release deletes it, and the manager clears the
  directory at start.
- The process environment holds only the author, a cleared `credential.helper`,
  a github.com helper that reads that file, and a rewrite of GitHub SSH URLs to
  HTTPS. The token is never in the environment, argv, or checkout config.
- The file name includes the identity revision, so an old process never reads a
  new account's token. A renewed token for the same account is rewritten into
  the held file.
- No `--member` argument was added to `solus git-credential`. The `member-<id>`
  delegation copies and `providers/github/member-git.ts` are removed.

Known limit, not a new risk: all members' agents on a host run as one operating
system user, so a member's agent can read another member's held file. It can
already read their seat login files. Only a separate OS user for each member
closes this.

### What was built

- Stage 1: `git/git-identity-manager.ts` (`host`, `member`, and `unavailable`).
  Consumers:
  - `SeatManager.resolveForTurn` sets `TurnSeat.git`.
  - Claude holds the credential for each run.
  - A Codex seat app-server stores its revision. It is replaced when idle, and a
    new turn is refused while it has active runs.
  - `runGitAction` takes a resolved identity and refuses a commit or push for an
    unavailable member.
  - Setup keeps checkout config (the paired device) for host work only. A
    member's clone is HTTPS only, and `gitAuthEnv({ isolateHelpers })` clears
    the host's helpers. `ensureBranch` fetches and checks out as the member.
  - `Delegations.onRevoked` calls `revoke`.
  - There is no account-change event on the host, so the 5-minute TTL covers
    account changes.
- Stage 2: `AgentProfileManager` in `execution/seats/agent-profile.ts`.
- Stage 3:
  - `git/partial-clone.ts` has `PARTIAL_CLONE_ARGS` and `ensureFullHistory`, and
    setup uses it on reuse.
  - The option is renamed from `shallow` to `partialClone`.
  - Managed PR review uses partial clones, and reuse needs full history. Its
    base..head file contents are fetched while its askpass is still in place.
  - The PR-base fetch keeps `--depth=1` only in a repository that is already
    shallow.
  - An unresolved PR base is an error.
  - PR authoring reports log and diff failures, and runs as the acting identity.
  - The stack leftovers are removed: `ownDeltaBase`, `ownDeltaBaseSha`,
    `parentPr`, `resolvePrDiffBase`, `reviewGuideKeyForBase`, the guide-loader
    option, and `ActivityFeed.stackChain`.

### Not done, and why

- Publish already selects one credential through `githubCredentialChain` under
  the caller's scope, for both the API and the push. It is not changed.
- `fetchAndCheckoutPr` (PR worktrees in a user's project) and the background
  guide warmer still use the checkout's own credentials. They need an explicit
  owner before they can act as a member.
- The managed review cache is keyed by revision, not by caller. The guide diff
  RPCs (`prGetDiff` and `prGetDiffFileContents` with `repo`) do not check the
  caller's access to the repository before they reuse it. This existed before
  and needs its own authorization decision.
- Plan 012 removes `HOST_OWNER_USER_ID`. `GitIdentityManager.resolve` uses it as
  the host test, so it must move with plan 012.

### Verification

- `bun scripts/test-unit.ts git-identity codex-seat-pool agent-profile
  git-action-manager dispatch-partial-checkout dispatch-history-roots
  pull-request-authoring run-model-selection run-on-dispatch managed-pr-checkout
  pr-checkout-fetch github-publish git-auth-env pr-guide-diff` passes.
- Failures that existed before, in code this plan did not change:
  - `github-credential-chain`: repository-scoped viewer.
  - `seat-manager`: `turnActorFor` now returns `principal`.
  - `setup-readiness-seats`: `node:sqlite` under Bun.
  - `session-continue-worktree`: missing `runed`.
  - `github-pr-list-loading`, `pr-summary-rendering`, `session-diff-feedback`.
- The server `tsc` reports no errors in changed files; the package has 151
  errors from before, down from 154.
- The contracts `tsc` passes. `bun run check` fails only in `client-core`
  (`window.solus`, `window.solusNative`, `ws-transport` arguments), in files
  this plan did not change.
- `bun run api:check` passes.
- Oxlint on the changed files reports no new errors. The complexity errors are
  on functions that were already over the limit.
- No build, app run, or live data was used.
