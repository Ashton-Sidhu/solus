# Codebases — one session, several folders, several hosts

Status: built. Stages 1 to 8 are in the code. The person's guide is
[Codebases](../codebases.md). Owner of the decisions: maintainers (agreed
23 November 2026). §14 lists each place where the code differs from the first
plan.

Reference: T3 Code pull request 35925 ("a project covers several
repositories"). This plan gives the same capability, but the record is not a
list of paths on one machine.

Solus has no users. This plan makes clean cuts: it keeps no old field, no old
event shape, and no data migration for a shape that it replaces.

## 1. Why

A session works in one checkout today. Work that covers several repositories
(`api` and `web` in one folder, a repository and the library it depends on, a
service on a laptop and its infrastructure on a server) needs one session for
each repository, and nothing shows that the sessions are one piece of work.

Three things must become true:

1. One session can read, change, review, commit, and isolate several folders
   on its host.
2. The agent knows which folders of the work are on a different host, and it
   starts a session there to change them.
3. A person does not keep a list by hand. Repositories inside a folder are
   found on the disk. A folder that the agent needs in the middle of a session
   is attached automatically. A codebase forms by itself: a person does no
   step before a session can work in more than one folder (decision 13).

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **codebase** | A named set of folders, on one or more hosts, that one piece of work covers. |
| **root** | A folder that a person or the host put in a codebase: an installation id and an absolute path on that host. |
| **member** | A folder that a codebase covers on one host: each root, and each repository found inside a root. A host reads its members from the disk. They are not stored. |
| **member state** | `git` (the folder has its own `.git`), `plain` (a folder with no repository), or `missing`. |
| **session folder** | A folder that one session works in besides its working directory. It comes from the session's codebase, or it is attached. |
| **attach** | To add a session folder to a running session. |
| **task folder** | The folder that a worktree session of several repositories works in: one directory that holds a worktree of each chosen repository at the same relative places as the originals. |
| **project folder** | The member that a session works in: the root of the repository of its working directory, else the working directory. For a session in a worktree, the original folder, never the worktree (`projectFolderOf`). |
| **project** | Unchanged: one folder on a host (`docs/plans/project-model.md`). A codebase does not replace it. |

Do not use "tracked folder", "workspace folder", "multi-repo project", or
"additional directory" in new code or in text that a person reads. The provider
option `additionalDirectories` keeps its name only at the adapter boundary.

## 3. Decisions

1. **Two primitives.** A store of codebases, and the list of folders that the
   server gives the provider at each turn start. All other behavior comes from
   these two.
2. **A root names its host.** `CodebaseRoot.installationId` is the installation
   id of the host (`getInstallationId()`, `packages/server/src/admission/auth.ts`).
   It is the only host id that all clients and all servers share. A client maps
   it with `serverConnections.resolveId`. The desktop writes its own host as its
   installation id, never as `local`.
3. **Work stays on the host of the member.** A session changes only the members
   on its run host. To change a member on a different host, the agent starts a
   session there with `start_sessions`. No tool moves work to a different host,
   and no tool clones a member to the run host by itself. A clone on a new host
   happens only when a person chooses Run on, as today.
4. **Members are read from the disk.** The record holds roots only. A repository
   that is cloned inside a root is a member on the next read.
5. **One folder can be in several codebases.** A session records the codebase
   id that it started with, and keeps it. A session that started with none
   takes the first codebase that a later turn names. A child session inherits
   it.

   Changed in the code: the first plan gave a session only the codebase that
   it started with. The second sentence was added so that a codebase that a
   person chooses for a running session applies to that session. Decision 13
   adds the codebase that the host gives a session. A session whose codebase
   a person deleted is a session with no codebase.
6. **Each host keeps the full record.** A codebase is a row in each host's
   database. The account plane is not used: its routes are in a different
   repository, and a host cannot read the account when nobody is signed in.
   Records move between hosts in two ways: a client sends the newest copy to
   each connected host that has an older one, and `start_sessions` sends the
   record with a session that it starts on a different host. The newest
   `updatedAt` wins. A delete is a tombstone (`deletedAt`), so it also moves.
7. **The server owns the folders of a session.** The client does not send
   paths. `Session.additionalDirs`, `SessionCtx.additionalDirs`, and the
   `addDirectory` / `removeDirectory` commands are deleted.
8. **Attach follows the permission mode.**

   | Mode | Attach a folder that is not a member |
   |---|---|
   | `full-access` | No card |
   | `auto` | No card |
   | `supervised` | Card |
   | `accept-edits` | Card |
   | `plan` | Card |

   A member of the session's codebase needs no card in any mode. One card is
   for one folder in one session. After the answer, edits there follow the
   mode. The card has three choices: allow for this session, allow and add to
   the codebase, refuse. A run with nobody present uses `full-access`
   (`docs/plans/permission-modes.md`), so it gets no card.

   Changed in the code: the choice "allow and add to the codebase" shows only
   when the session has a codebase. In a task folder session, an attach of a
   repository of the codebase gives the worktree of that repository, and
   makes one when there is none, so the session does not reach the shared
   checkout (§7).
9. **Parity with the T3 Code feature.** Discovery, opt out, the task folder,
   the layout commands, add a repository to a running session, one branch name
   in all repositories, review and Git actions for each repository.
10. **A folder with no Git is a member.** It is granted and listed. It has no
    diff. Its row has a "Track with Git" action (`initRepository`). There is no
    snapshot system for folders with no repository.
11. **New projects join the codebase.** `create_project` and `clone_project`
    add the new folder to the session's codebase unless the caller opts out,
    and they attach it to the session immediately.
12. **A session with no codebase has one working directory.** It can still
    get attached folders. Decision 13 says which sessions stay with no
    codebase.
13. **A codebase forms by itself.** The rule is on the host
    (`execution/sessions/session-codebase-formation.ts`, called by
    `SessionFolders`), so each client, a session that an agent starts, and an
    automation get it. At each turn start, for a session with no codebase, in
    this order:

    1. **Take the one that exists.** Exactly one live codebase holds the
       project folder on this host (`codebasesOfFolder`): the session takes
       it. More than one: the session takes none, and nothing is formed.
    2. **Form one from the folder.** No codebase holds the project folder,
       and discovery finds one or more repositories inside it
       (`repositoriesInside`): a codebase with one root, the project folder,
       is made, and the session takes it.
    3. In each other case the session stays with no codebase.

    When a folder is attached to a session with no codebase:

    4. **Form one from the two folders.** After an attach with the source
       `attached` or `created` (the tool, the prompt trigger, a permission
       answer, a person's RPC, a project tool), a codebase whose roots are
       the project folder and the attached folder is made. For the source
       `observed`, only when the folder is in a project that the host lists
       (`listProjects`). A session that has a codebase gets no new root from
       an attach.

    The rules that apply to each of them:

    - **Name.** The base name of the project folder. When a live codebase in
      the record scope of the person has that name, a number is added:
      `shop 2`, `shop 3`.
    - **One at a time.** The formation for one project folder is serialized
      (`runOneAtATime`), and it reads the codebases again inside the lock.
      Two sessions that start in one folder at the same moment give one
      codebase.
    - **A person's "no" is kept.** A deleted codebase is a tombstone that
      keeps its roots. A tombstone that has the project folder as a root
      stops rules 2 and 4 for that folder. Rule 1 does not read tombstones.
      "No codebase" on a draft is `SessionCtx.noCodebase`: no rule gives that
      session a codebase. The host keeps it in memory for the session, and
      the client sends it with each turn.
    - **No rule** for a chat (`isChat`) and for a guest. **No formation** for
      the home directory, the root of the file system, and the projects root
      of the host or of a member (`isOutsideProjects`). The codebase is made
      in the organization of the acting person (`organizationForNew`) with
      that person as its creator, as `codebaseSave` does.
    - **Before the plan of a worktree.** The launcher calls
      `SessionFolders.settleCodebase` before `SessionTaskFolders.plan`, so
      the first worktree session of a folder gets its task folder.
    - **Before the first turn.** The prompt trigger attaches before the
      launch. The choice of the person is not known then, so the turn start
      reads the folders that were attached before it.
    - **The event.** `session_codebase` (§4) tells the clients. A session
      that takes or forms a codebase at a turn start gets the `<codebase>`
      block in that turn.
    - **The divider.** A formation (rules 2 and 4) is also one activity of
      the session, `codebase_formed`, which the host stores as it stores a
      move into a worktree (`recordActivity`). The conversation shows it as a
      divider at the point where the codebase formed. A session that takes a
      codebase that exists (rule 1, or the codebase that a turn names) gets
      no divider.

Solus has no file rewind today (`session-code-restore.ts` only rebuilds a
checkout on a different host). This plan adds none.

## 4. Contracts

New file `packages/contracts/src/codebases.ts`. All later stages build on
these names. `CodebaseRoot`, `Codebase`, `CodebaseListOptions`,
`SessionFolderSource`, and `SessionAttachedFolder` cross the RPC boundary as
input, so the file declares them as Zod schemas (`codebaseRootSchema`,
`codebaseSchema`, `codebaseListOptionsSchema`, `sessionFolderSourceSchema`,
`sessionAttachedFolderSchema`) and infers the types. A schema checks the
shape and the length of each string. The store checks the rules of a codebase
(§5).

```ts
export const CODEBASE_ROOTS_MAX = 128
/** A new worktree session isolates every repository only up to this many. */
export const CODEBASE_WORKTREE_DEFAULT_MAX = 8

export interface CodebaseRoot {
  /** The host the folder is on (decision 2). */
  installationId: string
  /** Absolute on that host. Never `~`. */
  path: string
  name: string
}

export interface Codebase {
  id: string
  name: string
  roots: CodebaseRoot[]
  /** Epoch milliseconds of the last change. The newest copy wins. */
  updatedAt: number
  /** Set on a deleted codebase. The row stays so that the delete moves. */
  deletedAt: number | null
}

/** Also answer the tombstones: a client needs them to send a delete to a host that has an older copy. */
export interface CodebaseListOptions { includeDeleted?: boolean }

export type CodebaseMemberState = 'git' | 'plain' | 'missing'

/** One folder a codebase covers on the answering host. Read from the disk. */
export interface CodebaseMember {
  path: string
  name: string
  state: CodebaseMemberState
  /** `repositoryKeyFromRemoteUrl(origin)`, or null. */
  repositoryKey: string | null
  /** The root this member is, or was found in. */
  rootPath: string
  /** Found inside a root, not a root itself. */
  discovered: boolean
  /** False for a repository with no commit: it cannot get a worktree. */
  hasCommit: boolean
  /** A submodule follows its parent repository: it never gets its own worktree. */
  submodule: boolean
}

/** A folder outside the scanned one that a `.code-workspace` file in it lists. */
export interface CodebaseFolderSuggestion { path: string; name: string }

/** What one folder holds, for the editor of a codebase. */
export interface CodebaseFolderScan {
  /** The resolved absolute path. */
  path: string
  state: CodebaseMemberState
  members: CodebaseMember[]
  /** Folders outside `path` that a `.code-workspace` file in it lists. Never added by themselves. */
  suggestions: CodebaseFolderSuggestion[]
}

export type SessionFolderSource = 'codebase' | 'attached' | 'created' | 'observed'

/** One folder that a session record keeps besides its working directory (`session_records.attached_folders`). */
export interface SessionAttachedFolder { path: string; source: SessionFolderSource }

/** One folder a session works in besides its working directory. */
export interface SessionFolder {
  /** Where the session works: the member itself, or its worktree. */
  path: string
  name: string
  state: 'git' | 'plain'
  /** The folder `path` is a checkout of. Equal to `path` when it is not a worktree. */
  repositoryPath: string
  source: SessionFolderSource
  /** False for `observed`: the provider was not granted the folder, Solus only shows it. */
  granted: boolean
}

export const TASK_FOLDER_ROOT_NAME = 'solus-task-folders'

export interface TaskFolderRepository { repositoryPath: string; worktreePath: string; name: string }

export interface TaskFolder {
  root: string
  /** The folder `root` stands in for: a path below it is at the same place below `root`. */
  anchor: string
  /** The session's working directory inside `root`. */
  primaryPath: string
  /** The member that `primaryPath` stands in for. */
  primaryRepositoryPath: string
  /** False when the primary member is a plain folder: `primaryPath` then holds links to its entries. */
  primaryIsWorktree: boolean
  branch: string
  repositories: TaskFolderRepository[]
}
```

Path helpers in the same file, pure, for the server and every client:
`isTaskFolderPath(path)` and `taskFolderRootOf(path)`. They follow the rule of
`isChat` (`contracts/src/chat.ts`): the folder name is the mark.

**RPC methods** (`rpc.ts`, `rpc-planes.ts`, `permissions.ts`, `host-api.ts`,
handlers in `transport/handlers/codebase-handlers.ts`). The record of a
codebase is on the collaboration plane. Each method that reads a disk or a
session is on the execution plane. The handlers are registered only on a
host (`boot-server.ts`), not on the Solus API service: each host keeps the
record (decision 6).

| Method | Stage | Plane | Permission | Answer |
|---|---|---|---|---|
| `codebaseList(options?: CodebaseListOptions)` | 1 | collaboration | `host.use` | `Codebase[]` |
| `codebaseSave(codebase: Codebase)` | 1 | collaboration | `host.use` | The copy the host keeps (the newer of the two). A delete is a save of the tombstone |
| `codebaseMembers(id: string)` | 1 | execution | `host.use` | `CodebaseMember[]` on this host. An error when the host has no copy, or a deleted one |
| `codebaseScanFolder(path: string)` | 1 | execution | `host.files.read`, and the path is in the scope of the caller (`assertPathInScope`) | `CodebaseFolderScan` |
| `sessionFolders(sessionId)` | 2 | execution | `drive.prompt` on the session | `SessionFolder[]` |
| `sessionAttachFolder(sessionId, path)` | 2 | execution | `drive.prompt` on the session | `SessionFolder[]` (a person attaches: no card) |
| `sessionDetachFolder(sessionId, path)` | 2 | execution | `drive.prompt` on the session | `SessionFolder[]`. Refused for a folder that comes from the codebase |
| `taskFolderOf(path)` | 3 | execution | `host.files.read`, and the path is in the scope of the caller | `TaskFolder \| null`. `path` is the task folder or a path in it |
| `sessionAddRepositoryWorktree(sessionId, repositoryPath)` | 3 | execution | `drive.prompt` on the session | `SessionFolder[]`. It accepts only a path that `sessionWorktreeCandidates` answers. Refused for a session that is not in a task folder |
| `sessionWorktreeCandidates(sessionId)` | 3 | execution | `drive.prompt` on the session | `CodebaseMember[]`: the `git` members on this host that have no worktree in the task folder of the session and can get one. Empty for a session that is not in a task folder |

There is no `codebaseDelete`. A client makes the tombstone one time and
saves it on each host, so each host has the same `updatedAt`. A guest does
not hold `host.use`, so a guest reads and changes no codebase.

**Events.** Host event `codebases.changed` (`host-events.ts`), sent after a
save or a delete. Session events (`types.ts`):

```ts
| { type: 'session_folders'; folders: SessionFolder[] }
| { type: 'session_codebase'; codebaseId: string; name: string }
| { type: 'git_context'; cwd: string; gitContext: GitCheckout }   // `cwd` is new
```

`session_codebase` is sent when a rule of decision 13 gives a session a
codebase. It is the state of the run only: the run of each client names the
codebase from then on. A client that starts to watch the session gets
`session_folders`, and then the event again (`SessionFolders.replayTo`). The
replay reads the record of the codebase first, and sends no event for a
codebase that is deleted.

**The activity of a formation** (`activity.ts`):

```ts
| { kind: 'codebase_formed'; codebaseId: string; name: string; folders: string[] }
```

When a rule made the codebase, `SessionFolders.takeCodebase` records this
activity with `SessionRuntime.recordActivity` (`formationActivity` in
`session-codebase-formation.ts`). `folders` are the names of the roots at
that time, the project folder first, so the line reads the same after a
person changes or deletes the codebase. The author is the actor of the turn
or of the attach, who is also the creator of the codebase. The activity is a row
of the `activity` table and of the mirror, and a history read merges it by
its time (`mergeSessionActivity`). Thus a reload, a client that opens the
session later, and a second client show the divider at the same place. The
replay to a client that joins writes no second activity.

`git_status` already has `cwd`.

**Run location** (`types.ts`). `RunLocation` gets `codebaseId: string | null`.
`FolderCheckout.newWorktree` becomes
`{ baseBranch: string | null; repositories: string[] | null } | null`, where
`repositories` are member paths and null means the default (decision in §7).
`run-location.ts` gets the answers `codebaseOf(run)` and
`worktreeRepositories(run)` and the commands `chooseCodebase(location, id)`,
`chooseWorktreeRepositories(location, paths)`, and
`workInStandIn(location, standInPath)` (§9). `openFolder` gets the option
`keepCodebase`. The codebase follows the project home of the run: the module
comment of `run-location.ts` has the rule. `SessionCtx` gets `codebaseId`
and `worktreeRepositories` in place of `additionalDirs`. For "No codebase"
(decision 13), `RunLocation` and `SessionCtx` get `noCodebase?: true`,
`SessionRunInput` gets `noCodebase`, and `run-location.ts` gets the answer
`refusesCodebase(run)` and the command `refuseCodebase(location, refuses)`.
`chooseCodebase` with an id takes the refusal away.

**Other fields that the stages added** (`types.ts` unless a file is named):
`SessionRunInput.codebaseId` and `SessionRunInput.worktreeRepositories` (the
launcher reads them), `Session.sessionFolders`, `SessionRecord.codebaseId`
and `SessionRecord.attachedFolders`, `SessionMeta.codebaseId`,
`HeadlessSessionRequest.codebase` (the record that a session started from a
different host brings), `CreateSessionOrder.codebaseId`
(`orchestration/session-orders.ts`), `ProjectConfig.ignoreRepositories` and
`ProjectConfig.worktreeLayout`, `sessionProjectRoot(session)`,
`isEncodedSolusWorktreeFolder(encodedPath)`, and
`TaskSessionLink.projectRoot` (`task-types.ts`).

**Diff.** `DiffRequest` and `DiffFileContentsRequest` get
`repositoryPath?: string`; `listTurnSnapshots(ctx, repositoryPath?)`.
`SessionChangeSummary` keeps its totals and gets `repositories`, present only
when more than one repository changed (`session-digest.ts`):

```ts
interface ChangeCounts { filesChanged: number; additions: number; deletions: number }
interface SessionChangeTotals extends ChangeCounts { files: ChangedFileStat[] }
interface ChangedRepository { repositoryPath: string; name: string }
type SessionRepositoryChanges = ChangedRepository & SessionChangeTotals
interface SessionChangeSummary extends SessionChangeTotals { repositories?: SessionRepositoryChanges[] }
interface DigestTurnChanges extends ChangeCounts { repositories?: (ChangedRepository & ChangeCounts)[] }
```

## 5. Stage 1 — the store and discovery

**Table** `codebases` (`packages/server/src/data/codebases/schema.ts`, model:
`workspace_projects` in `packages/server/src/projects/schema.ts`): `id`,
`organization_id` (not null, default `local`), `created_by`, `name`,
`roots` (JSON), `updated_at`, `deleted_at`. One numbered migration for SQLite
(`0008_codebases.sql`) and one for Postgres (`0006_codebases.sql`), made with
`bun run db:generate --name codebases` (`docs/database-schema.md`). The same
migration adds the two columns of `session_records`.

**Store** `data/codebases/codebases.ts`: `listCodebases(scope, options)`,
`getCodebase(scope, codebaseId)` (deleted or not; null when the host has no
copy), `saveCodebase(organizationId, createdBy, codebase)` (keeps the
incoming copy only when its `updatedAt` is newer; validates: name not empty,
at most `CODEBASE_ROOTS_MAX` roots, each path absolute, no root twice),
`codebasesOfFolder(scope, installationId, path)`, and a change listener
(`onCodebasesChanged`). The store has no delete: a client saves the
tombstone, so each host gets the same `updatedAt`. Reads use
`scopeClause(recordScopeOf(principal))`; a write names
`organizationForNew(principal)`.

- A save never changes the copy that it stores. Two hosts that have the same
  `updatedAt` have the same record.
- The rules of a codebase are checked in the store, not in the schema. An
  absolute path can be a POSIX path or a Windows path, because a record holds
  roots of other hosts.
- The id of a codebase names one row, and its organization never changes. A
  save that names a different organization than the row has is refused.
- `created_by` applies only when the save makes the row.

**Discovery** `packages/server/src/files/codebase-members.ts`:

- `membersOf(codebase, installationId)`: each root on this host, then the
  repositories inside it.
- Inside a root it looks one level down, and one more level inside a child that
  is a plain folder (`src`, `packages`).
- A repository is a folder whose `.git` is a directory. A linked worktree and
  a submodule have a `.git` file, so they are not found.
- It skips dot-folders, `node_modules`, the paths in the `.gitmodules` file
  of the root, and the paths in `ignoreRepositories` of the root's
  `.solus/config.json` (`readIgnoredRepositories`, which reads the file in
  the folder itself and does not ask Git). An ignored path also covers the
  repositories below it.
- A symbolic link that resolves outside the root is not a member. A link to
  a repository that is also found by its own name gives one member.
- A root is what the person named: a root with any `.git`, a file or a
  directory, has the state `git` (`folderStateOf`). So a linked worktree or
  a submodule can be a root, and a submodule root has `submodule: true`.
- A root inside a different root is one member: the root.
- Git runs only for the facts of a repository that was found (its origin and
  whether it has a commit), four repositories at one time.
- `scanFolder(path)` gives the same answer for one folder that is not in a
  codebase yet, plus the `.code-workspace` suggestions. A suggestion is given
  only for a folder that exists. The file can have comments and trailing
  commas.

**Handlers and event** as in §4. A guest does not get `codebases.changed`
(`sharing/event-audience.ts`).

**Session record.** `session_records` gets `codebase_id` (text, null) and
`attached_folders` (JSON list of `{ path, source }`). `SessionRecord` and
`SessionRecordUpsert` carry them. In an upsert, a field that is left out
keeps the stored value. `SessionFolders` is the one writer
(`setSessionRecordFolders`, and the fields of the session start).

**Client rules** `packages/client-core/src/codebases.ts`, pure and shared
with mobile: `mergeCodebases(copiesByHost)` returns the newest copy of each id
and, for each host, the copies that it must get. The same file has the rules
of a record that both client stores use: the refusal of a root (`duplicate`,
`limit`, `missing`), `nextUpdatedAt`, `rootFor`, and `codebasesHolding`.

Proof: unit tests for discovery on real temporary Git repositories (nested
repository, plain wrapper folder, submodule, linked worktree, ignored
repository, link out of the root), for the newest-wins save and the tombstone,
and for `mergeCodebases`.

## 6. Stage 2 — the folders of a session

**Owner** `packages/server/src/execution/sessions/session-folders.ts`
(`SessionFolders`). `SessionCheckouts` keeps the one working directory of a
session; `SessionFolders` owns all other folders. It:

- keeps the codebase that the session has, and gives a session that has
  none the codebase that a turn names (decision 5), else the one that the
  rules of decision 13 find or make (`settleCodebase`). It reads the codebase
  in the record scope of the person that the turn acts for, so a person does
  not get the folders of a codebase that they cannot read;
- resolves the folders at each turn start: the members of the session's
  codebase on this host, less the working directory and the repository that
  the working directory is in, plus the attached folders of the session
  record. An attached folder that is gone stays in the record and is left out
  of the list until the folder comes back. A member inside the working directory is a session folder (Git
  status, diff, and checkpoints work for each repository), but it is not in
  `grantedPaths`: the provider reaches it already. In a task folder session
  the worktrees stand in for the members (stage 3);
- publishes `session_codebase` when a rule of decision 13 gives the session
  a codebase, and `session_folders` when the list changes, before the first
  `git_context` of a folder. It sends the two to each client that starts to
  watch the session (`replayTo`), but not a codebase that is deleted. A
  client that opens a session reads `sessionFolders` itself;
- registers each `git` folder with `CheckoutService`, so `git_status` and
  `git_context` events carry that folder's `cwd`;
- answers `grantedPaths(sessionId)`, `promptFolders(sessionId)`, and
  `checkpointTargets(sessionId)`.

**Providers.** `run-launcher.ts` resolves the folders in the dispatch step
`session_folders`, then passes `grantedPaths` (both the named and the real
path of each) as `additionalDirectories`, with the project root of a worktree
session as before.

- Claude: unchanged option. A query starts at each turn, so a new list applies
  at the next turn.
- Codex: `sandboxPolicyFor(mode, roots)` puts them in `writableRoots`, sent at
  each `turn/start`.

**Prompt block.** `runtimeInstructions` gets the folders. Both providers and
the Codex fallback call get the block:

```text
<codebase name="shop">
This work covers several folders. Each Git repository has its own history: run Git inside the repository you change, and commit each one separately.
On this host:
- web (Git repository): /Users/me/shop/web
- notes (folder): /Users/me/shop/notes
On other hosts (to change one, start a session there with start_sessions, with its host and path as cwd):
- infra: /srv/infra on build-server
To work in a folder that is not listed, call attach_folder first.
</codebase>
```

Names and paths come from the disk and from people (`codebaseBlock` in
`runtime-instructions.ts`):

- A name loses its control characters, `<`, `>`, backticks, and double
  quotes, and is at most 64 characters.
- A path cannot be changed and stay correct. A folder whose path has a
  control character, a line separator, `<`, or `>` is left out.
- The block is at most 3,600 bytes. It ends with the count of the folders
  that it left out.
- A line of a different host has no kind: this host cannot read whether a
  root there is a repository.
- The `start_sessions` hint and the `attach_folder` line are written only
  when the run has that tool.
- A session whose codebase adds no folder on this host and no root on a
  different host gets no block. A session with no codebase that has an
  attached folder gets a block with no name.
- In a task folder, the line of the working directory has the name of the
  member that it stands in for.
- The block has a stable order, so an unchanged list does not change the
  system prompt.

**Attach.** `SessionFolders.attach(sessionId, path, source, actor)` adds a
folder with no rule: the path must be a directory that this actor may use as a
working directory (the same check that a new session passes; a member of an
organization stays in their own folder). A person's own `sessionAttachFolder`
calls it. After the attach, a session with no codebase can get one (decision
13, rule 4): the attached folder is then a member, and its source is
`codebase`. One function in front of it decides for an agent,
`SessionFolders.requestAttach(sessionId, path, source, actor, options)`. The
rule is in `execution/sessions/session-folder-attach.ts`, and
`execution/sessions/attach-target.ts` names the folder. In the order of the
code:

1. A path in a root of the codebase on a different host, which does not exist
   on this host: no attach. The answer names the host (`other-host`).
2. A path in the working directory or in a granted session folder: nothing to
   do (`available`).
3. The path names the folder to attach (`attachTargetOf`): the root of the
   Git repository that holds it, else the path when it is a directory, else
   the directory of the file. A linked worktree in a different place than its
   repository, and a submodule, name their own directory. The root of the
   file system and the home directory are refused (`invalid`).
4. A member of the session's codebase: attach, in each mode. In a task folder
   session the worktree of the repository stands in for it (§7).
5. Mode `full-access` or `auto`: attach.
6. Other modes: a question card (`question_request`, answered through
   `answerToolQuestionWith`) with the choices of decision 8. Its
   `questionId` starts with `attach-folder-`, so the question card of each
   client shows it with no change. One card for one folder: a second request
   waits for the same answer, and a refused folder is not asked again in the
   turn (`refused`). With no way to show a card, or when the turn stops
   before the answer, the folder is not attached (`not-asked`).

"Allow and add to the codebase" writes the folder as a root of the session's
codebase on this host (`addCodebaseRoot`), with a newer `updatedAt`, so each
host takes the copy.

The triggers:

| Trigger | Where |
|---|---|
| The prompt names a directory on this host (`~/x`, an absolute path), or a file that the person pointed at with an `@` mention or an attachment line, in a folder that is not a session folder | `prompt-dispatch.ts` (`attachNamedFolders`, with `prompt-paths.ts`), before the launch, in `submitPrompt`, `promptSession`, and `createSession`. Not in `retry` and `startUnattendedSession`. Only in `full-access` and `auto`; in card modes the agent asks with the tool. At most three folders for one prompt. A file path in the text alone attaches nothing: a pasted log names many files. A path in the attachment store of the host is skipped. |
| The agent calls `attach_folder({ path })` | New tool `agents/tools/folder-tools.ts`, `requiresApproval: false`; the rule above decides. |
| Claude asks permission for a path outside its folders (`blockedPath`) | `claude-permissions.ts`. A request that matched an ask rule of the person always shows its card. "Allow for session" also attaches. In `auto` the answer is allow with `updatedPermissions: [{ type: 'addDirectories', destination: 'session' }]`, and no card. A path in a granted folder that the running query does not know gets the same answer when the mode asks nothing for the call in the working directory (a read in each mode, an edit in `accept-edits`). |
| Codex asks approval for a write outside the sandbox | `codex-backend.ts` `onServerRequest`. In `accept-edits` and `auto`, a request whose paths are all inside granted session folders is accepted with no card (Codex applies new `writableRoots` only at the next turn). `supervised` asks for each write, so its card stays. "Accept for session" also attaches. |
| A tool changed a file in a repository that is not a session folder (`full-access` asks nothing) | At turn end (`observed-writes.ts`), from the write tools of both providers (a shell command names no file): `source: 'observed'`, `granted: false`. For review only, so a folder with no repository is left out. A turn that stopped before its end is read at the next turn start. A later attach of the same path replaces the observed entry. |

`attach_folder` on a path whose member is on a different host does not attach:
it answers with the host and tells the agent to use `start_sessions`. The
tool is in the Sessions group of the tool catalog, so a person can turn it
off in Settings → Tools.

The provider adapters reach the rule through one seam, `SessionFolderGate`
(`execution/agents/session-folder-gate.ts`): the mode of the session, the
granted folder of a path, the attach with no card, and the checkpoint targets
(§8).

**Child sessions.** `CreateSessionOrder` gets `codebaseId`. `start_sessions`
sets it from the caller. For a child on a different host,
`HeadlessSessionRequest` carries the `Codebase` record; that host saves it
(newest wins) before it resolves the folders (`receiveSessionCodebase`). A
caller without `host.use` brings no codebase. A record that the host cannot
save does not stop the session: it starts with the id.

**Project tools.** `create_project` and `clone_project` get
`add_to_codebase?: boolean` (default true). After success: when the new folder
is not inside a root, add it as a root of the session's codebase; then attach
it with `source: 'created'` (`SessionFolders.adoptCreated`). In a session
with no codebase, that attach makes the codebase (decision 13, rule 4), and
`addedToCodebase` is true. With `add_to_codebase: false`, the folder is only
attached. A folder that a
session folder holds already is not attached a second time. Their
descriptions no longer tell the agent to start a session to work there. The
result has `sessionFolder`, `addedToCodebase`, and, on a failure,
`sessionFolderError`.

**Cleanup.** Delete `additionalDirs` from `Session`, `SessionCtx`, the tab
snapshot, tab persistence, the factories, and `session-config.svelte.ts`.

Proof: unit tests for the folder resolution (member on this host, member on a
different host, working directory inside a root, attached folder kept across
turns), for the attach rule in each of the five modes, for the prompt block
(order, limits, unsafe names), for `sandboxPolicyFor` with roots, and for the
child order that carries the codebase.

## 7. Stage 3 — the task folder

**When.** A new worktree session works in a task folder when it gets a worktree
of more than one repository, or when its working member is a plain folder. A
worktree session of one repository keeps today's worktree in
`<repo>/.git/solus/worktrees/<slug>`. Both are correct; only the first keeps
relative paths between repositories. The session must have a codebase, and
its project folder must be a member of the codebase on this host: in each
other case the plan is null (`SessionTaskFolders.plan`), and the session gets
one worktree inside its repository. The host gives the session its codebase
before the plan (decision 13), so the first worktree session in a folder that
holds repositories works in a task folder.

**Which repositories.** `worktreeRepositories(run)` null: every `git` member on
the run host when the worktrees to make are at most
`CODEBASE_WORKTREE_DEFAULT_MAX`, the working member counted when it is a
repository; none above that. A repository with no commit and a submodule are
left out. A member that shares no common ancestor with the working member (a
different Windows drive) cannot be chosen. A choice that names a path that is
not a member, or not a repository, is refused with a message for the person.
`components/input/lib/worktree-repositories.ts` has the same rule on the
client, so the start control shows what the host will do.

**Where.** `<data folder>/solus-task-folders/<branch slug>-<8 hex>`, or the
member folder of an organization member, as for chats
(`docs/plans/projectless-chat.md`; `taskFolderBaseFor` in `workspace.ts`). The
data folder is never inside a repository: a base folder that is a Git
repository is refused. A folder that exists is never used.

**Layout.** The anchor is the deepest common ancestor of the working member and
the chosen repositories. Each one is at `root + relative(anchor, path)`.

```text
members   ~/shop (plain)            task folder  <data>/solus-task-folders/fix-login-1a2b3c4d/
            api/   (.git)             shop/              working directory
            web/   (.git)               README.md -> link to the original
            README.md                   api/           worktree, branch fix-login
          ~/libs/ui (.git)              web/           worktree, branch fix-login
                                      libs/ui/         worktree, branch fix-login
```

A plain member becomes links to the entries of the original. Only the folders
on the way to a repository are real folders. An entry that is a checkout gets
no link, also when it is not a member: a link is the original, so a
repository is never linked. An edit of a linked file changes the original
for every session; the UI says so.

**Owner** `packages/server/src/git/task-folders.ts`, a module of functions,
with the record in a host table `task_folders` keyed by `root` (two sessions
can share one). Its parts are `task-folder-plan.ts` (the plan, which reads no
disk), `task-folder-store.ts` (the record: `findTaskFolderContaining`,
`listTaskFolders`, `projectRootOfPath`), `task-folder-links.ts` (the links of
a plain member), and `task-folder-layout-command.ts`. A caller imports
`task-folders.ts`. The changes of one task folder run one at a time. It owns
each change:

- `planTaskFolder(input)`, then `createTaskFolder(plan, options)`. The module
  does not resolve the base folder: the caller gives `baseFolder` and, on a
  host where each member is their own user, `member`. The record is written
  before the first checkout, so an interrupted creation is found and removed.
  One branch name that is free in every repository; it gets a number when it
  is not. Each repository starts from the base branch when it has one, and
  from its default branch when it does not. Each checkout goes through
  `createWorktree`, which has one rule for the start commit (it starts from
  `origin/<base>` when the repository has an origin, and it fetches), so a
  task folder has no option of its own for that. Four checkouts at one time; a
  worktree inside a different one is made after it. A failure removes the
  worktrees and the branches that this call made.
- `addRepository(root, repositoryPath, options)`: a worktree on the session's
  branch in a running session. A repository outside the anchor, a submodule,
  a folder that is not a repository, and a repository that has its worktree
  are refused. In the stand-in of a plain member, a link on the way to the
  place becomes a real folder (`openPlaceInLinks`).
- `renameBranch(root, from, to)`: all repositories or none. It answers the
  name that was used, or null with no change when a worktree is not on `from`
  or its branch was pushed (the rule of `renameWorktreeBranch`). The branch
  namer (`nameWorktreeBranch`) calls it for a task folder.
- `restoreTaskFolder(taskFolder, memberRepositories?)`: puts back what is
  missing, in place of `recreateMissingWorktree`. `memberRepositories` are
  the repositories of the codebase that have no worktree: their places get no
  link. A checkout at the place of a worktree that is not a worktree of its
  repository is an error and is never changed.
- `removeTaskFolder(root, options)`: the worktrees, the deepest first, then
  the links, then the folder and the record. It keeps a worktree that has
  uncommitted changes unless forced, and a file that exists only in the task
  folder. The answer lists what was removed and what was kept, with the
  reason. With `deleteBranch`, the branch is deleted in each repository
  whose worktree was removed: only a merged branch without `force`.
- **Layout commands.** `worktreeLayout: { create, remove }` in the
  `.solus/config.json` of the working member replaces the built-in layout
  (`readWorktreeLayout`, which reads the file in the folder itself). The
  command runs through the shell in the working member with
  `SOLUS_WORKTREE_ROOT`, `SOLUS_WORKTREE_PRIMARY_PATH`,
  `SOLUS_WORKTREE_BRANCH`, `SOLUS_WORKTREE_BASE`,
  `SOLUS_WORKTREE_REPOSITORIES` (one path for each line), and
  `SOLUS_CODEBASE_ROOT` (the working member). `GIT_DIR` and `GIT_WORK_TREE`
  are removed from its environment. Solus adopts only a checkout that is a
  linked worktree of the correct repository on the session's branch: each
  other checkout at the place of a member repository rolls the creation back.
  The command can also make the worktree of a member repository inside the
  anchor that was not chosen, so the branch name is also made free there. A
  layout command gets no `.worktreeinclude` copy and no links.
  `worktreeLayout.remove` always runs first in a removal, also without
  `force`, and after a creation that failed. One command at a time for each
  working member; ten minutes.

**The session side.** `execution/sessions/session-task-folders.ts`
(`SessionTaskFolders`) connects a session to `TaskFolders`: it makes the plan
from the session's codebase, gives the base folder and the first branch name,
and reads the folders and the checkouts again after a change.

- A session continues in its task folder. The client of a session with a plain
  working member has no checkout to send back, so it names the member, and
  the host finds the task folder from the record of the session.
- In a task folder session the worktree of a repository stands in for it in
  each place: the session folders, the prompt block, the checkpoint targets,
  and the attach rule (a repository with no worktree gets one, in place of an
  attach of the shared checkout). A plain member that holds a repository is
  not a session folder, because a grant of it reaches the shared checkouts. A
  plain member with no repository stays a session folder at its own path.
- A worktree keeps its Git data in its repository. The provider gets the
  `.git` directory of each repository that has a worktree, so a provider with
  a write sandbox can commit. It does not get the files of the repository.
- The branch namer runs beside the first turn, as for one worktree, and
  renames each repository or none.
- At the start of the host, a task folder that no session names is removed
  (`sweepUnnamed`, in the host scope). A worktree with changes stays. A
  creation in the same process waits for the sweep. The record of a task
  folder names the session that it was made for (`session_id`, written when
  the creation ends), so a task folder that `move_checkout` made stays across
  a restart of the host before the next turn of its session.
- `sessionAddRepositoryWorktree` accepts only a candidate
  (`SessionTaskFolders.candidates`), then reads the folders of the session
  again and publishes them.
- The setup card of the launch shows one `checkout` step for all
  repositories, with a detail such as "web (2 of 3)" (`taskFolderStages`).
- No task folder is removed when a session is deleted or archived. The sweep
  at the next start of the host removes it.
  The record of a task folder names the session it was made for when the
  creation ends (`session_id`), so the folder of a session that moved into it
  stays before the next turn of that session.
- `move_checkout` with `new_worktree` makes a task folder when the plan is not
  null. A move out with `remove_worktree` removes the task folder; what stays
  (a worktree with uncommitted changes, a file that exists only there, all of
  it when a different session works there) is said to the agent.
- A plain working member needs a base branch in the request, as each new
  worktree does. A repository that does not have that branch starts from its
  default branch.

**Paths.** A task folder path does not contain `/.git/solus/worktrees/`, so
`worktreeProjectRoot(path)` cannot name its repository. Each reader that has a
`GitCheckout` uses its `repoRoot`. Each reader that has only a path asks
`isTaskFolderPath` and then uses the session record (`project_root`) or
`taskFolderOf`. `isSolusWorktreePath` is true for both kinds. Stage 3 audits
every reader of the marker. A server reader that has only a path calls
`projectRootOfPath` (`git/task-folder-store.ts`), which reads the record. The
modules that the Git process layer loads (`worktree-manager.ts`,
`project-config.ts`) ask Git, not the record, so they load no database. A
session record names its project with `sessionProjectRoot`, and a task link
carries `projectRoot` beside `checkoutPath`.

**Entry points.** The launcher (new worktree step), `move_checkout` with
`new_worktree`, `sessionAddRepositoryWorktree`, the missing worktree restore,
and the worktree removal of `WorktreeMover` all go through `TaskFolders` when
the path is in a task folder.

Proof: unit tests on real temporary repositories for the plan (default set,
above eight, no commit, submodule), the layout (plain member links, nested
repositories, anchor), the branch name collision, the roll back of a failed
creation, add, rename, restore, remove, and one layout command.

## 8. Stage 4 — review for each repository

**Checkpoints** (`git/turn-checkpoints.ts`, `git/folder-turn-snapshots.ts`).
A backend gives one `CheckpointTarget`: the session, its working directory,
and a function that answers the `git` session folders at that moment
(`SessionFolderGate.checkpointTargets`). The function is read at each end of
the turn, so a folder attached in the turn is in the second answer. Refs and
the sidecar file are in each repository, as before.

- The working directory keeps its behavior: a base and a tree at each turn
  start, a snapshot at each turn end.
- A session folder is lazy. At the turn start one `git status` reads it. A
  clean folder is only noted in memory, with its commit. A folder with changes
  gets a base and a tree, so those changes stay out of the turn. At the turn
  end a folder that is still clean at the noted commit is left alone: no ref,
  no sidecar entry. One that changed gets its base from the noted commit, then
  its snapshot.
- All session folders of one turn start share `FOLDER_START_BUDGET_MS`
  (2,000 ms), four at one time. A folder that misses the budget has no start
  in that turn. The turn end has no budget: it reads each folder one time,
  four at one time, before the turn completes.
- A folder with no start in a turn (attached in the turn, or late) shows the
  files written after the turn started, by their write times, each against the
  last captured state (the session's latest snapshot there, else `HEAD`). A
  file deleted in the turn has no write time and stays out of the turn. A
  folder with no such file gets no checkpoint.
- Two folders in one repository root (a path and its real path, or two
  worktrees of one repository) are one target: the first one. Storage has one
  sidecar for a session in a repository.
- `TurnActivity` is keyed by session and work tree: a session has one open
  turn in each repository.
- Each repository counts its own snapshots, so one turn has a different index
  in each. The snapshots of one turn carry the same `traceId`: join by it.
- While a turn runs, the session scope of a folder that was clean at the turn
  start reads against the noted commit.
- `session_changed_files_updated` still names the paths of the working
  directory only.
- Session sync, the session archive, and code bundles read the working
  directory only. A session that is copied to a different host has no base, no
  turn snapshots, and no code of its session folders there.

**Change summary** (`contracts/session-digest.ts`). One checkpoint event for
one turn holds all the repositories, so no repository's checkpoint replaces
another's. `SessionChangeSummary` has the totals over all repositories and,
only when more than one repository has changes, `repositories`: one entry for
each, with `repositoryPath` (the session folder's `repositoryPath`; for the
working directory, its repository root), `name`, its totals, and its files
relative to that repository. The top `files` list names a file of the working
directory's repository as before, and a file of a session folder with the
folder's path from the working directory in front (`../api/handler.ts`), so
two repositories never name one file the same. `DigestTurnChanges` has the
totals of the turn and, when the turn changed more than one repository,
`repositories` with the counts of each.

**Diff.** `DiffRequest.repositoryPath`, `DiffFileContentsRequest.repositoryPath`,
and `listTurnSnapshots(ctx, repositoryPath)` select the repository: the
working directory, its repository root, or the `path` or `repositoryPath` of a
`git` session folder (resolved through `SessionFolders`). Any other path is
refused. Each scope (`session`, `turn`, `working-tree`, `branch`) reads that
checkout.

**Git actions.** They already take the checkout from the client context, so
the client builds the context for the folder of the row
(`session.workingDirectory` is the folder's `path`, with the folder's
`gitContext`). `gitRunAction`, `gitCheckoutBranch`, and
`gitRegisterEnvironment` do not bind the session when the folder is a session
folder of that session: the folder's own `git_context` and `git_status` events
carry the change.

**Pull requests.** A pull request that Solus creates is linked by repository.
Branch detection also reads the `git` session folders
(`sessionFolderCheckouts`, `docs/plans/session-pull-requests.md`): only a
folder that a turn of the session changed, and a worktree that stands in for
its repository. A session holds one `branch` link for each repository.

**Track with Git.** `gitInitRepository(path)` on a `plain` session folder tells
`SessionFolders` (`folderChanged`): each session that has the folder reads its
folders again, so the folder's state is `git` and its checkout is watched.

Proof: `tests/unit/turn-checkpoints-repositories.test.ts`,
`session-folder-review.test.ts`, `session-folder-pull-requests.test.ts`, and
the added cases in `session-digests.test.ts` and
`session-pull-requests.test.ts`.

## 9. Stage 5 — desktop and web

- **Store** `contexts/codebases/codebases.store.svelte.ts`: one list for each
  host, merged with `mergeCodebases`; it sends the newest copy to a host that
  has an older one; it reads members from each host that a root names and keeps
  the last answer of a host that is away. Model: `webhooks.store.svelte.ts`.
- **Settings → Codebases** (group Code, `components/codebases/`): list,
  create, rename, delete, add and remove roots on any connected host, the
  members of each root with their state, the `.code-workspace` suggestions
  with an Add button. The open codebase is the route param `codebase` of the
  settings route. The palette has "Open codebases" and "New codebase"
  (`codebaseCommands`). A delete is one tombstone that the store saves on
  each host with `codebaseSave`. `addRoot` scans the folder again, so the
  path in the record is the resolved path of the host, and it refuses a
  folder that is in the codebase, a folder that is `missing`, and a root
  above the limit. A change that no host saves is taken back from the list.
- **Start.** The project chip has one choice: a run is in a project, or it
  is in a codebase (`chipAtRest` in `input/lib/codebase-choice.ts`). A run
  that has a codebase shows the codebase: the chip shows one name, the name
  of the codebase, with the codebase icon, and the list marks the row of the
  codebase and no row of the Projects group (`marksProjectRow`). A run with
  no codebase shows the project, and the list marks its project row and no
  row of the Codebases group. The chip never shows the two names. The
  working folder of a codebase run is in the tooltip of the chip ("Works in
  <folder> on <host>", `chipHint`) and in the Environment section.
  A choice of a codebase sets `codebaseId`. The folder of the run stays when
  the codebase holds it; else the run opens the first root of the codebase
  on the run host (`codebaseChoiceStep`). The list has no step that asks
  which root: a row of the Projects group is how a person changes the
  working folder inside a codebase. A codebase with no root on the run host
  says so and lists the hosts that have one; a choice moves the run to that
  host. A project folder that is in exactly one codebase on its host starts
  with that codebase, decided one time for each folder, so "No codebase"
  stays the person's choice (`input/lib/codebase-start.svelte.ts`). The
  decision is in memory, for each tab and folder. Thus a choice of a project
  row inside a codebase shows that codebase on the chip. "No codebase" is
  the one way to a project-only run in such a folder. It is offered only
  while the run has a codebase, or gets a new one.
  The Git dropdown
  gets the repositories of the new worktree (`input/lib/worktree-repositories.ts`
  has the rule of `planTaskFolder`) and, for a plain working member, the base
  branch. A Git answer for a folder with no repository keeps the base branch
  that the person named (`adoptGit`).
- **Running session.** The project panel of a started session gets a
  Repositories section (`docs/project-panel.md`): one row
  for each session folder with its branch and changes, Git actions for the row,
  "Track with Git" for a plain row, "Add to codebase" for an attached row, and
  the members on other hosts with the child sessions that work there. "Add
  folder…" attaches a folder that the person chooses (the directory picker
  intent `choose-folder`), and "Add repository…" reads
  `sessionWorktreeCandidates` when its menu opens. The palette has "Add
  folder to this session", "Show repositories", and "Open codebase settings"
  (`project-panel/lib/repository-commands.ts`). The diff
  panel gets a repository picker beside the scope picker. `lib/changedFiles.ts`
  makes a path relative to the longest session folder that holds it.
- **No offer.** The first plan had an offer "Make a codebase" in the
  section, for a session with no codebase that got its second folder. The
  host makes that codebase now (decision 13, rule 4), so the offer and its
  code are removed. In each state where the host makes none (a tombstone,
  "No codebase", a folder that the host only observed), the person said no or
  attached nothing: they make a codebase in Settings.
- **The event.** On `session_codebase` the reducer gives the run of the tab
  the codebase (`chooseCodebase`).
- **The divider.** The `codebase_formed` activity is a divider of the
  conversation (`ActivityDivider`, with `TranscriptDivider` as each other
  divider): "Made the codebase <name> from the folder <folder>" (or "from
  the folders <folder> and <folder>"; `conversation/lib/codebase-divider.ts`),
  with no end period, as each divider. The name of the codebase has the
  accent, and the divider is a button that opens Settings → Codebases on
  that codebase. It has no Undo: the delete of a codebase is on that page.
  A formation at a turn start is recorded while the bubble of the prompt is
  on screen, so the reducer puts the divider before that prompt, where a
  history read puts it. A toast said this before. A toast is gone after a
  reload and shows on one client only, so it was removed with its Undo and
  Open actions (`contexts/codebases/formed-codebase.ts`).
- **A deleted codebase.** When the store says that the codebase of a run is
  deleted (`codebasesStore.isDeleted`), the strip clears the codebase of the
  run (`useCodebaseStart`), also for a started session.
- **Before the first prompt.** For a draft in a folder that no codebase
  holds, the strip reads the folder one time
  (`codebasesStore.readFolder`). `codebasesStore.newCodebaseAt` answers the
  scan when the host makes a codebase there (`formsCodebaseFor` in
  `client-core/src/codebases.ts`: repositories inside, no holder, no
  tombstone with the folder as a root). The chip then shows the project
  with the note "New codebase": it is one thing, a project that becomes a
  codebase at the first prompt. The list marks the project row. The
  Codebases group has a row with the name of the folder and the note "New",
  with no mark, and the start control takes the members of the scan. No record is
  made on the client. "No codebase" is `refuseCodebase`: the run sends
  `noCodebase`.
- **Project picker.** A row of the Codebases group says how many
  repositories its codebase covers on the run host, when that host read
  them. The chip shows one name, so it shows no count.
- **Git section of a folder with no repository.** When the working directory
  holds repositories (the session folders of a started session, or the
  members that the host read for a draft), `GitSetupSection` shows one row,
  "N repositories in this folder", in place of "This folder isn't a Git
  repository yet." The row opens the Repositories section
  (`revealRepositories`), and "Track with Git" is in its menu.
- **Environment section.** The project row shows the name of the codebase of
  the run in its trailing slot, with the host (`lib/project-row.ts`).
- **Files and terminal of a session folder.** The menu of each row of the
  Repositories section has "Open files" (`WorkspaceContext.openFiles` with
  the folder) and, on the desktop app for its own machine, "Open terminal"
  (`gitActionsFor` with the folder).
- **Git in a session folder.** The Git section, its branch row, the commit
  composer, and the publish dialog take a `folder`. The Git store reads that
  folder by its own path (`environmentIn`), and a refresh of a session folder
  goes to the status cache only: nothing lands on the run, and nothing is
  registered.
- **A plain working member.** The session works in the folder of the task
  folder that stands in for the member, and it has no checkout. The client
  moves the run there with `workInStandIn` (the project home and the codebase
  stay): on open from `taskFolderOf(record.cwd)`, and for a live session when
  its worktree setup card is done (`SessionOpening.settleStandIn`).
- **Session events.** `session_folders` is stored on the tab state by property
  (never replace `TabState`). `git_context` updates the run location only when
  its `cwd` is the working place.
- **Diff panel.** The repository picker lists `diffRepositories(session)`
  (`components/diff/lib/diff-repositories.ts`): the working directory, then each
  `git` session folder. It shows only when there is more than one. The choice
  is in the tab's `ConversationViewState` (`diffRepositoryPath`), it is part of
  the diff state's key, and each request names it (`repositoryPath`). A session
  folder has its own turn list (`diff-repository-turns.store`); a move to a
  different repository keeps a selected turn by its `traceId`, and a turn that
  the other repository does not have becomes the session scope. A folder that
  leaves the session puts the picker back on the working directory. The guide
  and the lens read the working directory's checkout, so they are not offered
  while the panel reads a session folder. `showRepositoryDiff(tabId,
  repositoryPath, scope?, filePath?)` on the workspace context opens the panel
  on one repository.
- **One name for one file.** A file of a session folder is named from the
  working directory (`../api/src/a.ts`), as the host's change summary names it
  (`lib/session-paths.ts`). Queued diff comments, the transcript's changed
  paths, and the summaries use that name, so two repositories never name one
  file the same. The path after the folder is the path from the longest
  session folder that holds the file.
- **Summaries.** With more than one repository, the changed-files card and the
  Threads surface put each file below a folder with its repository's name.
  When the digest has `repositories`, they also show one row for each
  repository (name, files, lines) that opens the diff panel on it.

## 10. Stage 6 — mobile

The T3 Code import already has the screens of the reference pull request
(`ProjectRepositoriesSection`, `ThreadRepositoryRows`,
`use-worktree-repository-choices`, the repository selector of `ReviewSheet`,
`GitOverviewSheet` with `repositoryCwd`). They were dormant because Solus
never filled their data. Stage 6 fills it in `apps/mobile/src/solus/*` and
`apps/mobile/solus-core/` (`apps/mobile/AGENTS.md`). `apps/mobile/UPSTREAM.md`
records each intended difference from T3 Code.

- **Model.** `solus.codebases`
  (`apps/mobile/solus-core/features/codebases/codebases.ts`) has the same
  reads and commands as the desktop store, with the shared rules of
  `packages/client-core/src/codebases.ts`. It keeps the copies by account and
  organization and forgets them when either changes.
- **Codebases of a project.** `src/solus/ProjectCodebases.tsx` shows one
  group of sections for each codebase that holds the project folder, on the
  Solus project page (`ProjectSettings`): the folders on the host, the
  folders on other hosts, "Add folder", "Rename codebase", "Delete
  codebase", and "Make a codebase". "Make a codebase" stays: it is the way
  to make a codebase by hand, as Settings → Codebases is on desktop. `src/solus/codebase-folders.ts` and
  `codebase-rows.ts` give the T3 section its data.
- **Start.** `src/solus/DraftWorkspaceControls.tsx` has the codebase of the
  draft, the choice of a new worktree, and its repositories. The first
  prompt of the run carries `codebaseId` and `worktreeRepositories`. For a
  folder that no codebase holds, the draft reads the folder
  (`solus.codebases.readFolder`), and the repositories control lists the
  members of the codebase that the host makes (`newCodebaseAt`). "No
  codebase" of the Codebase control sends `noCodebase`.
- **The event.** `ConversationController` gives the run the codebase of a
  `session_codebase` event, so the next prompt names it. The thread feed
  shows no divider for a `codebase_formed` activity: the feed of T3 Code has
  no line for a move into a worktree, so there is no pattern to follow
  (`apps/mobile/UPSTREAM.md`).
- **One name.** The heading of a draft names the project, as the headline
  of a desktop draft does. The Codebase control shows only when more than
  one codebase holds the folder. T3 Code has no control that shows a project
  or a codebase as one choice.
- **Running session.** `src/solus/session-repositories.ts` translates the
  session folders for `ThreadRepositoryRows` and the Git sheets. A sheet of a
  session folder has "Track with Git", "Attach", and "Detach". In a task
  folder, the other repositories come from `sessionWorktreeCandidates`, and a
  choice calls `sessionAddRepositoryWorktree`.
- **Review.** `useCheckoutReviewSections` reads the patch of each repository
  with `repositoryPath` and joins the turns by `traceId`.
- **Attach card.** The card is a normal question, so the pending input card
  shows it.

## 11. Stage 7 — documents

`docs/codebases.md` (how a person uses it, with its limits),
`docs/plans/project-model.md` (a pointer from §1),
`docs/plans/permission-modes.md` (the attach rule), `docs/project-panel.md`
(the Repositories section), `docs/projects.md` and `docs/solus-tools.md` (the
project tools and `attach_folder`), `docs/plans/session-pull-requests.md` (one
`branch` row for each repository), the Codebase Map and the glossary in
`AGENTS.md` (the new modules and words), and `docs/database-schema.md` (the
two tables and the two columns).

## 11a. Stage 8 — a codebase forms by itself

Decision 13 has the rules. The parts:

- **Host.** `execution/sessions/session-codebase-formation.ts` has the rules
  that take or make a codebase (`codebaseForProjectFolder`,
  `codebaseForAttachedFolder`) and `projectFolderOf`. `SessionFolders` decides
  which session has no codebase (`hasCodebase`), calls the rules
  (`settleCodebase` at a turn start, `formForAttached` after an attach),
  writes the session record, records the `codebase_formed` activity of a
  formation, and publishes `session_codebase`.
  `run-launcher.ts` calls `settleCodebase` before the plan of a new worktree.
- **Desktop and web.** §9, from "No offer" to "Files and terminal of a
  session folder".
- **Mobile.** §10, "Start" and "The event".

Proof: `tests/unit/session-codebase-formation.test.ts` (each rule on real
folders and repositories, the name, the lock, the tombstone, "No codebase",
the special folders, the event and its replay, the prompt block, and the
first worktree session, and the divider: written one time on a formation,
not written for a codebase that exists, and at its place in the history that
a reload reads), `tests/unit/codebase-formed-divider.test.ts` (the text of
the divider and its place on the client, live and after a reload),
`tests/unit/codebase-formation-client.test.ts` (the reducer, the store answer
for a draft, the Git row, the Environment row), and the added cases in
`project-chip-codebases.test.ts`, `repositories-section.test.ts`,
`native-mobile-session-folders.test.ts`, and the mobile
`codebases-model.test.ts`.

## 12. Order of work

Stage 1 comes first and declares every contract of §4, so that the stages
after it do not change shared types. Stages 2, 3, and 4 follow in that order on
the server. Stages 5 and 6 can start when stage 1 is done.

## 13. Not in this plan

- File rewind (decision note in §3).
- A commit or a push across several repositories in one action.
- An account copy of the codebase record.
- Building a member on a host that does not have it, without Run on.
- A setup script of a member that is not the working member.

## 14. What differs from the first plan

Each line is one difference, with the reason. The sections above have the
text of the code.

| Where | The first plan | The code | Reason |
|---|---|---|---|
| §3 | Decision 5: a session has only the codebase that it started with | A session with no codebase takes the first codebase that a later turn names | "Make a codebase" in a running session must apply to that session |
| §3 | Decision 8: the card always has three choices | "Allow and add to the codebase" shows only when the session has a codebase | A session with no codebase has no codebase to add to |
| §4, §5 | An RPC method `codebaseDelete` and a store function `deleteCodebase` | Removed. A delete is `codebaseSave` of a tombstone | A tombstone that each host makes has the clock of that host, so two hosts get two `updatedAt` values and one more save each |
| §4 | All codebase methods on the collaboration plane | `codebaseMembers` and `codebaseScanFolder` are on the execution plane | The plane rule: a record is collaboration, a read of a disk is execution |
| §4 | No permission named | `host.use` for the record and the members, `host.files.read` and the path scope for the scan and `taskFolderOf`, `drive.prompt` for the session methods | Each method names the permission that its data needs |
| §4 | Handlers on each server | Registered only on a host | Decision 6: each host keeps the record |
| §4 | Seven session and codebase methods | `taskFolderOf`, `sessionAddRepositoryWorktree`, and `sessionWorktreeCandidates` are added (stage 3) | A client must read a task folder and the repositories that can get a worktree |
| §4 | `sessionAddRepositoryWorktree` accepts each repository inside the anchor | It accepts only a candidate | One list for what a client offers and what the host accepts |
| §5 | `codebasesOfFolder(installationId, path)` | `codebasesOfFolder(scope, installationId, path)`, and `getCodebase(scope, id)` is added | Each read names its scope; `codebaseMembers` needs one codebase |
| §5 | Validation in the contract | In the store | A record holds roots of other hosts, so a path rule cannot be a schema of one host |
| §5 | Each member inside a root is found by discovery | A root with a `.git` file is a member of state `git` | A person can name a linked worktree or a submodule as a root |
| §6 | A member inside the working directory is not a session folder | It is a session folder that is not in `grantedPaths` | Git status, diff, and checkpoints work for each repository; the provider reaches the folder already |
| §6 | The path check of an organization member is a folder boundary | The check is `assertPathInScope` (a guest stays in the checkout of the shared session) | The member folder is a default, not a boundary, in the code |
| §6 | The client applies a `git_context` when its `cwd` is the working place | The client ignores a `git_context` whose `cwd` is a session folder | A new worktree and `move_checkout` arrive as a `git_context` for a path that is not yet the working place |
| §6 | "On other hosts" lines have a kind | No kind | This host cannot read a different host |
| §6 | Unsafe characters are removed from names and paths | Removed from a name; a folder with an unsafe path is left out | A changed path is a wrong path |
| §6 | The prompt trigger attaches for each path that the prompt names | Only a directory, or a file from an `@` mention or an attachment; at most three | A pasted log in `full-access` or `auto` attached many folders |
| §6 | Claude: a path in a granted folder is always allowed with no card | Only when the mode asks nothing for that call in the working directory | Decision 8: edits in an attached folder follow the mode |
| §6 | Codex: a write in a granted folder is accepted with no card | Only in `accept-edits` and `auto` | `supervised` asks for each write, also in the working directory |
| §6 | The attach rule is in `session-folders.ts` | It is in `session-folder-attach.ts` | The file was above the review limit |
| §7 | The owner is a class `TaskFolders` with `plan`, `create`, `restore`, `remove` | Functions `planTaskFolder`, `createTaskFolder`, `restoreTaskFolder`, `removeTaskFolder`, and `findTaskFolderContaining` | One name for one concept; the module has no state besides the table |
| §7 | A `startFromOrigin` option for a task folder | No option | `createWorktree` has one rule for the start commit; a second rule makes the two kinds of worktree start from different commits |
| §7 | The default limit counts the other repositories | It counts the working member when that is a repository | The constant says "isolates every repository only up to this many" |
| §7 | A task folder for each worktree session of several repositories | Only for a session with a codebase whose project folder is a member | A session with no codebase has no list of repositories |
| §7 | Each plain member is a session folder at its own path | A plain member that holds a repository is not a session folder in a task folder session | A grant of that folder reaches the shared checkouts |
| §7 | A member needs no card, so an attach gives the shared checkout | In a task folder session an attach of a repository gives its worktree | The session stays isolated |
| §7 | The layout commands are in the root's config file | In the config file of the working member | The session works there, and it can be a folder with no repository |
| §7 | `worktreeLayout.remove` runs for a forced removal | It always runs first | The command of the project can remove what the built-in removal keeps |
| §7 | Path readers read the task folder record | `worktree-manager.ts` and `project-config.ts` ask Git | The modules that the Git process layer loads must load no database |
| §7 | The provider gets the session folders | It also gets the `.git` directory of each repository that has a worktree | A provider with a write sandbox cannot commit without it |
| §8 | A backend gets a list of checkpoint targets | One target with a function that is read at each end of the turn | A folder attached in the turn is not in a list made at the turn start |
| §8 | Each session folder gets a snapshot at each turn | A session folder is lazy; the working directory keeps its behavior | A codebase can have many repositories, and a turn changes few |
| §8 | One checkpoint event for each repository | One event for one turn, with all repositories | No repository's checkpoint replaces another's in the digest |
| §8 | A file in the summary is relative to its repository | A file of a session folder has the folder's path from the working directory in front | The client joins files by path |
| §8 | A session holds one `branch` pull request link | One for each repository | The agent can open a pull request in each repository |
| §9 | The Git actions of a row are a copy of the Git rows | The Git section itself, with a `folder` prop | No Git component is copied |
| §7 | The record of a task folder names no session | `task_folders.session_id` names the session that the folder was made for | A session that moves into a new task folder names it in its own record only at its next turn, and the sweep at a restart removed the folder |
| §9 | The record rules are in `workspace-ui` | In `packages/client-core/src/codebases.ts` | Mobile uses the same rules |
| §10 | Mobile fills the T3 screens only | Mobile also adds a codebase control for a draft and the folder actions of a Git sheet | T3 Code has no codebase and no attach |
| §3 | Decision 12: a session with no codebase is unchanged, and only a person makes a codebase | The host gives a session the codebase of its project folder, or makes one (decision 13) | The main cases needed a manual step before a session could work in two folders |
| §9 | The Repositories section offers "Make a codebase" | No offer | The host makes that codebase when the second folder is attached |
| §9 | The Git section of a folder with no repository says to set up Git | A folder that holds repositories shows one row that names them | The folder is the place of several repositories, not a project that lacks one |
| §3 | A session keeps the codebase id of a deleted codebase | Such a session is a session with no codebase, and the tombstone stops a new one | A person can delete the codebase that the host made |
| §9 | A toast says that the host made a codebase, with Undo and Open | A divider in the conversation, stored as the `codebase_formed` activity | A toast is gone after a reload and shows on one client. The delete is on the page of the codebase |
| §9 | The project chip shows the project and, beside it, the codebase; its list marks one row in each group | One choice: the chip shows the codebase of a run that has one, else the project, and the list marks one row | Two names and two marks for one place did not say where the run is |
| §9 | A codebase with several roots on the run host asks which one | It opens the first root; a project row changes the folder | One list with one step |
