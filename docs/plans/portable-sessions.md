# Portable sessions

Status: phase 1 implemented, 2026-11-18, on branch `solus/portable-sessions` (§17). Phase 0 ran on 2026-11-18 (§18): the two provider tests passed. Phase 2 is in progress (§19). Phase 4A (desktop and web clients) is implemented (§20). Phase 4B (mobile) is implemented (§21).

Related: [Run location](run-location.md) (run host, checkout),
[Session identity](session-identity.md) (session id, thread id, lineage),
[Session archive](session-archive.md) (home, session list),
[Artifacts storage](cloud-work-artifacts-integration.md) (the Git storage that
works use), [Cross-host sessions](cross-host-sessions.md) (a host as a client of
another host), [Session diffs](../session-diffs.md).

## 1. Goal

A session does not belong to a machine. A machine only runs turns.

A person opens a session, selects a machine in Run on, and sends a prompt. The
session continues there with its full provider thread, its code state, and an
identical diff. The person does nothing more. The machine that ran the session
before can be offline when the person is signed in.

This holds for Claude Code and for Codex, on desktop, web, and mobile.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **session repository** | One Git repository for each session. It holds everything a host needs to run the next turn of the session. |
| **turn commit** | The commit a host writes to the session repository when a turn ends. |
| **head** | The newest turn commit of a session repository. |
| **thread files** | The provider's own files of one thread: the Claude JSONL file and its subagent files, or the Codex rollout files. |
| **rows** | The normalized history rows (`SessionLoadMessage`) of one turn, as the host that ran the turn made them. |
| **code bundle** | A Git bundle with the objects of one turn that the project's origin does not have. |
| **current** | A host is current for a session when its local head is the head that the session record names. |
| **sync** | The work that makes a host current: fetch the session repository, restore the checkout, import the thread files, adopt the records. |
| **prepare** | A sync that a client starts before a prompt, so the prompt does not wait. |
| **run host** | The host the agent runs on, or will run on after Send. This is the term of [Run location](run-location.md). After this plan it can change between turns. |
| **home** | The place that keeps a session's record and list state. This is the term of [Session archive](session-archive.md). |

Do not say "move a session", "migrate", "transfer", "executor", or "owner host".
A session is not on a host, so it does not move. The run host changes.

## 3. What exists today

- **The run host is fixed at the first send.** `isRunOnHostLocked`
  (`workspace-ui/src/components/servers/run-on.ts`) locks Run on for a started
  session. `docs/run-on.md` says "After a session starts, its host is fixed".
- **Thread files are only on the host that ran the thread.** Claude keeps
  `<config dir>/projects/<folder of the cwd>/<threadId>.jsonl`
  (`resolveClaudeSessionFilePath`, `claude-session-helpers.ts`). Codex keeps
  rollout files under `$CODEX_HOME/sessions/` and a state database.
- **Code state has snapshots already.** Each turn has a tree of the full
  worktree at its start and at its end, under `refs/solus/sessions/<sessionId>/…`
  in the project checkout, and a sidecar file `.git/solus/sessions/<sessionId>.json`
  (`git/session-snapshots.ts`). The turn-range refs point at trees. Nothing
  deletes these refs.
- **Works have a Git storage.** `sync/works/` writes each work to a bare
  repository: a local one on a host (`LocalWorkRepositories`) or Cloudflare
  Artifacts on the cloud record service (`CloudflareWorkRepositories`). It has a
  checked push (`--force-with-lease`), a durable pending row, a lease, and a
  retry (`WorkArchiveWriter`). A host cannot use Artifacts today
  (`work-storage-runtime.ts` refuses it), and no route gives a host a
  repository token.
- **A provider switch carries a text summary.** `buildHandoff`
  (`agents/session-handoff.ts`) gives the new thread a selected transcript. It
  does not carry the provider thread.
- **A fork runs where its source runs.** `forkTab`
  (`workspace-ui/src/contexts/workspace/session-opening.ts`) opens the fork tab
  at once; the provider fork happens at the first prompt, on the source's host.
- **A transcript mirror sends a projection to the Solus API** for a published
  organization session. It removes tool result bodies.

## 4. Decisions

1. **The session repository is the session.** Each turn end writes one turn
   commit. Each other flow is a fetch of that repository.
2. **Local first, cloud by default when signed in.** Each host that ran a
   session keeps a local bare copy under its data directory. When the person is
   signed in, the host also pushes each turn commit to Cloudflare Artifacts.
   There is no encryption in this version.
3. **No host owns a session.** There is no lock, no claim, and no release. The
   session record names the host that ran the last turn and the host that runs
   a turn now.
4. **A host never refuses a prompt because it is behind.** It syncs
   automatically and then runs the turn. It asks the person nothing.
5. **One turn at a time for each session.** While a turn runs, a prompt from
   any client goes to the host that runs it, as a queued or steered prompt does
   today.
6. **The checked push is the one guard against two histories.** A push is
   accepted only when the remote head is the head the turn started from. When a
   push is refused, the turns of that host become a fork of the session. Nothing
   is discarded and nothing is merged: a provider thread cannot be merged.
7. **A turn start makes no new network request.** The prompt carries the head
   that the client has in the session record. The host compares it with its
   local head.
8. **All new work runs in the background.** The turn commit and the push start
   after the turn settles. A sync starts when the person selects a host. The
   one wait that stays: the first turn on a host that is not current starts
   when its sync ends.
9. **Code state travels as code bundles.** A bundle holds only the objects that
   origin does not have. The project history comes from origin through the
   host's own clone. Measured on 2026-11-17: a 47 MB `.git` folder, one
   commit that was not pushed, one uncommitted edit, and one untracked file
   gave a 909-byte bundle.
10. **A snapshot travels as a commit.** A bundle of a ref that points at a tree
    holds the full tree (2.4 MB in the same test). Each snapshot tree is wrapped
    in a commit whose parent is in known history.
11. **The diff is identical on each host because the objects are identical.**
    After a sync, the tree id of the restored worktree must equal the tree id
    that the head names. If it does not, the host does not run the turn.
12. **The provider thread continues natively.** Claude resumes by thread id;
    Codex calls `thread/resume` with the thread id and the new `cwd`. If the
    native path fails, the host starts a new thread with the existing text
    handoff, and the conversation says that the context was summarized.
13. **Each turn commit also holds the rows of the turn.** Solus has no parser
    for a Codex rollout file, and the data layer must not import the provider
    adapters. Rows let a reader with no provider process show the turn. Since
    2026-11-21 a turn commit of organization work holds no rows: the transcript
    mirror sends them (§22).
14. **Fork to another host is the existing fork with Run on open.** No new
    action. A fork that names no other host behaves as today.
15. **Not signed in: the same format, another transport.** A host gets the
    session repository directly from the host that has the newest turn. That
    host must be online.

This plan replaces these rules: "After a session starts, its host is fixed"
(`docs/run-on.md`), "machine … does not change" (`session-archive.md`),
"a removed host closes its conversations" (`workspace-and-machines.md` §6),
"tool result bodies never reach the cloud" for the session repository
(decision of 2026-09-19; the mirror keeps its projection), and "No automatic
commit of dirty code is introduced" (`cloud-work-artifacts-integration.md`) for
snapshot commits inside a code bundle. The implementation updates those
documents in the phase that changes the behavior.

## 5. The session repository

Name: `session-<48 hex>`, the first 48 hex characters of
`sha256(JSON.stringify([organizationId, sessionId]))`. Works build
`work-<48 hex>` the same way (`data/works/work-storage.ts`).

One branch, `main`. One turn commit for each turn end.

```
session-<48 hex>.git
  manifest.json
  threads/<threadId>/<file key>/<n>   byte ranges of one thread file, in order
  rows/<n>.jsonl                      the rows of turn n (not for organization work, §22)
  code/<n>.bundle                     the objects of turn n that origin lacks
  diff/<n>.patch                      the turn diff: turn start to turn end
```

- **Thread files are stored as byte ranges.** Turn `n` adds the bytes that the
  provider wrote after turn `n-1`. A host builds a thread file again by joining
  the ranges in order. The result is identical to the source file. If a file
  became shorter or its start changed, the turn stores a full copy under a new
  file key.
- **`<file key>`** names one file of the thread: the main transcript, one
  subagent transcript, or one rollout file of a Codex thread that has several
  (a fork source, a reverted thread).
- **`diff/<n>.patch`** is the turn range, from the turn-start tree to the
  turn-end tree. A reader builds the session total from the manifest and the
  bundles, not from this file.
- **A session with no project** (a chat) has no `code/` and no `diff/`.

### 5.1 The manifest

`manifest.json` is rewritten in each turn commit. Its schema has a version.

