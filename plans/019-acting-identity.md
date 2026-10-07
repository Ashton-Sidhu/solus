# Plan 019: Every process acts as one identity

Status: IMPLEMENTED in source (2026-10-07, uncommitted, branch `solus/acting-identity`). Not run on a cloud host. See §9.

## Why

On a shared host, a member's work must use the member's credentials. Today
Solus decides the credential at each call site. A call site that does not
decide gets the host's credentials: the server's `HOME`, `~/.ssh`, the global
`solus git-credential` helper, the `gh` login, the host GitHub token, and the
host provider logins. Nothing fails. The member's work runs as the host.

Reported symptom: on a cloud host, Sync failed with `Host key verification
failed`. `gitSync` ran `git pull` with the host environment, so git used the
host's SSH setup for the member's GitHub remote. Push did not fail, because
`runGitAction` takes the member's `GitIdentity`.

An audit (2026-10-07) found nine leaks of this kind. They have three causes:

1. **Git without an identity.** `runAsync` has 180 call sites in 27 files. 24
   pass `env`. A partial clone (`blob:none`) makes "local" commands (`diff`,
   `show`, `worktree add`, `checkout`, `merge`) fetch from the remote, so the
   leak is not only in the commands that look remote.
2. **Agent processes keep the host environment.** `claudeEnv` and the Codex
   environment remove two variables and keep `HOME`, `SSH_AUTH_SOCK`,
   `GH_TOKEN`, `GITHUB_TOKEN` and, for Codex, `OPENAI_API_KEY`.
3. **Work without an actor falls back to the host login.** Automations,
   orchestration (`start_session`, `send_session`), `move_to_worktree`
   (`HOST_ACTOR`), PR guide warming, and the PR sync timer.

The same audit found the credential rules repeated:

- **Three caches of one token.** `GitIdentityManager.cached` (5 minutes),
  `ghCliGithubToken` (5 minutes, host only), and none at all in
  `readProviderCredential`, which posts to the account service on every GitHub
  API call that acts for a member.
- **Three ways to give git a token.** `solus git-credential` (host token and
  device delegations), `GitIdentityManager`'s token file with a shell helper and
  14 `GIT_CONFIG_*` variables, and `gitAuthEnv`'s askpass script (clone,
  publish, managed PR checkout).
- **A hold for each process.** `GitIdentityManager.hold` counts the processes
  that use a token file, and the Codex backend restarts its client when the
  identity revision changes.

The GitHub API path already reads one AsyncLocalStorage scope
(`vault/credential-scope.ts`) that every edge sets. This plan applies that
scope to every process the server starts, makes a missing scope an error, and
lets git, `gh` and the provider CLIs find the member's credentials where they
already look: in `HOME`.

## Words used here

- **acting identity** — whose credentials a process uses: the host login or one
  member. One object for each seat (`ActingIdentity`).
- **acting scope** — the AsyncLocalStorage value that holds the acting identity
  for the current call. It replaces `CredentialScope`.
- **member home** — the member's folder that is `HOME` for their processes.
  `MemberFolders` names it, as it names their seat and project folders.
- **Solus git helper** — the server's own `git-credential` command, started by
  absolute path (`process.execPath` and the server entry). It needs neither
  `solus` nor `gh` on `PATH`.
- **edge** — a place where work starts: an RPC, a Solus API request, an agent
  tool call, the task sync engine, the automation runner, orchestration, a
  server timer.

Do not say "credential scope", "git env" or "seat env" for these. Use the words
above.

## Decisions

1. **One identity for each process.** Every git, `gh` and provider process gets
   its environment from the acting identity. No call site builds a child
   environment from `process.env`.
2. **A missing scope is an error.** No fallback to the host on any host. Work
   that belongs to the host says so with `identities.host`.
3. **A member's environment is built clean.** It is an allow list, not the host
   environment with overrides. Overrides fix only the leaks we know about.
4. **Automations run as the member who created them.** If that member's seat for
   the provider is not connected, the run stops with `SEAT_REQUIRED` and a
   clear message on the run. (Approved 2026-10-07.)
5. **An orchestrated child session runs on its parent session's seat.** This
   covers `start_session` and `send_session`. (Approved 2026-10-07.)
6. **No short-term fixes.** The `gitSync` leak is fixed by stage 1 with the
   other git leaks, not by a separate patch. (Approved 2026-10-07.)
