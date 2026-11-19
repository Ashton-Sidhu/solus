# Portable sessions

Status: phase 1 implemented, 2026-11-18, on branch `solus/portable-sessions` (§17). Phase 0 ran on 2026-11-18 (§18): the two provider tests passed. Phase 2 is in progress (§19).

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
    adapters. Rows let a reader with no provider process show the turn.
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
  rows/<n>.jsonl                      the rows of turn n
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