| Field | Content |
|---|---|
| `schemaVersion`, `operationId` | As in the work manifest. The operation id makes a repeated push safe. |
| `session` | Session id, organization id, title, model, reasoning effort, permission mode, starter, parent and root session. |
| `forkedFrom` | The source session id and the turn it started from; absent for a session that is not a fork. |
| `threads` | In lineage order: thread id, provider, provider version that wrote it last, its file keys, and how it started (start, fork, handoff). |
| `project` | Repository key, clone URL, branch, base commit, upstream, and a flag that says if the session owns its worktree. |
| `turns` | For each turn: index, the id and label of the host that ran it, time, the `TurnSnapshot` fields of the sidecar (tree ids, commit, `partial`, preview, counts, `traceId`), the provider cut point (Codex turn id, Claude message uuid), and the row count. |
| `sessionPaths` | The paths that changed inside this session's turns (`turnPaths` and `sessionChangedFiles` of the sidecar). |
| `links` | Task key and pull request links of the session. |

A path of another host is never in the manifest as a path to use. The manifest
keeps the project root of the last host only as text for the note of §8.5.

Not in the repository in this version: ignored files and the files that
`.worktreeinclude` names (open decision 3), dependencies, prompt attachments
and transcript images that are files on a host, the activity log, the prompt
queue, pending input, and the run ledger.

## 6. Storage and transport

### 6.1 Shared with works

Extract a transport core from `sync/works/git-work-transport.ts` and keep the
work commit builder on top of it:

- the Git process setup with no checkout (askpass file, no global config, no
  hooks, silent stderr);
- the checked push and the read that confirms it;
- `WorkRepositoryAccess` as the seam for a local and a Cloudflare target. The
  name check accepts `work-…` and `session-…`.

The session writer is separate from `WorkArchiveWriter`. It follows its
pattern: a durable pending row, a lease, a retry, and a check of the operation
id after a lost response.

The works transport passes each body as a string, limits output to 16 MiB, and
gives one push 120 seconds. Session data is large and binary. The session
writer gives Git file paths, not strings, and has its own limits.

### 6.2 The local copy

Each host keeps `<dataDir>/sessions/repositories/session-<48 hex>.git`, a bare
repository that only Solus reads, always with `--git-dir` (ADR 0002). It is
never inside a project folder.

A new table `session_storage` (SQLite on a host) holds for each session: the
repository name, the local head, the pushed head, the pending generation, the
frozen operation, the lease, the next attempt time, and a safe error text.

### 6.3 Cloudflare Artifacts

- The Solus API gets a route that gives a host a short-lived token (15
  minutes) for one session repository. The host calls it with the delegated
  token of the person (`sync/delegations.ts`). The Cloudflare account token
  stays on the Solus API. `CloudflareWorkRepositories.remote` already issues a
  token of this type.
- The host pushes and fetches with native Git and that token.
- A client never gets a repository URL or a token.
- The route and its storage settings are in solus-cloud. They ship before the
  host code that calls them.

### 6.4 Not signed in

There is no shared store. A host gets a session repository from the host that
has the newest turn:

- RPC `sessionRepositoryBundle { sessionId, have }` answers a Git bundle with
  the commits after `have`.
- The request goes through the connection between paired hosts
  (`execution/orchestration/remote-hosts.ts`). If the two hosts cannot reach
  each other, the client relays the bundle in parts.
- The client names the source host: it knows which host ran the last turn.

When the person signs in later, each host pushes its local session repositories
to Artifacts. The format is the same, so there is no conversion.

## 7. A turn

### 7.1 Turn start

1. The client sends the prompt to the run host of the tab. The prompt carries
   `knownHead`, the head from the session record that the client has.
2. The host compares `knownHead` with its local head. This reads one row of
   `session_storage`.
3. Equal, or the client sent no head: the turn starts as today.
4. Different: the host is not current. It runs a sync (§8), then the turn. The
   prompt is accepted at once and shows in the conversation; the setup card
   shows "Syncing from <host>".

A host that is offline, or a client with an old record, sees equal heads and
runs the turn from the local copy. The push at the turn end finds the
difference (§7.3).

### 7.2 Turn end

All of this starts after `turn_settled` is published. Nothing in the turn
waits for it.

1. `endTurnCheckpoint` gives the turn snapshot, as today.
2. In one database transaction, the session writer records a pending
   generation with: the turn index, the snapshot facts, and the length of each
   thread file at this moment.
3. A background job builds the turn commit in the local repository:
   - `AgentBackend.exportThread` gives the byte ranges of each thread file up
     to the recorded lengths;
   - the rows of the turn come from the history reader of the provider;
   - the code bundle holds the turn-start and turn-end snapshots, each wrapped
     in a commit, and the commits of the branch that origin does not have;
   - the diff patch comes from the two snapshot trees;
   - the manifest gets the new turn.
4. Signed in: the job gets a token and pushes the commit with the checked
   push. Then it reports the new head to the session record.

The bundle step reads only objects that the snapshot already wrote, so it does
not hold the snapshot queue of the project, and the next turn's checkpoint does
not wait for it. One background job runs at a time on a host.

A stopped or failed turn writes a turn commit too, with `partial` set, when the
snapshot exists.

### 7.3 A refused push

The remote head is not the head this turn started from: another host pushed a
turn first. The host does not push again.

- The session keeps the remote history.
- The turns that this host ran and could not push become a new session, a fork
  of the first one at the last common turn. The fork has its own session
  repository and is pushed as such.
- The conversation on this host shows "Continued on <host>. Your turns here are
  in a fork." with a link to the fork.

## 8. Sync on a host

One owner, `SessionSync` (`execution/sessions/session-sync.ts`), runs these
steps in order. The setup card of Run on shows them. Each step can be stopped.

### 8.1 Preflight

Provider installed, seat connected for the person, model available, and a
provider version that is not older than the version in the manifest. A failure
changes nothing and names the reason; a missing seat shows "Connect Claude" or
"Connect Codex" as Run on does today.

### 8.2 Fetch

Signed in: fetch `main` of the session repository from Artifacts into the local
copy. Not signed in: §6.4. A host that has a copy fetches only new commits.

### 8.3 Checkout

- `PrepareDispatchCheckout` (`project-config/dispatch-checkouts.ts`) finds the
  host's checkout of the project or makes a partial clone from origin.
- The host fetches each code bundle it does not have into that repository.
- The session gets its own worktree on its branch, at the branch tip from the
  bundle. A host that ran the session before uses its worktree again when the
  worktree still has the tree that this host pushed last. If a person changed
  files there, the host does not overwrite them: it makes a new worktree.
- The host restores the turn-end tree of the head as uncommitted changes.
- The host writes the snapshot refs and the sidecar from the manifest, so
  `session-snapshots.ts` reads them as if the turns ran here.

A session that ran in a shared checkout: the host restores the base tree plus
the session's own paths (`sessionPaths`) from the turn-end tree. Edits of other
authors in the shared checkout do not travel.

### 8.4 Tree check

The host computes the tree id of the restored worktree with the function that
makes a snapshot (`snapshotLiveTree`). It must equal the tree id that the head
names (for a shared checkout: the tree built in §8.3). If it does not, the sync
fails, the turn does not start, and the session repository is not changed.

### 8.5 Thread import

`AgentBackend.importThread` writes the thread files of each lineage member.

- The lineage rows are written first. The indexer watches the Claude folder and
  makes a second session from a file whose thread has no lineage
  (`session-indexer.ts`).
- **Claude.** Join the byte ranges and write
  `projects/<folder of the worktree path on this host>/<threadId>.jsonl` and
  the `<threadId>/` subagent folder, in the home of the person's seat. A host
  that has an older copy of the file writes only the new bytes after it.
- **Codex.** Unload the thread from the app-server if it is loaded. Write the
  rollout files under `$CODEX_HOME/sessions/`. If the state database has a row
  for the thread, write the file at the path the row names: the resolver uses
  that row before it scans the folder (`thread_rollout_resolver.rs`, Codex
  0.167.0).
- The first turn after a sync gets one note in the runtime instructions
  (`agents/runtime-instructions.ts`): the project root on the last host, the
  project root on this host, and a statement that paths in earlier turns map
  from the first to the second.

### 8.6 Records

Same session id. The host writes the session record, the title, the links of
the manifest, and the local head in `session_storage`. Then the host is
current.

## 9. The session record and its home

The session record gets four fields: `head`, `syncedTurn`, `lastRunHostId`,
and `runningHostId`.

- Signed in: the home of each session is the Solus API of the person's
  organization. Clients read the session list and the record from the home, as
  they do for a published organization session today (`sessionHomeId`,
  `client-core/src/session-home.ts`). The record and the list state do not
  depend on a host that is online.
- Not signed in: each host that has a copy keeps the record. A client that
  sees the session on two hosts shows it once, from the host with the higher
  `syncedTurn`.

A host reports a new head to the home after each push. The home sends the
changed record to connected clients.

## 10. Clients

Desktop and web share the Svelte code. Mobile needs its own implementation in
`apps/mobile/`.

- **Run on is open for a started session** when no turn runs. A pick changes
  the run location of the tab in the client at once (`openFolder` in
  `run-location.ts`), keeps focus in the input bar, and calls `sessionPrepare`
  on the new run host in the background.