7. **The scope, not a parameter.** An `identity` parameter on every launch is
   checked by the compiler, but it touches 180+ call sites and every "local"
   command that a partial clone can turn into a fetch. The next new call site
   can still pass the wrong one. The scope covers them all; section 4 makes a
   missing scope visible before release.
8. **Credentials live in the member home as standard files.** git reads
   `~/.gitconfig`, so every git an agent starts finds the member's helper with
   no special variable. The Solus git helper answers first. `gh` is a fallback
   only: git asks it second, and only when it is installed. This
   deletes the 14 `GIT_CONFIG_*` variables, the askpass script, the token-file
   hold, and the Codex restart on a revision change. The member's GitHub token
   stays on disk (0600) while the member is connected, not only while a process
   holds it. This replaces the hold from plan 011 stage 1. (Approved
   2026-10-07; `gh` made a fallback, not the primary helper, 2026-10-07.)
9. **This plan prevents mistakes, not attacks.** Member processes run as the
   same OS user as the host. A clean environment stops a tool from using host
   credentials by default. It does not stop an agent that reads
   `/home/<host>/.ssh` or another member's home on purpose. Isolation against
   that needs one Unix user for each member on managed hosts, which is a
   separate plan. (Approved 2026-10-07.)

## 1. Shape

```ts
// execution/seats/acting-identity.ts
export class ActingIdentity {
  readonly seat: Seat
  /** Keys caches and shared in-flight work. `host` or the member's user key. */
  readonly cacheKey: string
  /** The member's GitHub token and login; null for none. One promise for concurrent callers. */
  github(): Promise<MemberGithub | null>
  /** The full child environment. Async: a member's home is written before first use. */
  env(extra?: ChildEnvExtras): Promise<ChildEnv>
}

export class ActingIdentities {
  constructor(deps: { seats: SeatManager; folders: MemberFolders; ... })
  readonly host: ActingIdentity
  /** Synchronous map read. No I/O. The same object for a seat every time. */
  for(seat: Seat): ActingIdentity
  /** Sets the acting scope for `fn`. The only writer of the scope. */
  run<T>(identity: ActingIdentity, fn: () => T): T
  /** The member may no longer act here: delete their credential files now. */
  revoke(userId: UserId): void
}

// The only reader of the scope. Throws NoActingScopeError when unset.
export function currentIdentity(): ActingIdentity
```

- `ActingIdentities` is built once in `boot-server.ts` and passed to the edges,
  as `SeatManager` is now. It is not a module global. Tests build their own.
- `GitIdentityManager` is deleted. Its token read and login lookup move into
  `ActingIdentity.github()`; its revoke moves into `ActingIdentities.revoke`.
- `githubCredentialChain`, for a member, reads `currentIdentity().github()`.
  That is the one cache of a member's token.
- `credential-scope.ts` holds the `ActingIdentity`, not a bare user id.
  `withCredentialScope` is deleted. `currentCredentialUserId()` reads
  `currentIdentity().seat`.
- `SeatManager.connectedSeat` stays the owner of provider seat homes and pasted
  tokens. `ActingIdentity.env()` reads them and does not build them again.
  `TurnSeat.git` is deleted.

## 2. Cost: no work for each RPC

Most RPCs start no process. Entering a scope costs one map read: `for(seat)`
returns a cached object and does no I/O. The first launch for a member calls
`env()`, which awaits `github()` and writes the member home if its contents
changed. Concurrent launches share that one promise. The answer stays for 5
minutes, which bounds how late a GitHub account reconnected on the account
website is noticed (the same bound as today). A seat change
(`SeatManager.onChanged`) or a member removal clears the answer at once.

## 3. The environment

**Host login:** the environment the host uses today (`getCliEnv`). The host's
global `solus git-credential` helper and `gh` login answer, as they do now.

**Member:** built from an allow list:

- From the host: `PATH`, locale, `TMPDIR`, `TERM`.
- `HOME` is the member home. `XDG_CONFIG_HOME` is not passed, so `gh` and other
  tools read `~/.config` in the member home.
- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
  `GIT_COMMITTER_EMAIL`: the member's GitHub login and noreply address. These
  stay variables because a checkout's own `user.name` outranks `~/.gitconfig`;
  the variables outrank both.
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and a pasted `CLAUDE_CODE_OAUTH_TOKEN`
  from the member's seat.
- Not passed: `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GIT_ASKPASS`, `SSH_ASKPASS`, and every variable not on the
  list.

