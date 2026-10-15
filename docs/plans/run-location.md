# Run location — one owner for where a run works

Status: implemented 2026-10-14 on `solus/run-location`, as one change (§9).
Solus has no users, so this shipped with no compatibility layer: saved drafts
and tab snapshots in the old shape are dropped on load.

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
  /** The default branch of the checkout it copies, when Git named one. */
  defaultBranch: string | null
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

`packages/workspace-ui/src/contexts/workspace/run-location.ts`. Pure functions.
No stores, no host API, no `$state`.

**Answers** take a run (anything with a `location`), so a reader writes
`runHost(session.run)`. The ones a reader often calls with no run also accept
`null` and `undefined`.

| Function | Returns |
|---|---|
| `runHost(run)` | `checkout.serverId`: where the agent runs, or will run after Send |
| `projectHome(run)` | The project's `Place`; its path is `~` while not known |
| `projectRoot(run)` | `projectHome(run).path`, or null for `~` |
| `checkoutPlace(run)` | The folder the run was pointed at, before any worktree in it. A clone: its project home. |
| `workingPlace(run)` | Where to read files and Git now: `git.worktreePath ?? path` on the folder's host. A clone: its project home, because the clone does not exist until Send and the branch list reads from the checkout it copies. |
| `checkoutGit(run)` | The folder's last Git answer; null for a clone |
| `pendingClone(run)` | The clone Send will make, or null |
| `cloneBaseBranch(run)` | The origin branch a clone works from |
| `isDispatch(run)` | `checkout.serverId !== project.serverId` |
| `startsWorktree(run)` | Folder: `!!newWorktree`. Clone: `start.kind === 'new-worktree'`. |
| `worktreeBaseBranch(run)` | The base branch of the requested new worktree |
| `samePlace(a, b)` | Same host and same path |

**Building and changing a location.** Each returns a new `RunLocation` and
keeps every invariant.

| Function | Replaces |
|---|---|
| `folderLocation(place, opts)` | The literal location fields in defaults, factories, restore, and PR checkouts |
| `openFolder(location, place, opts)` | `withCheckout`, `withHost`, `withProjectHost`, `withCheckoutOnHost`, `withPendingHost` (open-project), `moveToRunOnHost`, `setBaseDirectory`, the project picker paths, and the stopgap `opensCheckoutNow`. `keepProject` keeps a dispatch's project home. |
| `dispatchTo(location, serverId, repoKey)` | `withRemoteDispatch`, `withPendingHost` (dispatch) |
| `chooseStart(location, choice)` | `switchToBranch`, `withSelectedWorktree`, `withWorktreeToggled`, `withDispatchWorktree`, `withDispatchBaseBranch`, `withDispatchDefaultBranch`, and the direct `run.worktree` writes |
| `adoptGit(location, place, git, newWorktree?)` | The writes in `refreshEnvironment`, the `git_context` event, and resume. Returns `location` unchanged when `place` is no longer the working place, host included. |
| `landClone(location, path)` | The field writes of `moveTabToHost` at Send |
| `inheritedLocation(location, { freshTask })` | The location half of `inheritRunConfig` and `resolveNewRunConfig` |
| `fileTasksOn(location, serverId)` | The direct `taskServerId` writes for a task in the workspace service |
| `remapHosts(location, remap)` | The restore remap, now of both hosts |

### 4.4 Rules for callers

1. **Read through answers.** No reader reaches into `location.checkout` or
   `location.project`. A lint rule enforces this (§6).
2. **One write per change: `owner.run.location = next`.** That invalidates only
   the derivations that read the location, not the model or permission fields.
   A draft moves with `draft.moveTo(next)` instead (§10).
3. **An async writer reads the owner again when it writes.** It passes the place
   it read to `adoptGit`, which drops a stale answer.
4. **Location commands stop at the first send.** Not done: see §9.
5. **API routing follows the answers.** `apiForRun` uses `runHost` and the
   environment store reads `workingPlace`, so Git, plugin commands and
   attachments always ask the host that holds the folder.

## 5. Migration

Done as one change, not the two PRs first planned. Removing the seven fields
made the compiler list every reader and writer, which was the reliable way to
find them; doing the readers first would have touched each of them twice.

- Readers: about 260 reads were rewritten to the answers by a script, and the
  rest by hand. Every Git reader now asks the host that holds the folder.
- Writers: the transition functions and direct writes in §2.2 now call the
  commands. A write is one assignment, `owner.run.location = next`.
