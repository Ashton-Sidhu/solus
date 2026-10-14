# Run location — one owner for where a run works

Status: proposed 2026-10-14. Not started. Solus has no users, so this ships with
no compatibility layer: saved drafts and tab snapshots in the old shape are
dropped on load.

Related: [Project model](project-model.md) (project, checkout, repository key),
[Host model](host-model.md) (one `Host` per host), [Run on](../run-on.md)
(the user-facing destination strip).

## 1. Why

On 2026-10-14 the branch chip disappeared from a new-tab draft aimed at a
remote host (omarchy). The cause:

- The Run on picker found a checkout of the project on omarchy. It recorded a
  pending `open-project` choice and wrote the omarchy path into
  `workingDirectory`. `serverId` still named this Mac.
- Every Git reader pairs `workingDirectory` with `serverId`. It asked this Mac
  for a path that exists only on omarchy, found no repository, and the chip
  hid itself.
- Since `faf8769f7` hosts list their dispatch clones as projects. So the picker
  took this path for omarchy, where before it took the clone path. The defect
  was older; the listing change exposed it.

A stopgap (`opensCheckoutNow` in `components/servers/run-on.ts`) now moves a
draft at once to a host that is online. It does not remove the defect.

The defect is structural. `RunConfig` holds a run's location as seven loose
fields: `serverId`, `taskServerId`, `pendingHostDispatch`, `projectGroupPath`,
`workingDirectory`, `gitContext`, `worktree`. **The host that a path belongs
to depends on other fields**, and no module owns that rule. Each reader works it
out by hand.

## 2. What discovery found (2026-10-14)

Surveys of `packages/workspace-ui/src` and `packages/client-core/src`. The server
and mobile do not touch these fields (§2.4).

### 2.1 Readers

About 430 direct reads; about 200 of them ask a location question. Each question
has more than one answer:

| Question | Distinct expressions | Example disagreement |
|---|---|---|
| Which host will the agent run on? | 2 | `RunOnPicker.svelte:103` is pending-aware; `:121` is not |
| Which host holds the working directory? | 3 | All Git readers use `serverId`; during a pending `open-project` the path is on the pending host |
| Which host owns the project and tasks? | 5 | `projectHostId`, `runGroupKey`, `taskServerId ?? serverId`, `groupKeyFor(run.serverId, …)` |
| What is the project root? | 12 | Some apply `worktreeProjectRoot`, some ignore `gitContext.repoRoot`, some accept `~` |
| What is the working directory? | 4 | About 25 sites use bare `workingDirectory` while a worktree is attached |
| Is a move pending? | 3 | Some test any intent, some only `'dispatch'` |
| Does it start a worktree? | 4 | Raw `!!run.worktree` disagrees with `startsWorktree` for a selected dispatch worktree |

About 25 helpers already answer parts of this: `projectRootOf`, `isDispatch`,
`startsWorktree`, `projectHostId`, `checkoutPathOn` (two different functions
with that name), `runGroupKey`, `environmentProjectKey`, `homeGitDetails`,
`serverIdForRun`, and others. They do not agree either.

### 2.2 Writers

About 25 transition functions and 51 direct field writes. Invariants that
writers break today:

1. **A path is on the host `serverId` names.** Broken by a pending
   `open-project` (`withCheckoutOnHost`), by `rememberLastProject` (saves old
   host + new path), and by `inheritRunConfig` (drops the pending record, keeps
   the path).
2. **`serverId !== taskServerId` means a dispatch.** Accidental dispatch shapes
   come from `resolveNewRunConfig` with only `taskServerId`, resume into an empty
   tab (`session-opening.ts:408`), work feedback (`workspace.context:1774`), and
   `machine-references.ts:92`.
3. **A directory or host change clears `gitContext`.** `withHost` on the same
   host keeps it; `prompt-dispatch.ts:466` changes the path and keeps it.
4. **A pending choice is cleared when a move happens.** The project picker paths
   (`withHost`, `withProjectHost`) leave it in place.
5. **"Dispatches always operate in a worktree"** (the `RunConfig` doc).
   `withDispatchDefaultBranch` sets `worktree = null`.
6. **A Git answer lands on the checkout it describes.** `refreshEnvironment`
   compares only the path, not the host, and writes to a run object it captured
   before an `await`. A replaced run loses the write.
7. **Location is fixed after the session starts.** `ownerFor(sourceId)` resolves
   a started session, so `setBaseDirectory`, `switchToBranch` and
   `setDispatchWorktree` can re-point a started run.
8. On reload, `serverId` is remapped by installation id but `taskServerId` is not.

### 2.3 Reactivity

Writers mix two patterns: replace (`owner.run = next`) and mutate in place
(`session.run.gitContext = x`). A writer that holds the old object across an
`await` loses its write after a replace. A replace also invalidates every
`$derived` that reads any run field, including model and permission fields.

### 2.4 Outside workspace-ui

- **Server.** It never sees `RunConfig`. It receives `SessionRunInput` (no host
  fields) and, for a dispatch only, `SessionExecutionHost {serverId,
  projectRoot}` through `linkSession` (`session-task-link.ts:32`).