- **RPC `sessionPrepare { sessionId, knownHead, sourceHostId? }`** starts a
  sync and answers at once. Progress arrives as session events for the setup
  card. A prompt that arrives during a sync waits for that sync; a prompt with
  no prepare starts one.
- **Opening a session** on a tab whose run host is not current also calls
  `sessionPrepare`, so a host that ran the session before is usually ready.
- **States in the conversation and the session row:** "Not synced yet" (a turn
  commit waits for its push), "Syncing from <host>" (a sync runs), "Last ran on
  <host>", and "<host> is offline" with the Run on list when the last run host
  is away.
- **With no host online** (signed in), the session opens read-only from the
  home. The composer keeps the text and says "Choose a machine".
- **Fork.** `forkTab` does not change. Run on stays open on a fork that has no
  prompt yet. A fork whose run host is the source's host behaves as today. A
  fork with another run host: that host syncs from the source session
  repository (read only), makes a new worktree on a new branch, imports the
  source thread, and forks it natively (`forkSession` for Claude, `thread/fork`
  for Codex). The fork gets its own session repository; its first push holds
  the source history up to the fork point.
- **Mobile** gets the host control for a started session and the same states.
  Mobile has no session fork today; the fork option waits for that action (open
  decision 5).

Renderer rules: the new record fields are plain properties of the session
record; no new derivation reads the transcript; a client never reads a session
repository.

## 11. Providers

| | Claude Code | Codex |
|---|---|---|
| Export | Bytes of the JSONL file and of each subagent file | Bytes of each rollout file of the thread |
| Import | Write under the folder for this host's worktree path | Write under `CODEX_HOME`; unload first; honor the state row |
| Continue | Resume by thread id | `thread/resume` with thread id and `cwd` |
| If the native path fails | Native fork (`forkSession`), then the text handoff | Native fork (`thread/fork`), then the text handoff |
| Rows | The existing Claude line parser | `thread/read` on the host that ran the turn |

The Agent SDK has a `sessionStore` option (alpha in 0.3.322) that mirrors a
transcript to a store and loads it on resume. This plan does not use it: byte
ranges of the provider files give one mechanism for both providers and no
dependence on an alpha interface.

## 12. Performance rules

- A turn start on a current host adds one row read and no network request.
- `turn_settled` never waits for a turn commit or a push.
- One background Git job at a time on a host. It gives way to a snapshot.
- These paths never read a session repository: live events and the running
  turn, history pages on a host that has the thread files, the live session
  diff, session lists and previews, and search.
- A sync never blocks the input bar. Only the turn waits.
- A code bundle has a size limit (start: 200 MB). Over the limit, the turn
  commit is written without the bundle, the session shows the name of the large
  file, and a sync on another host stops at the tree check with that reason.

## 13. Applicable surfaces

- **Entry points.** Run on in the composer, the session context menu and action
  row (fork), the session list (open), the command palette where Run on is
  listed, and the agent tools (`start_sessions` with `host` can name an
  existing session in a later phase).
- **Clients.** Desktop, web, mobile, as in §10.
- **Providers.** Claude and Codex, as in §11. The Replay provider exports and
  imports nothing and is always current.
- **Contracts.** `sessionPrepare`, `sessionRepositoryBundle`, `knownHead` on the
  prompt, the four record fields, the sync events, in
  `packages/contracts/src/rpc.ts` and the session types.
- **Reverse states.** A run host change has the same change back. A sync can be
  stopped. A fork is a session with its own archive and delete.
- **Connection modes.** Desktop-local, desktop-hosted, and standalone remote
  hosts all hold a local copy. Only a signed-in person's host pushes to
  Artifacts.
- **Persistence and refresh.** `session_storage` is durable; a restart
  continues a pending push and an unfinished sync. A client that reconnects
  reads the record again and shows one state.
- **Delete.** A deleted session deletes its local copies and its Artifacts
  repository, as a deleted work does. The snapshot refs of a session are pruned
  when its turn commits are pushed and the session is archived.
- **Docs.** `docs/run-on.md`, `docs/session-diffs.md`, `docs/session-history.md`,
  and the plans named in §4.

## 14. Tests

Live tests first. They decide the import details of §8.5 and run with
disposable provider homes and the cheapest model.

1. Claude: copy a transcript and its subagent files under the folder of another
   working directory, resume by id, and read the history.
2. Codex: copy a rollout to a home that never saw the thread, call
   `thread/resume` with a new `cwd`, then do host A, host B, host A with a
   state row present.
3. Codex: resume a copied rollout with another account and with an API key
   (encrypted reasoning and compaction items).
4. Both: resume when the importing host has an older provider version.
5. Artifacts: push a 300 MB session repository and read its limits.

Unit tests, through each module's interface:

- The session commit builder: byte ranges join to the source file; a shorter
  file makes a new file key; the manifest lists each turn once.
- The code bundle: a snapshot is a commit; the bundle of a session whose base
  is on origin holds no history; a fetch into a second clone gives the same
  tree id.
- The session writer: a crash after the pending row, after the local commit,
  and after the push each continue with no lost and no repeated turn; a
  response that is lost is found by the operation id.
- A refused push makes a fork at the last common turn and changes nothing in
  the first session.
- `SessionSync`: each step, a stop in each step, a tree check that fails, a
  worktree with a person's edits is not overwritten, a shared-checkout session
  restores only its own paths, the lineage row is written before the Claude
  file.
- Turn start: equal heads start with no call out of the process; different
  heads start a sync and keep the prompt.
- Clients: Run on is open for a started idle session and locked while a turn
  runs; a pick moves the tab at once; a fork with another run host keeps its
  source.

Lab (`verify-multiplayer`): two hosts and one client. Run a turn on host A,
select host B, run a turn, select host A, run a turn. Check one session, one
history, and equal turn diffs on both hosts. Repeat with host A stopped before
the first change (signed in), with no cloud (paired hosts), and for a fork on
host B while host A runs a turn.

## 15. Order of work

Each phase leaves the tree green and is useful alone.

| Phase | Change | Result |
|---|---|---|
| 0 | The live tests of §14 | The import rules of §8.5 are facts |
| 1 | `session_storage`; the session writer; the thread files of both providers; code bundle, diff patch, manifest; local copy only | Each turn is in a local session repository |
| 2 | `SessionSync`, `importThread`, the tree check, `sessionRepositoryBundle`, `sessionPrepare`, `knownHead`; the Lab scenario with paired hosts | A session continues on a second host when the person is not signed in |
| 3 | The transport core shared with works (§6.1); solus-cloud token route; push and fetch with Artifacts; the record fields and the home for a signed-in person; the refused-push fork | A session continues when the last run host is offline |
| 4 | Run on for a started session, the states, the fork option, on desktop and web; then mobile | The person can use all of it |
| 5 | The rows of each turn (§4 decision 13); read-only open with no host online from rows and diff patches; `read_session` from the session repository | A session is readable everywhere |

The reuse survey of 2026-11-17 (session "Session repository reuse survey")
lists more places that can read the session repository after phase 3.

## 16. Open decisions

Each has a default that this plan uses until a maintainer decides.

1. **Who serves a read when no host is online?** Default: the Solus API of the
   person's organization, from the rows and the diff patches (phase 5).
2. **The home of a session of a person with no organization.** Default: every
   account has a workspace on the Solus API, and that is the home.
3. **Files that `.worktreeinclude` names** (frequently secrets). Default: not
   in the session repository. The client carries them as Run on does today, and
   a sync from an offline host arrives without them.
4. **When to write a turn commit.** Default: at each turn end, and for a
   stopped turn. Not during a turn.
5. **Session fork on mobile.** Default: an approved exception until mobile has
   the fork action.
6. **A child session of a lead session.** Default: each session has its own
   repository; a run host change of the parent does not change its children.
7. **Organization admission.** Default: each turn passes admission on the host
   that runs it, as a prompt does today.

## 17. Phase 1 as implemented (2026-11-18)

Each ended turn of a session is written to a local session repository. Nothing
reads the repository yet, and no client changed.

- **Hook.** `archiveTurn` in `execution/sessions/run-lifecycle.ts` tells the
  writer when a run of a session settles. It is not awaited. A run that is not
  a completed turn (stopped, failed) is written with `partial`.
- **Writer.** `sync/sessions/session-archive-writer.ts`. `turnEnded` records the
  turn in `session_storage_turns` with the length of each thread file and the
  checkout facts of that moment, then answers. One background job at a time
  builds the turn commit. A failed commit is tried again with a wait that
  doubles up to 30 minutes, and after a restart.
- **Repository.** `sync/sessions/session-repository.ts` keeps
  `<dataDir>/sessions/repositories/session-<48 hex>.git` and builds a commit
  from streams with no checkout. `sync/sessions/session-manifest.ts` is the
  manifest schema.