The member home holds:

```ini
# ~/.gitconfig
[credential]
	helper =
	helper = !'<node>' '<server entry>' git-credential --member-home
	helper = !f() { command -v gh >/dev/null 2>&1 && gh auth git-credential "$@"; }; f
	helper = !f() { echo quit=1; }; f
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
```

```text
~/.config/solus/github.json   (0600)  { "token", "login" }, written by Solus
~/.config/gh/hosts.yml        (0600)  the same token, so `gh` that an agent runs acts as the member
```

- The empty `helper =` clears the system helpers.
- **Primary: the Solus git helper.** `--member-home` reads
  `$HOME/.config/solus/github.json` and answers github.com. It extends the
  existing `git-credential` command (`providers/github/git-credential.ts`),
  which already serves the host token and device delegations, so Solus keeps
  one helper program. The server writes its own absolute path into the file,
  so the helper does not depend on `PATH`.
- **Fallback: `gh`.** If the Solus helper has nothing (no token file) and `gh`
  is installed, `gh auth git-credential` answers from the member's own `gh`
  login in the member home. If `gh` is absent, the helper prints nothing and
  git goes on.
- **Stop.** The last helper answers `quit=1`, so git never asks a helper from
  the checkout's own config (a device delegation in a dispatch checkout).
  Checked against git 2.50.1 on 2026-10-07: a global helper that answers
  `quit=1` stops git before it asks a local helper.
- `hosts.yml` is written for `gh` commands that an agent runs, not for git. It
  is a second copy of the same token. Both files are written together and
  deleted together on `revoke` or a GitHub disconnect; a running agent's next
  fetch, push or `gh` call then fails.
- With no token and no `gh` login, every HTTPS remote fails closed. An SSH
  remote that is not GitHub fails, because the member home has no keys and no
  `known_hosts`.

`getCliEnv`, `runAsync`, `git()`, `claudeEnv` and the Codex environment build
from `currentIdentity().env()`. A caller's `env` argument adds variables for one
command; it cannot change the identity. The three synchronous `git()` callers
and synchronous `getCliEnv()` probes either become async or are host-only
probes that name `identities.host`.

## 4. Enforcement

At runtime, a launch with no scope throws `NoActingScopeError` and logs
`acting_scope_missing` with the stack. Before release:

1. **Tests run without a scope.** `tests/preload.ts` sets none. A test that
   reaches a real launch without a scope fails. The check is in `getCliEnv()`,
   below the `runAsync` mocks that many tests use.
2. **Every edge sets the scope, and lint keeps it that way.** The edges are
   `SolusServer.handle`, the Solus API router, `run-launcher` agent tools, the
   task sync engine, the automation runner, orchestration, and server timers.
   A lint rule rejects a bare `setInterval` or `setTimeout` in
   `packages/server/src` outside `scheduled(identity, fn)`. A second rule
   permits `identities.host` and `HOST_ACTOR` only in a named list of files.
3. **Shared in-flight work is keyed by identity.** Otherwise member B waits on
   member A's promise and gets A's result, and the scope check does not see
   it. This covers `prIndex`, `getExistingPR`, `identityInflight`
   (`git-helpers.ts`), the default-branch read, and the managed PR checkout
   path.

## 5. Process lifetimes

This plan adds no daemon, no timer and no long-running process.

- An `ActingIdentity` is a small in-memory object for each seat. It lives for
  the server's life and is removed when the member is removed.
- The member home is a folder on disk. It is written on first use and when the
  token or login changes, and its credential files are deleted on revoke or
  disconnect.
- git starts the Solus git helper for each credential request. It exits after
  it answers. The `gh` fallback, when asked, also exits.
- GitHub OAuth App user tokens do not expire (`token-store.ts`), so the files
  need no refresh. If Solus later uses expiring tokens, `github()` refreshes
  and rewrites both files; it adds no timer.

## 6. Stages

1. **Scope, member home, and git.** `ActingIdentity`, `ActingIdentities`, the
   scope holds the identity, `currentIdentity()` throws. `getCliEnv`,
   `runAsync` and `git()` build from it. Every existing edge sets it. This fixes
   the git leaks: `gitSync`, `worktreeBranches`, `gitRefreshState`,
   `setupSyncProject`, the PR checkout fetches, `createWorktree`'s start-point
   fetch, `getDefaultBranch`, `persistReviewCheckpoint`,
   `prPrepareConflictResolution`, `githubPublishRepository`, and partial-clone
   fetches. Delete what it replaces: `GitIdentityManager` and its credentials
   directory, the `gitEnv` parameters (`runGitAction`, `ensureBranchWorktree`,
   `partial-clone`, setup prepare), `git-auth-env.ts` and its askpass script.
   A clone with a device credential saves the delegation first and clones with
   `-c credential.https://github.com.helper=` with the Solus git helper and
   `--delegation <key>`. Add `--member-home` to the Solus git helper.