- **Mobile.** It has no location model. It starts sessions on a known host and
  folder, with `gitContext: null`.
- **Persistence.** Drafts are saved whole to localStorage
  (`tab-persistence.ts:132`). Tab snapshots use an older flat shape
  (`tab-persistence.ts:36`).

So the change is client-only, in workspace-ui, plus the type in contracts.

## 3. Vocabulary

| Term | Meaning | Replaces |
|---|---|---|
| **place** | A path together with the host it is on: `{ serverId, path }`. A path without its host is not a location. | bare `workingDirectory`, `projectGroupPath` |
| **run host** | The host the agent runs on, or will run on after Send. | `serverId`, `pendingHostDispatch?.serverId ?? serverId` |
| **checkout** | Where the agent works: a **folder** that exists on the run host, or a **clone** that Send makes there. | `workingDirectory` + `gitContext` + `pendingHostDispatch` |
| **project home** | The place where the project lives. Its tasks are filed on that host, and the sidebar groups the session under that folder. | `taskServerId` + `projectGroupPath` |
| **working place** | The place to read files and Git from now. | `gitContext?.worktreePath ?? workingDirectory` on `serverId` |
| **dispatch** | A run whose run host is not its project home host. | unchanged |
| **start** | How the agent begins in its checkout: in it, in an existing worktree, or in a new worktree. | `worktree`, dispatch `worktree` / `baseBranch` |

Do not use "pending dispatch" for opening a folder on another host. After this
change that is not pending: it is a folder checkout on that host (§4.2).

## 4. Design

### 4.1 Options considered

1. **Answers over the current fields, plus a lint rule.** Cheap. Readers agree,
   but writers can still build a path on one host with `serverId` on another.
   The bug class stays.
2. **A `Run` class around `$state`.** Rejected. `RunConfig` is plain data that is
   saved to localStorage and copied between drafts and tabs. A class works
   against per-property reactivity (`workspace-ui/CLAUDE.md`).
3. **Reshape the data so a wrong state cannot be written, behind a module of
   pure answers and commands.** Recommended. Every path travels with its host,
   and each checkout kind owns its own start rules.

### 4.2 The shape

`RunConfig` keeps its other fields and replaces the seven location fields with
one `location` value (`packages/contracts/src/types.ts`):

```ts
interface Place {
  serverId: string
  path: string
}

interface RunLocation {
  checkout: FolderCheckout | CloneCheckout
  /** Where the project lives: its tasks are filed on this host, and the
   *  sidebar groups the session under this folder. */
  project: Place
}

/** A folder that exists on `serverId`. The agent runs on that host. */
interface FolderCheckout {
  kind: 'folder'
  serverId: string
  path: string
  /** What Git last said about `path`. Null until it answers. */
  git: GitCheckout | null
  /** Branch into a new worktree on start. Null works in the folder itself.
   *  `baseBranch` is null until the host names a branch to fork from. */
  newWorktree: { baseBranch: string | null } | null
}

/** A copy of the project that Send makes on `serverId`. Nothing exists there
 *  yet, so nothing on that host can be read before Send. */
interface CloneCheckout {
  kind: 'clone'
  serverId: string
  repoKey: string
  start:
    | { kind: 'default-branch' }
    | { kind: 'worktree'; path: string; branch: string }
    | { kind: 'new-worktree'; baseBranch: string | null }
}
```

What this removes:

- **The pending `open-project` choice.** Opening a folder on any host writes a
  folder checkout on that host. Whether Send must connect to the host first, or
  start a stopped Cloud host, is read from the host at Send. It is not stored in
  the run. The bug in §1 cannot be written.
- **`taskServerId` and `projectGroupPath` as two loose fields.** They are one
  place. "Dispatch" is `checkout.serverId !== project.serverId`, and a dispatch
  cannot exist without a project home.
- **Two worktree concepts.** A folder has `newWorktree`; a clone has `start`.
  "Not branching, from `main`" and "dispatch in no worktree with a selected
  worktree" cannot be written.

### 4.3 The module

`packages/workspace-ui/src/contexts/workspace/run-location.ts`. Pure functions
on `RunLocation`. No stores, no host API, no `$state`.

**Answers**

| Function | Returns |
|---|---|
| `runHost(location)` | `checkout.serverId` |
| `projectHome(location)` | `Place \| null`: null for the `~` placeholder |
| `projectRoot(location)` | The one project root string. Replaces the 12 forms in §2.1. |
| `workingPlace(location)` | `Place \| null`. Folder: `git?.worktreePath ?? path` on its host. Clone: the project home, because the clone does not exist until Send and the branch list reads from the checkout it copies. |
| `isDispatch(location)` | `checkout.serverId !== project.serverId` |
| `startsWorktree(location)` | Folder: `!!newWorktree`. Clone: `start.kind === 'new-worktree'`. |

**Commands.** Each returns a new `RunLocation` and keeps every invariant.