- **Thread files.** `AgentBackend.threadFiles`. Claude: the transcript and each
  file in the thread's own folder (subagent transcripts and saved tool
  results). Codex: the rollout file that `thread/read` names.
- **Code state.** `git/session-code-bundle.ts` writes the bundle and the diff
  patch from the snapshots of `session-snapshots.ts`.

Differences from the sections above:

1. **Storage shared with works (§6.1) moved to phase 3.** A local copy needs no
   push, so phase 1 has its own small Git runner, as `LocalWorkRepositories`
   has. The shared transport core is extracted when the push to Artifacts is
   built.
2. **Rows (§4 decision 13) moved to phase 5.** No reader of rows exists before
   that phase, and the rows a cloud reader can show depend on open decision 1.
   A later phase can build the rows of old turns from the thread files on a
   host that has the provider.
3. **The manifest holds less than §5.1 lists.** It holds the session id and
   organization, the threads and their files, the repository key, the base
   commit, the worktree flag, and the turns with their snapshots, head, bundle,
   and patch facts. The title, model, links, `sessionPaths`, provider versions,
   and provider cut points are added by the phase that first reads them.
4. **`session_storage` has no pushed head and no lease.** One process writes a
   local copy, so jobs run one after the other in that process. The operation
   id in the manifest finds a commit that landed before a crash.
5. **A file that became shorter starts under a new key; a file whose start
   changed is not detected.** Both providers only append.
6. **A Codex thread with more than one rollout file** (a fork source, a
   reverted thread) carries only the file that `thread/read` names. Phase 0
   test 2 decides what more must travel.
7. **Nothing deletes a session repository.** Solus has no session delete; the
   indexer removes the record of a thread whose provider file is gone, and that
   is the case in which the repository must stay. Retention is not decided.
8. **After a restart, a waiting turn commit runs as the host,** not as the
   member who ran the turn.

## 18. Phase 0 results (2026-11-18)

Run with Claude Code 2.1.314 (`claude-haiku-5-5`) and Codex 0.167.0
(`gpt-6-luna`, low effort), in throwaway folders.

| Test | Result |
|---|---|
| 1. Claude: transcript copied under the folder of another working directory, resume by id | Passed. The thread kept its id and its memory, and new lines went to the copy. |
| 2. Codex: rollout copied to a home that never saw the thread, resume in another folder | Passed. Only the rollout file was copied. The thread kept its id. |
| 2. Codex: host A, host B, host A, with a state row on host A | Passed. The rollout was written over the old file at the same relative path while no process had the thread loaded. |
| 3. Codex with another account or an API key | Not run: one account was available. |
| 4. An older provider version on the importing host | Not run: one version of each provider was installed. |
| 5. Artifacts size limits | Not run: no Cloudflare credential was available. |

Facts that §8.5 now relies on:

- **Claude continues by resume, not by fork.** A transcript under
  `projects/<folder of the new working directory>/<threadId>.jsonl` resumes
  with the same thread id. On one host, the CLI also finds a transcript that
  is under another project folder, and then writes to that file.
- **Codex needs only the rollout file** at the same relative path under
  `sessions/`. `thread/resume` with `threadId` and `cwd` keeps the thread id and
  uses the new folder.
- **Codex history is stale until a resume.** On a home with an older copy of
  the thread, `thread/turns/list` answered the old turns after the rollout was
  replaced. After `thread/resume` it answered all turns. An import therefore
  ends with one `thread/resume`, which costs no model call.
- **`thread/unsubscribe` unloads a thread** and `thread/read` names the rollout
  path in 0.167.0.

Not tested: Claude subagent transcripts and saved tool results on another
host, and a Codex thread that has more than one rollout file.

The Claude test ran in the developer's own Claude home, in throwaway project
folders that were deleted after the test: a new `CLAUDE_CONFIG_DIR` has no
login. The Codex tests ran in two disposable homes with a copy of `auth.json`,
deleted after the test.

## 19. Phase 2 work parts

Phase 2 is built in parts. Parts A to C have no dependence on each other.
Part D uses all three.

- **A. Repository between hosts** (`sync/sessions/`). Read side of
  `SessionRepositories`: make a Git bundle of the commits after a given head,
  fetch a bundle into the local copy with a checked fast-forward of `main`,
  and read the manifest and the files of a head. The manifest gains the fields
  that a sync reads: the session title, model, reasoning effort, permission
  mode, the lineage members in order, `sessionPaths`, the branch and head of
  the last turn, and the project root of the last host as text. The writer
  fills them at each turn commit.
- **B. Code restore** (`git/session-code-restore.ts`). Given a project
  repository on this host, the bundle files in turn order, and the manifest
  facts: fetch the bundles, give the session a worktree on its branch (or use
  the one it had when its tree is unchanged, or make a new one when a person
  changed files there), restore the last turn-end tree as uncommitted changes,
  write the snapshot refs and the sidecar, and check the tree id (§8.3, §8.4).
  A session that did not own its worktree restores the base tree plus its own
  paths.
- **C. Thread import** (`AgentBackend.importThread`). Write the thread files
  from the byte ranges of a head into the provider home of the acting person:
  Claude under the folder of the new worktree path, Codex at the same relative
  path with an unload before and a `thread/resume` after (§8.5, §18). The
  lineage rows are written before any Claude file.
- **D. Sync and turn start** (`execution/sessions/session-sync.ts`). The
  `SessionSync` owner that runs preflight, fetch, code restore, thread import,
  and record adoption in order, with stop and progress events;
  `sessionPrepare` and `sessionRepositoryBundle` in the RPC contract and their
  handlers; `knownHead` on the prompt and the local comparison at turn start.

### Part A implemented

`SessionRepositories.bundleSince` writes a full or incremental Git bundle and
answers `current` or `diverged` without writing one. `fetchBundle` checks the
incoming history in a temporary bare repository before it moves local `main`;
a divergent bundle raises `SessionBundleDivergedError`. The read side parses a
head manifest and streams thread parts and code bundles to disk. Git reads the
bare copies only with `--git-dir`.

New turn commits hold the session settings, starter, lineage order,
`sessionPaths`, and the last host's project root as text. The turn already holds
the branch and head. The schema remains version 1: a phase-1 manifest parses
with these later fields absent. A sync must treat an absent field as unknown and
get the fact from local records or stop when it cannot do so safely. This keeps
old turn commits readable without inventing their missing facts.

### Part B as implemented (2026-11-18)

`git/session-code-restore.ts` fetches missing bundles in turn order, makes or
reuses a session worktree, applies the final tree, checks its tree id, and then
writes the snapshot refs and sidecar. A changed prior worktree is left intact.
For a shared checkout, the new worktree uses `solus/session-<sessionId>` when
the source branch is checked out in the main checkout. Git cannot check out
one branch in both places. The session's own paths are applied to the base
tree; the main checkout is not changed.

### 19.C Thread import implementation (2026-11-18)

`AgentBackend.importThread` takes a session id, thread id, complete source files,
this host's working directory, an optional seat or private provider runtime, and
an abort signal. It returns each file's status and the bytes written. Claude
binds lineage before it writes any file. Codex unloads, writes at the path of
an existing state row when one exists, then resumes with the new working
directory. An identical file is left alone; an older prefix gains only new
bytes. A divergent destination is a `conflict` result and is left unchanged.
No side copy is made in the provider folder because the provider could mistake
it for another thread file.

### Part D as implemented (2026-11-18)

`SessionSync` in `execution/sessions/session-sync.ts` makes a host current for
one session. Two prepare calls for the same session join one in-flight sync.
Stop aborts the sync. It stages an incoming repository under a temporary
directory, reads its manifest, restores code with Part B, imports each thread
with Part C, adopts a session record with the same id, and then advances the
local repository and `session_storage` head. The source is one callback:
`fetchBundle(sessionId, have, sourceHostId, outFile, signal)`. Phase 3 can put
Artifacts behind it without changing the owner.

The contract for no-cloud clients is:

- `sessionPrepare({ sessionId, knownHead, sourceHostId?, repository? })`
  answers `{ state: 'current', head }` or `{ state: 'started' }` at once.
  `repository` is the existing `DispatchRepository`. An equal or absent
  `knownHead` reads only `session_storage`; it makes no network request.
- `PromptOptions` adds `knownHead?: string | null` and
  `sourceHostId?: string`. A prompt behind the local head waits for sync and
  then enters the normal admission and native resume path with its text kept.
- `sessionRepositoryBundle({ sessionId, have })` answers `ready` with
  `transferId`, byte `size`, and `head`, or `current`, `diverged`, or
  `no-repository`. The RPC access gate requires `session.read.transcript`.
  `sessionRepositoryBundleChunk({ transferId, offset })` answers base64 `data`
  and `done`. Its handler checks that the same principal still has transcript
  standing. A transfer expires after ten minutes without a read and closes
  after its last chunk or when the server stops.