- Send (`prompt-dispatch.ts`): the `open-project` branch is gone. Send prepares
  the run's host when the run is a clone, or when a run that has not started
  names a remote host that is not online: it starts a stopped Cloud host,
  connects, and for a clone makes it and calls `landClone`.
- Persistence: tab snapshots (version 3) and session drafts (version 2) store
  `location`. Older ones are dropped. Restore remaps both hosts by
  installation id (fixes §2.2 item 8).
- `environmentProjectKey(env, run)` and `environmentBranchKey(env, run)` take
  the run; `runGroupKey(run, key)` uses `projectHome(run).serverId`.

## 6. Enforcement

- The compiler rejects every use of the removed fields.
- `solus/run-location-answers` (`tools/oxlint/solus/rules/run-location-answers.ts`)
  reports `.location.checkout` and `.location.project` outside
  `run-location.ts`, in `.ts` and `.svelte` files of workspace-ui and both
  client shells.

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

## 8. Decisions on the open questions

1. **Offline hosts.** A run can name a folder on a host that is offline. The
   branch chip then finds no checkout and stays hidden, as for any folder Git
   has not answered for; Send connects or fails with the usual card. No new
   "unreachable" chip state was added.
2. **Started-session edits.** Not changed. `setBaseDirectory`, `switchToBranch`
   and `switchToWorktree` still re-point a started run when a source names it
   on purpose, and reset its provider thread as before (§4.4 rule 4).
3. **The dispatch default.** Unchanged: a clone works on the default branch in
   the target's checkout unless a worktree is asked for. The `RunConfig`
   comment that said dispatches always use a worktree was removed with the
   field.

## 9. What differs from this plan

- One change instead of two PRs (§5).
- Answers take a run, not a `RunLocation`, and the module grew the answers and
  builders in §4.3 that the call sites needed.
- `CloneCheckout` carries `defaultBranch`, the branch the checkout it copies
  names, so a clone's chip can name it before Send.
- §4.4 rule 4 is not enforced (§8.2).

## 10. A draft owns its location (2026-10-15)

### 10.1 Why

A draft's run was public, mutable state. About twenty writers, in stores and
components, wrote `draft.run.location = next`, and some replaced the whole run
with `draft.run = next`. No owner saw a move, so an `$effect` in
`draft-preflight.svelte.ts` watched the run and asked the host for the draft's
checkout (`refreshStartTarget`) when it had none. The answer landed as a new
location object, which woke the effect again. In a folder outside Git the
answer is always `null`, so it never settled, and the plugin-command read in
the same file followed every pass. Some writers (`setBaseDirectory`,
`createWorktreeTab`) also asked for the checkout themselves, so a move could
read it twice.

### 10.2 The shape

- `SessionDraft` keeps its run private. `draft.run` is a getter whose
  `location` is `readonly`, so the compiler rejects `draft.run.location = …`
  and `draft.run = …`. The other fields (model, permission mode, provider,
  skills) are still edited in place, which is cheap and owns no side effect.
- `draft.moveTo(next)` is the one way a draft's location changes. It calls the
  owner's `onMove` hook when the location object changes.
- `draft.applyRun(next)` takes a whole `RunConfig` from a picker (`onRun`): it
  copies the fields in place and moves through `moveTo`.
- `SessionDrafts` passes `onMove` to every draft it makes and owns the read:
  `readStartTarget(draft)` asks for the checkout when the draft names a folder
  (not a clone, not `~`) whose Git the run does not know, once per place and
  worktree choice. The last key per draft is kept, so moving away and back
  reads again, and a Git answer — which keeps the place — reads nothing.
- A restored draft reads when it is restored. A host that connects re-reads
  the drafts on it that still have no Git, because a read while it was away
  failed.
- Generic code that holds only a source id or a run (the environment store
  landing a Git answer, the gone-machine pass) moves a run through
  `workspace.moveRun(sourceId, next)`: a draft moves itself, a tab's session
  takes the location as before.

### 10.3 What is deleted

- The start-target `$effect` in `draft-preflight.svelte.ts`.
- The draft-only explicit reads in `setBaseDirectory` and `createWorktreeTab`;
  they now wait for the read the move started.
- `Object.assign(draft, { id })` in restore; the id is a constructor option.

### 10.4 Out of scope

Unstarted tabs keep writing `session.run.location` directly. Their reads are
explicit at each command, and no effect watches them.