| Function | Replaces |
|---|---|
| `openFolder(location, place)` | `withCheckout`, `withHost`, `withProjectHost`, `withCheckoutOnHost`, `withPendingHost` (open-project), `moveToRunOnHost`, `setBaseDirectory`, the project picker paths |
| `dispatchTo(location, serverId, repoKey)` | `withRemoteDispatch`, `withPendingHost` (dispatch) |
| `chooseStart(location, choice)` | `switchToBranch`, `withSelectedWorktree`, `withWorktreeToggled`, `withDispatchWorktree`, `withDispatchBaseBranch`, `withDispatchDefaultBranch`. `choice` is a union: the checkout's branch, an existing worktree, or a new worktree from a base branch. |
| `adoptGit(location, place, git)` | The writes in `refreshEnvironment` and the `git_context` event. Returns `location` unchanged when `place` is no longer the working place, host included. |
| `landClone(location, path)` | `moveTabToHost` at Send: the clone becomes a folder checkout on the run host. The project home stays. |

`inheritRunConfig` and `resolveNewRunConfig` keep their names and build a
`location` through these commands, so they cannot build a dispatch by accident.

### 4.4 Rules for callers

1. **Read through answers.** No reader reaches into `location.checkout` or
   `location.project`. A lint rule enforces this (§6).
2. **One write per change: `owner.run.location = next`.** That invalidates only
   the derivations that read the location, not the model or permission fields.
3. **An async writer reads the owner again when it writes.** It passes the place
   it read to `adoptGit`, which drops a stale answer.
4. **Location commands stop at the first send.** Only `adoptGit` and
   `landClone` run on a started session. `ownerFor` refuses a started session
   for every other command.
5. **API routing follows the answers.** `apiForRun` uses `runHost` and the
   environment store reads `workingPlace`, so Git, plugin commands and
   attachments always ask the host that holds the folder.

## 5. Migration

Phase 1 changes readers only. Phase 2 changes the data. Each phase is one PR.

**Phase 1: answers over the current fields.**

1. Add `run-location.ts` with the six answers, written against today's
   `RunConfig`. `workingPlace` honours a pending `open-project`.
2. Move the about 200 location reads to the answers, file by file, starting with
   the Git readers in §2.1. This fixes the reader disagreements on its own.
3. Delete the helpers the answers replace: `projectRootOf`, `projectHostId`,
   `runGroupKey`'s host choice, `homeGitDetails`'s root, `isDispatch`,
   `startsWorktree` in `run-config.ts`.

**Phase 2: the new shape.**

1. Replace the seven fields with `location` in contracts. Let the compiler list
   every writer and every remaining reader.
2. Add the five commands. Move the 25 transition functions and 51 direct writes
   onto them (§2.2 lists them).
3. Send: remove the `open-project` branch from `prepareHostDispatchAndSend`.
   Before any send, ensure a connection to `runHost`, and start a stopped Cloud
   host. A clone runs `prepareHostCheckout`, then `landClone`.
4. Persistence: drafts and tab snapshots store `location`. Drop any saved entry
   in the old shape. Remap `checkout.serverId` and `project.serverId` by
   installation id on restore (fixes §2.2 item 8).
5. Delete `opensCheckoutNow`, `withCheckoutOnHost`, `moveTabToHost`'s field
   writes, and the `with*` location functions in `run-config.ts`.
6. `session-task-link.ts` builds `SessionExecutionHost` from `runHost` and
   `projectHome`. The wire contract does not change.

## 6. Enforcement

- After phase 2 the compiler rejects every use of the removed fields.
- Add `solus/run-location-answers`, modelled on `explicit-host-choice.ts`: a
  `MemberExpression` visitor that reports `.checkout` or `.project` on a
  `location` object outside `run-location.ts`.
- Check that oxlint reads the `<script>` block of `.svelte` files before
  relying on the rule. Many readers are components.

## 7. Tests

`tests/unit/run-location.test.ts`, through the module's interface only:

- Opening a folder on another host makes that host the run host and the working
  place host. (The §1 bug.)
- A clone's working place is its project home until `landClone`.
- `chooseStart` on a clone never produces a folder start, and the reverse.
- `adoptGit` drops an answer for the same path on a different host.
- `inheritRunConfig` and `resolveNewRunConfig` never produce a dispatch unless
  the source was one.
- Restore drops an old-shape draft and remaps both host ids.

Plus one Send test in `tests/unit/prompt-dispatch*`: a draft on a host that is
not connected connects before the prompt goes out.

## 8. Open questions

1. **Offline hosts.** With no pending choice, a draft can point at a folder on a
   host that is offline. The branch chip then has nothing to read. Proposed: the
   chip shows the host as unreachable, with the same state the draft pane uses
   for a host that is not online (`draft-connect-host.md`). Send connects or
   fails with the usual card.
2. **Started-session edits.** §4.4 rule 4 removes the ability to re-point a
   started run through `setBaseDirectory`, `switchToBranch` and
   `switchToWorktree`. `continueInWorktree` stays the only way to move a
   started session. Check that no surface depends on the old behaviour.
3. **The dispatch default.** The `RunConfig` doc says dispatches always use a
   worktree; `withDispatchDefaultBranch` works in the clone's checkout. The
   `start` union allows both. Decide which one is the default and fix the doc.