- `getSessionInfo` and `getSessionInfos` include plain `head` and
  `syncedTurn` properties on local `SessionMeta`, read from the
  `session_storage` row. `turn_count` is written with each local turn commit or
  sync; lists read neither a transcript nor Git.
- One `status_card` uses id `session-sync-<sessionId>` and stable steps
  `fetch`, `preflight`, `checkout`, `thread`, `records`. The states are
  `pending`, `active`, `done`, and `error`. A failed card carries
  `syncFailureReason`. Sync failures use the typed reasons
  `provider-unavailable`, `seat-required`, `model-unavailable`,
  `provider-too-old`, `source-offline`, `no-repository`,
  `no-project-checkout`, `diverged`, `code-restore`, `thread-conflict`,
  `interrupted`, and `failed`.

The source host serves at most 1 MiB of binary bundle per chunk. Base64 makes
the data field about 4/3 of that size, and each chunk costs one RPC round trip.
The syncing host writes one decoded chunk at a time to a temporary file and
checks the declared size. This uses `RemoteHosts` over its admitted WebSocket
connection. There is no HTTP route or client relay.

The checkout lookup uses `project.repositoryKey` against an existing dispatch
checkout first. If none exists, the client may send `DispatchRepository`; the
setup owner makes only its repository ready and Part B makes the one session
worktree. With neither source, sync reports `no-project-checkout`. The
manifest still has no clone URL or `.worktreeinclude` bytes. The restored
worktree gets missing copied files from the client request. A local record
supplies the old worktree path after a host restart, so Part B can reuse it.

Differences from the earlier plan: the destination fetches a temporary bundle
before provider preflight, because the manifest is inside that bundle. It does
not advance its repository until preflight and restore finish. The manifest
has no provider version, so `provider-too-old` is reserved for a future
versioned manifest. Part A has no links field, so record adoption does not
copy links. A projectless session uses a fresh local chat folder. The first
turn after a successful sync gets one path mapping note in the system prompt.
The source connection uses the acting person's reach: an owner uses their
personal delegation or introduced hosts, and an organization member uses
their organization delegation. When a client's head is stale and the source
answers `current`, this host ends setup as current without a second restore.

#### Part D verification and limits

The focused Bun run covered 50 tests in 12 files: `session-archive-writer`,
`session-repository-sync`, `session-code-restore`, `session-code-bundle`,
`thread-import`, `thread-files`, `session-archive-turn-end`,
`session-bundle-access`, `session-bundle-transfers`, `session-sync-gate`,
`session-sync-prompt`, and `data-model-baseline`. All 50 passed. The new
tests use temporary data directories, real Git, and fake providers. They
check the unchanged fast path, a stale client head, a joined sync, Stop at each setup step, a
projectless import, code tree and copied files in a project import, typed
failures, transfer ownership, and the repository read gate. No test starts a
real provider turn. `bun run lint:hosts` cannot run in this checkout: that
script is absent. `bunx oxlint` found no issue in new files or changed lines;
it still reports older findings in large existing files. Plain TypeScript
checking still reports older repository errors. A full two-server test in one
process was not run because boot and host data ownership use process globals.
The two data directory Git test covers the transfer and restore semantics,
but does not prove a live host-to-host socket or UI flow.

The desktop preload exposes native shell methods only. The desktop renderer,
web client, and mobile client build their host RPC API from the shared method
registry; the three new names need no hand-written preload method. The RPC
bundle start uses the existing session `read.transcript` access gate. A chunk
also checks that its random transfer id belongs to the same principal and
that the principal can still read that session. Each remote RPC call has the
existing `RemoteHosts` 30-second timeout. Bundle generation or a chunk that
takes longer fails the sync with `source-offline`; there is no resume token
after a failed transfer. There is no cloud source or client relay in Part D.

Part C writes lineage before provider files, as its own interface requires.
If a later file reports `conflict`, the destination repository stays at its
old head and a new worktree is removed, but that earlier lineage row can
remain. An import that wrote one file before another failed can also leave
provider files. A retry uses Part C's prefix and identical-file rules. These
side effects are a limit of the Part C import contract; Part D has no
transaction across provider homes, Git worktrees, and the session database.
An interruption during record adoption can leave a claimed or started record
before `session_storage` moves. The retry reads the old local head and can
finish adoption. The session repository itself remains at its old head until
the final fast-forward. A failure between that fast-forward and the storage
row update can also leave the Git head ahead of `session_storage`; this needs
a recovery transaction in a later change.

The changed paths are `packages/contracts/src/{types,rpc,rpc-planes,host-api,permissions}.ts`,
`packages/server/src/admission/access-policy.ts`, `packages/server/src/boot-server.ts`,
`packages/server/src/db/host-tables.ts`, `packages/server/src/execution/agents/runtime-instructions.ts`,
`packages/server/src/execution/session-runtime.ts`,
`packages/server/src/execution/sessions/{dispatch-repository,run-launcher,session-bundle-source,session-sync}.ts`,
`packages/server/src/sync/sessions/{session-archive-writer,session-bundle-transfers}.ts`,
`packages/server/src/transport/handlers/{history-handlers,session-handlers,session-repository-handlers,session-sync-prompt,setup-handlers}.ts`,
the generated SQLite migration and metadata `0003_session_turn_count`, the four
new `tests/unit/session-{bundle-access,bundle-transfers,sync-gate,sync-prompt}.test.ts`
files, `tests/unit/data-model-baseline.test.ts`, and this plan. The touched
files above 600 lines are `contracts/src/types.ts`, `contracts/src/rpc.ts`,
`contracts/src/host-api.ts`, `server/src/boot-server.ts`,
`server/src/execution/session-runtime.ts`,
`server/src/execution/sessions/run-launcher.ts`, and
`server/src/transport/handlers/setup-handlers.ts`. They were already large;
this change adds only small wiring there.

### Part E as implemented (2026-11-18)

`PromptOptions.forkSourceSessionId?: string` names the source session of a
fork's first prompt. When `forked` and this id are both set, `knownHead` and
`sourceHostId` name the source state. The prompt gate compares the source's
local head, joins or starts `SessionSync` for the source if needed, and then
replays the unchanged fork context through the existing fork path. An equal
head makes no network request. A normal prompt still gates on its own id.

The source sync publishes progress on the source session. On failure, the
gate publishes `session-sync-<fork session id>` with `syncFailureReason` on
the fork conversation and does not start a provider. The card belongs to the
fork because that is the tab where the person sent the prompt. The new fork
session keeps its own id and first turn repository. The writer records the
new thread's files and marks its first lineage member `fork`. The optional
`forkedFrom` manifest field is deferred: the writer does not receive the
source session id and exact source turn count at the fork point.

## 20. Phase 4A as implemented (2026-11-18)

Desktop and web (`packages/workspace-ui/`, `packages/client-core/`). No server
change; mobile is the next part and reuses the client-core modules below.

### What the client does

- **Run on is open for a started session** between turns.
  `isRunOnHostLocked` (`components/servers/run-on.ts`) locks it only while a
  turn runs (`isSessionBusyStatus`, or `background`), while a sent prompt
  still waits for its host (`outboundPrompts`), or when the session is read
  only. A started session had no Run on control in the composer; it now has
  one row under the composer card (`components/input/RunHostRow.svelte`), at
  the place where a draft's destination strip is.
- **One owner for a run host change**: `RunHostChanges`
  (`contexts/workspace/run-host-changes.ts`, `workspace.runHosts`). A pick
  calls `moveTabToHost` at once: the tab's location changes, the old host is
  unwatched and released, the new host is retained and watched (a pending
  fork is not watched; its first prompt watches it). Then, in the
  background, it reads the session info of the host that has the newest turn
  once (its head changes with each turn), and calls `sessionPrepare` on the
  new host with `knownHead`, `sourceHostId`, and `repository`. The
  repository is the one a Run on send builds (`syncRepository` in
  `run-on.ts`): the clone's repository, or `cloneUrl` from the project's
  repository key, with the client's GitHub credential and the copied files.
  Nothing waits for it; focus stays in the composer.
- **Adopting the run host.** When `sessionPrepare` answers `current`, or the
  `session-sync-<sessionId>` card from the run host ends `done`, the owner
  reads the session info of the run host and points the tab at its `cwd` (the
  worktree that host restored or kept), then reads Git there again.
- **Every prompt carries `knownHead` and `sourceHostId`**
  (`prompt-dispatch.ts`, `RunHostChanges.promptFields`) when another host has
  a newer turn than the run host. When the run host has the newest turn
  that this client knows, the prompt carries neither, so the host starts the
  turn with no sync (§7.1). The facts come from reads that already happen;
  the send path makes no request for them. An outbox redelivery carries them
  too.
- **Facts.** `SessionListStore` keeps, for each session, the `head` and
  `syncedTurn` that each host answered (`hostTurnsFor`). It learns them from
  every batched session info read (`onSessionMetaRead` in
  `client-core/session-meta.ts`), from `resumeSession`, and from each
  `turn_settled` event: the host that ran the turn has one more turn than any
  host this client knows (`afterTurnSettled`).