2. **Agent environments.** `claudeEnv` and the Codex environment build from the
   identity. Delete `TurnSeat.git`, the Codex `gitRevision` restart and
   `releaseGit`.
3. **Every run has an actor.** Automations run as their creator (decision 4).
   Orchestrated children run on the parent's seat (decision 5).
   `move_to_worktree` uses the session's actor. Guide warming and
   `prGenerateGuides` pass the caller's seat.
4. **Caches and timers.** Key shared caches and in-flight work by identity
   (section 4.3). PR sync runs each member's repositories in that member's
   scope, and the host's in `identities.host`.
5. **Lint and proof.** The two lint rules. A test that starts git, `gh` and a
   provider under a member scope and asserts no host credential reaches the
   child: the member `HOME`, no `SSH_AUTH_SOCK`, no host token variable, and a
   checkout-local helper never asked. A test with two members on one checkout
   asserts that neither gets the other's result from a shared in-flight read.

## 7. Applicability

- **Providers.** Claude and Codex: both change in stage 2. Both already run on
  member seats; only their inherited environment changes.
- **Hosts.** Personal, self-hosted and managed hosts all use the same rule. On
  a personal host every edge resolves to `identities.host`, so behavior does
  not change; a missing scope fails there too, which is how tests find it.
- **Clients.** No contract or UI change. Desktop, web and mobile see the same
  RPC results; a member who has not connected GitHub sees the existing
  "Connect GitHub" errors instead of a silent host fallback.

## 8. Open items

- **Helper start time.** Each credential request starts the server entry in
  Node. The existing `solus git-credential` does the same. If a fetch with many
  requests is slow, give `--member-home` a small entry that loads only the
  helper.
- **Other Git hosts.** GitLab, Bitbucket and self-hosted remotes have no member
  credential. With the member home, they fail closed. Decide whether that is
  the intended answer or needs a credential source.
- **Per-member Unix users** on managed hosts (decision 9): a separate plan.

## 9. Implementation record (2026-10-07)

### What was built