- **One session, shown once.** The list keeps each home's record of a session
  (`listedRecords`) and draws the row from the home with the higher
  `syncedTurn` (`listedSessionHost`). When two homes list the same session,
  the store reads each home's session info once. The picker and search merge
  rows with `mergeSessionHomes`, which now asks `newestHostOf` among the
  connected hosts.
- **Opening a session** calls `RunHostChanges.opened`, which prepares the run
  host only when the known facts say another host is ahead.
- **States.** The sync card shows plain step labels and a text for each
  `syncFailureReason` (`client-core/session-sync-card.ts`). The labels are
  set once, when the card's event arrives (`hooks/agentEvents.svelte.ts`,
  `conversation/lib/session-sync-view.ts`), so every reader of the card shows
  the same words. `SessionStatusCard.svelte` draws it, with **Connect
  Claude** / **Connect Codex** for `seat-required` (it opens the existing
  seat connect card) and **Choose a host** for the reasons that another host
  can fix (it opens the Run on list). The session row's host line names the
  host with the newest turn and says "Last ran on <host>" on hover. The Run on
  row says "<host> is offline" when the host with the newest turn is offline;
  when that host is the run host and it is away, the composer stays (typing
  is possible) instead of the host panel, if another host can be chosen.
- **Fork.** `forkTab` keeps its default and now records
  `forkSourceSessionId` on the fork (persisted in `pendingFork`). A pick of
  another host for a fork that has no prompt yet prepares the source session
  on that host, and the fork's first prompt carries `forkSourceSessionId`,
  `knownHead`, and `sourceHostId` of the source.
- **Persistence.** A tab snapshot keeps the host that has the conversation
  until the new run host is confirmed current (prepare answered `current`, the
  sync card ended `done`, or a prompt went there), then the new host
  (`RunHostChanges.persistedLocation`). A pending fork keeps its pick at once.
- **A removed host.** `reconcileMachineReferences` moves a started tab on a
  gone host to a host that has a copy of its session (from the facts) instead
  of closing it; with no copy it closes as before.

### Client-core for mobile

- `session-heads.ts`: `SessionHostTurn`, `sessionHostTurnOf`,
  `withSessionHostTurn`, `afterTurnSettled`, `newestSessionHost`,
  `sessionSyncSource`, `listedSessionHost`.
- `session-sync-card.ts`: `isSessionSyncCard`, `sessionSyncStepLabel`,
  `sessionSyncFailureAction`, `sessionSyncFailureText`, `sessionSyncCardView`.
- `session-meta.ts`: `onSessionMetaRead`.

### Decisions

1. **The source host id is the installation id** of that host (from its
   server info, else the saved server), because the run host finds the source
   with `RemoteHosts.find`, which matches a host id, an installation id, or a
   label. A client server id such as `local` means nothing to another host.
2. **No head is sent when the run host has the newest turn.** A stale head of
   the run host itself would start a sync from no source.
3. **A pick reads the newest host's session info once** before
   `sessionPrepare`, so the head is the one after its last turn. This is a
   background read at pick time, not on the send path.
4. **The tab is pointed at the restored `cwd` after the sync**, because a
   later prompt on a current host uses the client's working directory.
5. **The started-session Run on is a new row under the composer card**, not
   the toolbar, because the toolbar hides destination controls for a started
   session and the draft strip is where the person already looks for Run on.
   "<host> is offline" sits in the same row. The sync card's **Choose a host**
   opens it through the existing `solus:toggle-run-picker` event.
6. **"Last ran on <host>"** is on the session row's host line (its hover title
   and label); no new banner.
7. **A reload before the new host is current restores the old host**, so a tab
   never comes back on a host that has no copy of its conversation.
8. **`ConversationView.svelte` had 998 lines.** The setup card slot moved
   into `SessionStatusCard.svelte` so the file stays under 1000 lines.
9. **A project picked in the project flow for a started session still opens
   beside it** (`project-picker.svelte.ts` now asks `hasSessionStarted`, not
   the Run on lock).

### Limits

- The host writes its turn commit after `turn_settled`. A pick within that
  short time reads the old head; when the new host already has that head, it
  does not sync, and its next turn starts from the turn before. A server
  answer that compares turn counts would close this gap.
- An archive or snooze goes to the home that shows the row. With two homes
  (no cloud), the other home still lists the session until it is archived
  there too.
- A session with no session repository (from before phase 1) has no facts; a
  pick moves the tab and nothing syncs.
- The sync card for a fork's source is published on the source session, so
  the fork tab shows only the failure card that the prompt path publishes.
- The **Choose a host** action opens the Run on list of the main composer; a
  conversation in another pane opens its own list with the Run on shortcut.
- Not built in this phase: "Not synced yet", read-only open with no host
  online, and the signed-in home (§10, phase 3 and 5).

## 21. Phase 4B as implemented (2026-11-18)

Mobile (`apps/mobile/`). No server, client-core, or Svelte change. The phone
uses `session-heads.ts` and `session-sync-card.ts` from client-core. It does
not use `onSessionMetaRead`: that hook lives in `session-meta.ts`, which
imports `serverConnections`, a browser-only module that the phone bundle may
not import (`native-mobile-boundaries.test.ts`). The phone learns the facts
from its own reads instead.

### What the phone does

- **One owner for the facts**: `SessionRunHosts`
  (`features/threads/session-run-hosts.ts`, `app.runHosts`). It keeps the
  `head` and `syncedTurn` that each host answered for each session. It learns
  them from the `describeSession` read that each conversation makes when it
  opens, from the batched `getSessionInfos` read below, and from each
  `turn_settled` event (`afterTurnSettled`, counted once for each turn id).
- **The host control for a started session** is a row under the composer's
  questions and cards, above the composer: "on <host>" with the host's
  machine mark (`ThreadRunHostRow.tsx`). It opens a sheet, **Run on**, with
  one row for each host; an offline host is disabled. The rule is
  `runHostRowView` (`features/threads/lib/run-host-row.ts`): the row shows for
  a started session that the reader may prompt, when another host is
  connected. It is locked while a turn runs (`isSessionBusyStatus`), while
  background work runs, while a prompt waits in the outbox, and while files
  are attached or uploading (they are on the run host).
- **A pick** (`SolusApp.moveConversation`) opens the conversation on the
  chosen host at once and closes the one on the host it leaves, which
  unwatches that host. The thread route changes its `hostId`. The new
  conversation shows the transcript that the old one showed
  (`ConversationTarget.carriedTranscript`) and the draft moves with it, so
  nothing on screen waits. The sheet closes and the composer takes focus.
- **Prepare.** After its first load and watch, a conversation calls
  `SessionRunHosts.opened`. For a pick, or when the facts say another host
  is ahead, it reads the newest host's info once, then calls `sessionPrepare`
  on the run host with `knownHead` and `sourceHostId`. The watch comes first,
  so the run host's sync card reaches this conversation. When the answer is
  `current`, or the sync card ends `done`, the conversation drops the carried
  transcript and reads the host's own history, in the folder that host keeps
  the session in (`describeSession` `cwd` and `projectPath`). A failed sync
  keeps the carried transcript.
- **No repository is sent.** The phone has no copied files and does not
  build a `DispatchRepository` for a new session on another host either. A
  host with no checkout of the project fails with `no-project-checkout`, and
  the card says so.
- **Every prompt carries `knownHead` and `sourceHostId`** when another host is
  ahead (`promptFields` in the outbox drain of `ConversationController`). The
  facts come from reads that already happened; the send makes no request.
  `sourceHostId` is the installation id: the phone keeps each host under its
  installation id, and the host's `serverInfo.installationId` wins when it is
  read.
- **One session, shown once.** `ThreadDirectory` draws a session that two
  hosts list from the host with the higher `syncedTurn`
  (`listedSessionHost`). It reads the facts of each such host once, in one
  `getSessionInfos` call for each host, and draws the list again when they
  arrive. Each host's own copy stays readable by `thread(hostId, sessionId)`.
- **States.** The sync card (`WorktreeSetupCard.tsx`) shows the step labels,
  the title, and the failure text of `sessionSyncCardView`, named with the
  hosts' labels. A failure shows its full text under the steps, with
  **Choose a host** (opens the Run on sheet) when another host can be chosen,
  or **Connect Claude** / **Connect Codex** for `seat-required` (the
  existing sign-in sheet). The thread header names the host with the newest
  turn, "Last ran on <host>", when it is not the run host. The row says
  "<host> is offline" when the host with the newest turn is away. When that
  host is the run host, or the run host is away while the facts name a newest
  host, the composer stays in place of the asleep card
  (`withRunHostChoice`), so the person can type and choose another host.
- **Fork.** The phone has no session fork action. This is the approved
  exception of §16 decision 5; nothing was added.

### Decisions

1. **A pick changes the thread route's host**, because a phone conversation
   is one store for each host and session. The carried transcript keeps the
   conversation on screen while the new host syncs.
2. **The host control is a row with a sheet**, not a native menu, so the sync
   card's **Choose a host** can open the same choice.
3. **The control is locked while files are attached**, as Auto balance keeps a
   draft with attachments on its host (docs/run-on.md).
4. **The phone keeps no facts across launches.** A relaunch reads them again
   when a conversation opens or when two hosts list a session.
5. **"Last ran on <host>" is in the thread header**, where the phone names
   the conversation's host today. The list row already comes from the host
   with the newest turn and names it.

### Limits

- Before the new host lists the session, a relaunch opens the thread on the
  host it was on before (the saved route is written only for a listed
  session), as desktop decision 7 does.
- A draft edit within the save delay before a pick can be saved under the
  old host; the composer keeps the text on screen.
- On iPad, the sidebar selection follows the row's host; until the new host
  lists the session, the selected row can be the old host's.
- A session with no session repository (from before phase 1) has no facts:
  a pick moves the conversation, and the new host gets no head.
- Not built in this phase: "Not synced yet", and read-only open with no host
  online.
- The changed `conversation-controller.ts` (1292 lines; 1229 before) and
  `ThreadDetailScreen.tsx` (730 lines; 720 before) were already over the size
  limits; this change adds only small wiring there.

## 22. Primitives (2026-11-20)

This is the public surface of portable sessions after the primitives refactor
and after the move to the Git storage layer that works also use
([ADR 0004](../adr/0004-shared-git-storage.md)). The sections "as implemented"
above keep the names of their date; the table at the end of this section gives
each name that changed.

The rule: a function that takes the same handle or the same set of facts as
its neighbours is a method of the object that holds them, or takes one named
type. A pure rule of one input object stays a function.

### Contracts (`packages/contracts/src`)

- `SessionCloudScope` (`person:<id>` or `organization:<id>`), with
  `formatSessionCloudScope` and `parseSessionCloudScope`: where a session
  repository is in the cloud. Hosts, the Solus API routes, and the readers use it.
- `SessionRepositoryFacts`: `head`, `syncedTurn`, `lastRunHostId`,
  `runningHostId`. Each Solus API answer, `session.headChanged`, and each
  client use these four facts.
- `SessionRepositoryCard`: the list card that a host reports with a pushed head.
- The token route: `SessionRepositoryTokenRequest`, `…TokenResponse`,
  `…TokenRefusal`, `SESSION_REPOSITORY_TOKEN_PATH`.
- The head route: `SessionRepositoryHeadRequest` (`pushed`, `running`, or
  `idle`), `…HeadResponse`, `…HeadRefusal`, `SESSION_REPOSITORY_HEAD_PATH`.
- Solus API operations: `listMySessions` (`ListMySessionsResponse`) and
  `sessionTurnDiff` (`SessionTurnDiff`).
- Event topic: `session.headChanged` (`SessionHeadChanged`).
- RPC methods between hosts and from clients: `sessionPrepare`
  (`SessionPrepareRequest`, `SessionPrepareResult`), `sessionRepositoryBundle`,
  and `sessionRepositoryBundleChunk`. `SessionSyncFailure` names each reason
  that a sync fails.
- `HostApi` methods that only a Solus API connection answers:
  `sessionCloudList()` and `sessionTurnDiff(sessionId, turnIndex)`.
- Fields on older types: `PromptOptions.knownHead`, `.sourceHostId`,
  `.forkSourceSessionId`; `SessionMeta.head`, `.syncedTurn`, `.pushRefused`;
  the four facts on `SessionRecord`; `StatusCardState.syncFailureReason`;
  `SessionHistoryPage.availability`, `.unavailableTurns`, `.turnIndex`; the
  prompt refusal code `SESSION_DIVERGED`.
- The host setting and the policy limit `sessionCloudSync`, and
  `sessionCloudSyncSwitchState` for the switch.

### Server data (`packages/server/src/data/sessions`, `db`)

- Host table `session_storage`: one row for each local copy (repository name,
  head, turn count, last commit error, and the push state). `readSessionStorage`
  (`SessionStorageRow`) is its one read; the archive writer, the pusher, and
  the sync write it.
- Host table `session_storage_turns`: the turns that ended and have no commit.
  Only the archive writer uses it.
- Solus API table `session_repositories`: the key (cloud scope, session id),
  the repository name, the four facts, and the card. `session-repositories.ts`
  owns it: `SessionRepositoryRow`, `readSessionRepository`,
  `createSessionRepository`, `listPersonalSessionRepositories`,
  `sessionRepositoryFacts`, `cloudSessionRepositoryName`.
- `ensureImportedSessionLineage`, `hasTranscript`, and `messageSchema`: used by
  the sync and by the cloud read.

### Server sync (`packages/server/src/sync`)

- The Git storage layer (`sync/git-storage`, ADR 0004): the Git commands, the
  Cloudflare Artifacts calls, and the local Git remote. Works use the same
  layer. A session gives only its repository names, its file layout, and its
  admission rules.
  - `GitRepository` (`GitRepositoryOptions`, `GitIo`): one bare repository on
    disk. It owns the storage policy of the Git process runner
    (`git/git-process.ts`,
    [ADR 0005](../adr/0005-one-git-process-runner.md)); the runner starts each
    process, and a failed one gives a `GitProcessError` with a typed reason.
    `git`, `gitBytes`, `init`, `head`, `setHead`, `isAncestor`, `fetchMain`,
    `borrowObjects`, `readText`, `readBytes`, `appendFiles`, `writeBlob`,
    `writeCommit` (`GitCommit`, `GitCommitEntry`, `GitFileEntry`), and `path`. `repositoryPath(root, kind, name)` gives the path of a named
    repository in a folder.
  - `GitRemote` (`GitRemoteOptions`, `CheckedPushResult`): the remote of one
    `GitRepository`, with a token. `repository`, `remoteHead`, `checkedPush`,
    and `close`.
  - `RepositoryProvider`: the place that holds the cloud copies. `remote`,
    `readFile`, `remove`, and `storageScope`. Its adapters are
    `ArtifactsRepositoryProvider` (Cloudflare Artifacts) and
    `LocalGitRepositoryProvider` (a folder of bare repositories).
    `RepositoryFileTooLargeError` is the answer for a file over the read limit.
  - `storageRepositoryName(kind, owner, id)` and `isStorageRepositoryName`
    (`data/storage-repository-name.ts`): the one name rule.
- `SessionRepositories`: the folder of local copies. `named(name, signal?)`
  gives a `SessionRepository`. It alone knows the path of a copy.
- `SessionRepository`: one local copy. It extends `GitRepository` with the
  session rules: `readManifest`, `writeThreadFile`, `commit`, `bundleSince`,
  `fetchBundle`, and `push`. `sessionRepositoryName` gives the local name.
  `TurnCommit` is the input of `commit`; its entries are `GitFileEntry`.
  `SessionHeadMovedError` and `SessionBundleDivergedError` are its two refusals.
- `SessionManifest` (`sessionManifestSchema`, `emptySessionManifest`): the
  `manifest.json` of each turn commit.
- `SessionArchiveWriter`: writes each ended turn (`TurnEnd`) as a turn commit.
  `SessionRuntime` calls `turnEnded`; boot calls `resume`. `ThreadFile` is one
  provider file. `loadSettledTurnRows` reads the rows of the ended turn. A turn
  commit of organization work stores no rows: the transcript mirror sends them.
- `SessionPusher`: the host-wide push queue. Boot connects it: a turn commit
  calls `committed`, a running session calls `running`, sign-in and sign-out
  call `established` and `signedOut`, and prompt admission reads `refusedHead`.
- `SessionRemoteAccess` (adapter `DelegatedSessionRemoteAccess`): the two Solus
  API requests of a host, `remote` and `report`. `SessionCloudIdentity` is the
  cloud scope and the acting person that each request names;
  `sessionCloudIdentity(record, accountId)` gives it.
- `SessionBundleTransfers`: the source side of a host-to-host bundle in bounded
  RPC parts.
- On the Solus API: `sessionRemoteProvider()`, which gives the
  `RepositoryProvider` that `SOLUS_SESSION_STORAGE` names and refuses a storage
  scope that differs from the saved rows, and `SessionCloudReader` (`page`,
  `preview`, `diff`), which reads rows and patches at the recorded head. It
  reads rows only from a person's own repository (the `person:` scope). A turn
  diff comes from that repository or from the repository of a published
  organization session.

### Server Git (`packages/server/src/git`)

- `writeTurnCodeBundle` (`TurnCodeState`, `TurnCodeBundle`, `bundleRef`) and
  `writeTurnDiffPatch`: the code state and the diff of a turn. The archive
  writer uses them.
- `restoreSessionCode` (`RestoreSessionCodeInput`, `RestoredSessionCode`,
  `CodeRestoreError`): the checkout of a synced session. `SessionSync` uses it.