- `vault/acting-scope.ts` replaces `credential-scope.ts`. The scope holds the
  `ActingIdentity` and the `credentialUserId`. `requireActingScope`,
  `currentIdentity` and `currentCredentialUserId` throw `NoActingScopeError`
  and log `acting_scope_missing` when no scope is set. `withUserScope` serves
  code that holds only a user key (the data layer's task sync).
- `execution/seats/acting-identity.ts`: `ActingIdentity`, `ActingIdentities`,
  `HOST_IDENTITY`, `HOST_SCOPE`, `withActorScope`, `withHostScope`,
  `identityFor`, and the member home (`.gitconfig`,
  `.config/solus/github.json`, `.config/gh/hosts.yml`). Member homes are
  `<seatsRoot>/home/<member folder>` (`memberHomeDirectory`), a `MemberFolders`
  root.
- `cli-env.ts`: `hostCliEnv` is the host environment. `getCliEnv` reads the
  acting identity through `useActingEnv`, which `acting-scope.ts` installs.
  `git/exec.ts` `runAsync` awaits `currentIdentity().env()`, so a member's
  author is named before a commit.
- The Solus git helper: `solusGitHelper(flags)` in
  `providers/github/git-credential.ts` names the standalone server's own entry
  (`useServerEntry`), else the installed `solus` CLI. `--member-home` reads
  `$HOME/.config/solus/github.json`. The standalone entry and the CLI accept it.
- Deleted: `git/git-identity-manager.ts` and its credentials folder (removed at
  boot), the askpass script, every `gitEnv` parameter, `TurnSeat.git`, the
  Claude per-run hold, and the Codex restart on a revision change.
- Edges that set a scope: `SolusServer.handle`, the Solus API router, agent
  tools, `RunLauncher.startRunLifecycle` (from the turn's own actor), the task
  sync engine, the automation runner, PR sync (per repository), review guide
  jobs and guide warming (the requester's scope, captured), and boot
  (`bootCore` and `createSolusApiService` run as the host).
- Automations run as their creator (`unattendedActorFor`). Orchestrated
  children and prompts act for the sender's person; reports act for the target
  session's person (`SessionRuntime.actorOfSession`). `move_to_worktree` uses
  the session's actor.
- Keyed by identity: `getExistingPR` and the managed PR review checkout (the
  host's path is unchanged).
- Lint: `solus/acting-identity` rejects a child environment built from
  `process.env`, and the names `HOST_ACTOR`, `HOST_IDENTITY`, `HOST_SCOPE`,
  `withHostScope` and `hostCliEnv`, outside a reviewed list of files with their
  reasons.

### Decisions made during implementation

1. **One installed instance, not a parameter on every edge.** `boot-server.ts`
   builds `ActingIdentities` and installs it with `useActingIdentities`, as
   `useMemberFolders` is installed. Passing it to every edge would touch ten
   constructors for no gain. Tests install their own
   (`tests/unit/helpers/acting-identities.ts`). The host's identity needs no
   installation.
2. **The scope carries two things.** A guest runs on the sharer's seat but
   reads their own connections, and a managed host's remote owner runs on the
   host login but reads their account. So the scope holds the identity (whose
   processes) and the credential user (whose connections), as before.
3. **Provider homes stay with `SeatManager`.** `ActingIdentity.env()` is the
   member's base environment. `claudeEnv` and the Codex client add the seat's
   `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. `SeatManager.connectedSeat` fills
   `TurnSeat.env` for members; `resolveForTurn` waits for their author.
4. **A caller-chosen token uses a helper for one command, not askpass.** A
   host clone with a device's credential, a publish, and a managed review
   checkout pass `-c credential.helper= -c credential.helper=<token helper>`
   with the token in `SOLUS_GIT_TOKEN` (`git/git-auth-env.ts`). For a member
   this returns nothing: their home answers. So the clone does not save the
   delegation first.
5. **No `setTimeout` lint rule.** The scope follows timers, so a timer set by a
   person's call runs as that person and a timer set at boot runs as the host.
   A rule on every `setTimeout` would flag hundreds of debounces. The real
   hazard is a shared queue that serves several people; each one found
   (guide jobs, guide warming, PR sync) captures the scope it acts for.
6. **Tests declare the host with `actAsHostForTests()`.** Bun loses an async
   scope that a test file sets while it registers tests after a top-level
   await (synchronous tests then time out). So the call sets a default scope
   for that test process. Production never sets it.
7. **Shared code-host answers stay shared.** `PrIndex` entities and the checks
   read keep one answer per pull request, by their own documented design; the
   read itself runs as a real requester, never as the host by default.
   `computeGitIdentity` and the default-branch read are facts about the
   repository, not about a person, so they are not keyed.
8. **`GIT_CONFIG_NOSYSTEM=1` for members.** The system config can name a
   keychain helper that answers with the host's credentials.

### Verification

- `tests/unit/acting-identity.test.ts` (10 tests): with real git and the real
  Solus git helper process, two members commit and authenticate as
  themselves; a checkout's own helper and the host's are never asked; a
  member's environment has no `SSH_AUTH_SOCK`, token variable, or host `HOME`,
  and a caller cannot change it; a member without GitHub cannot commit or
  authenticate, and a Solus commit is refused before git runs; one account
  read is shared and asked again after its lifetime or a failure; a renewed
  token reaches a running process; revoke deletes the files; review
  checkouts are per member.
- `tests/unit/acting-scope.test.ts`: reading with no scope throws; a dispatch
  runs as the caller; concurrent dispatches stay apart.
- `tools/oxlint/solus/rules/acting-identity.test.ts`.
- Full unit suite: the same 76 files fail on this branch as on `HEAD` before
  the change; none is new. Server typecheck: no new error (147 before and
  after). Oxlint: no new finding.

### Not done, or limited

- Not run on a cloud host or with the desktop app.
- `start_session` with no sender session (no parent) runs as the host.
- `SessionRuntime.actorOfSession` is in memory. After a restart, a report or
  prompt into an idle session with no recorded actor runs as the host.
- A host with neither the standalone entry nor the `solus` CLI writes no Solus
  helper for members; `gh`, if signed in, is the only answer, else git fails.
- A member's Codex app-server keeps the author it started with until it stops
  (15 minutes idle). A renewed token reaches it at once.