- `getSessionPaths`, `snapshotLiveTree`, `writeRestoredSessionSnapshots`, and
  `createRestoredSessionWorktree`: the parts of the snapshot and worktree
  owners that the two functions above need.

### Server execution (`packages/server/src/execution`)

- `SessionSync`: makes one host current for a session (`prepare`, `wait`,
  `stop`, `localHead`). `SessionSyncDeps` is its input; `SessionSyncError` and
  `SessionSyncResult` are its answers.
- `SessionSourceRequest`: what the sync asks a source for. `SessionSource` is
  the seam; `SourceBundle` is the answer. The two adapters are
  `fetchSessionArtifacts` (the cloud copy) and `fetchSessionBundle` (the last
  run host). `chooseSessionRepositorySource` chooses between them.
- `AgentBackend.threadFiles` and `AgentBackend.importThread`
  (`ThreadImportRequest`, `ThreadImportResult`), with one adapter for Claude and
  one for Codex. `importThreadFiles` and `safeThreadPath` are their common part.
- `PromptDispatch.refusedHead` and `assertSessionCurrent`: a host with a
  refused push admits no prompt.
- `sessionCloudSyncDecision` (`SessionCloudSyncDecision`): the one answer to
  "may this session go to the cloud now".
- `portableSessionPathNote`: the first-turn note after the project root changed.

### Server transport (`packages/server/src/transport`)

- `registerSessionRepositoryHandlers`: the three RPC methods.
- `queuePromptAfterSessionSync`: accepts a prompt on a host that is behind and
  sends it after the sync.
- `registerSessionRepositoryRoutes`: `POST /runner/session-repositories/token`
  and `POST /runner/session-repositories/head`.
- Solus API router: `GET /v1/me/sessions` and
  `GET /v1/sessions/:sessionId/turns/:turnIndex/diff`. `loadSessionPage`, the
  preview, and the tool inputs read from `SessionCloudReader` when the
  transcript mirror has no rows. Each session has one source of rows: the
  mirror for an organization session, and the person's own repository for a
  personal session (`portable-sessions-cloud.md`, "One source of rows").

### Client core (`packages/client-core/src`)

- `SessionHostTurn`: what one host holds of one session. `sessionHostTurnOf`
  makes it from session info.
- `SessionHostTurns`: the turns of every host that answered, as one value.
  `of`, `newestTurn`, `with`, `without`, `afterTurnSettled`, `newestHost`,
  `syncSource`, `listedHost`, `syncOrigin`, `newestServer`.
- `SessionHostTurnsBook`: owns the map from session id to `SessionHostTurns`.
  `forSession`, `noteMeta`, `noteTurnSettled`, `notePushRefused`, and
  `forgetHost` update one session entry at a time. The web store gives it a
  `SvelteMap`; mobile gives it a `Map` and sends its own change notice.
- `SessionCloudHead`, `SessionSyncSource`, `SessionSyncOrigin`: the cloud facts
  as a client names them, and where a run host syncs from.
- `sessionCloudState` (`SessionCloudState`), `sessionCloudStateText`,
  `conversationAwaitsMachine`: the cloud state of a session on its run host.
- `sessionCloudReadSource`, `sessionCloudReadView`, `readSessionCloudPage`,
  `readSessionTurnDiff`, with `sessionCloudReadText` and `sessionTurnDiffText`:
  the read-only open from the Solus API.
- `isSessionSyncCard`, `sessionSyncCardView`, `sessionSyncFailureText`,
  `sessionSyncFailureAction`, `sessionSyncStepLabel` (`SessionSyncCardNames`):
  the sync card in the words of a client.
- `onSessionMetaRead`: gives each session info read to the store that keeps
  the host turns.

### Workspace UI (`packages/workspace-ui/src`)

- `CloudSessions` (`cloud-sessions.svelte.ts`): the cloud facts and the
  cloud-only rows. The session list store owns it.
- `SessionListStore`: `hostTurnsFor`, `newestHostFor`, `cloudStateFor`,
  `noteSessionMeta`, `noteTurnSettled`, `notePushRefused`.
- `RunHostChanges`: the change of the run host of a started tab, the prepare,
  and the fields of a prompt.
- `CloudTranscriptStore`: the read-only conversation and the turn diffs.
- Pure view rules: `input/lib/run-host-row.ts`,
  `conversation/lib/session-sync-view.ts`, `conversation/lib/cloud-turn-diff.ts`,
  `turnSnapshotFor`, `isRunOnHostLocked`, `syncRepository`.
- Components: `RunHostRow`, `SessionStatusCard`, `SessionCloudRead`,
  `CloudTurnDiff`, `PushRefusedCard`, `TurnChangesSummary`,
  `SessionCloudSyncSetting`.

### Mobile (`apps/mobile/src/features/threads`)

- `SessionRunHosts`: the host turns of each session, the fields of a prompt,
  and the prepare.
- `CloudSessions`: the cloud facts and the cloud-only sessions.
- `CloudHistory` and `useCloudRead`: the read-only conversation and the turn
  diffs.
- Pure view rules: `lib/run-host-row.ts`, `lib/cloud-read-view.ts`,
  `lib/cloud-turn-diff-view.ts`.
- Components and hooks: `ThreadRunHostRow`, `useRunHostRow`,
  `useRunningHostSend`, `CloudReadNote`, `CloudTurnChanges`,
  `CloudTurnDiffScreen` (route `ThreadTurnDiff`), `SessionPushRefusedCard`.

### Lab (`packages/lab`)

- `projectFixture()` (`ProjectFixture`): one bare origin and a clone for each
  Lab host.
- Scenario `scenarios/cloud/portable-sessions.ts`: two hosts use one cloud
  history.

### Names that changed

| Before | Now |
| --- | --- |
| `SessionRepositories.head(repository)`, `.readText(repository, commit, path)`, and each other method with a repository name | `SessionRepositories.named(repository)` gives a `SessionRepository`; the methods take no name |
| `SessionRepositories.remoteHead` | Removed; it had no caller |
| `SessionSyncDeps.repositoryRoot` | `SessionSyncDeps.repositories` |
| `fetchBundle(sessionId, have, wantedHead, sourceHostId, outFile, signal, actor)`, and the same facts in `fetchSessionBundle` and `fetchSessionArtifacts` | One `SessionSourceRequest`; the function type is `SessionSource` |
| `chooseSessionRepositorySource(cloud, host, wantedHead, signal)` | `chooseSessionRepositorySource(cloud, host, request)` |
| `SessionRemoteAccess.remote(sessionId, cloudScope, actorUserId, access)` and `.report(request, cloudScope, actorUserId)` | `remote(sessionId, identity, access)` and `report(request, identity)` with `SessionCloudIdentity` |
| `sessionCloudScope(record, accountId)` in `session-cloud-scope.ts` | `sessionCloudIdentity(record, accountId)` in `session-cloud-identity.ts` |
| Each inline read of `session_storage` | `readSessionStorage(sessionId)` |
| `sessionRepositoryName(scope, sessionId)` in `data/sessions` | `cloudSessionRepositoryName(scope, sessionId)` |
| `withSessionHostTurn`, `afterTurnSettled`, `newestSessionHost`, `sessionSyncSource`, `listedSessionHost`, `sessionSyncOrigin`, `newestSessionServer` | Methods of `SessionHostTurns`: `with`, `afterTurnSettled`, `newestHost`, `syncSource`, `listedHost`, `syncOrigin`, `newestServer` |
| `CloudSessions.listed(sessionId, isListedByHost)` and `.listedRows(isListedByHost)` (web) | The predicate is a constructor dependency |
| The private `git` runner of `SessionRepository`, and its own `init`, `head`, `readText`, and `appendFiles` | `GitRepository` (`sync/git-storage/git-repository.ts`); `SessionRepository` extends it |
| The commit builder inside `SessionRepository.commit` | `GitRepository.writeCommit` and `setHead`; `commit` keeps the rule that the head must not move |
| `TurnCommitEntry` | `GitFileEntry` |
| `sync/git-remote.ts`; `GitRemote.git(args, input)`; `GitRemoteOptions.authorDate` | `sync/git-storage/git-remote.ts`; `GitRemote.repository.git(args, io)`; `GitCommit.date` |
| `CloudflareWorkRepositories` (`sync/works/cloudflare-work-repositories.ts`) | `ArtifactsRepositoryProvider` (`sync/git-storage/artifacts-repository-provider.ts`) |
| The interface `SessionRemoteProvider`, and the local Git adapter inside `sessionRemoteProvider()` | `RepositoryProvider`, and `LocalGitRepositoryProvider` with the kind `session` |
| The error message `SESSION_FILE_TOO_LARGE` from each adapter | `RepositoryFileTooLargeError`; `SessionCloudReader` gives a client the same code as before |
| The name hash in `sessionRepositoryName` and in `cloudSessionRepositoryName` | Each calls `storageRepositoryName('session', …)`; the names are the same |
