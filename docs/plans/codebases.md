# Codebases — one session, several folders, several hosts

Status: built. Stages 1 to 8 are in the code. Stage 12 (24 November 2026)
changed the automatic attach and the project panel after the maintainers
used the feature: an automatic trigger attaches only a real project
(decision 8), and the project panel has no Repositories card (§9). Stage 13
(24 November 2026) changed the model again after the maintainers saw it: a
project is one folder, a folder that holds two or more repositories is a
container and a container is a codebase (decision 14), a codebase that Solus
forms gets a short generated name (decision 13), and the surfaces say less
(§9, §10, §11c). The person's guide is
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
3. A person does not keep a list by hand. A folder that holds two or more
   repositories is a codebase by itself, and its repositories are found on
   the disk (decision 14). A second project that the agent needs in the
   middle of a session is attached automatically, and the codebase of the two
   then forms by itself (decision 13).

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **codebase** | A named set of folders, on one or more hosts, that one piece of work covers: two or more projects, or one container. One project is never a codebase (decision 14). |
| **container** | A folder that is not a repository and that holds two or more repositories (`~/shop` with `api` and `web`). A container is a codebase, never a project. |
| **root** | A folder that a person or the host put in a codebase: an installation id and an absolute path on that host. A root that is a container has the mark `container`. |
| **member** | A folder that a codebase covers on one host: each root, and each repository found inside a container root. A host reads its members from the disk. They are not stored. |
| **member state** | `git` (the folder has its own `.git`), `plain` (a folder with no repository), or `missing`. |
| **session folder** | A folder that one session works in besides its working directory. It is a member of the session's codebase, or an attached folder. |
| **attach** | To add a session folder to a running session. |
| **task folder** | The folder that a worktree session of several repositories works in: one directory that holds a worktree of each chosen repository at the same relative places as the originals. |
| **project folder** | The member that a session works in: the root of the repository of its working directory, else the working directory. For a session in a worktree, the original folder, never the worktree (`projectFolderOf`). |
| **project** | One folder or one repository on a host (`docs/plans/project-model.md`). Solus does not look inside it for more repositories. A codebase does not replace it, and a project is never also a codebase. |

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

   Changed in stage 13: when the attach forms a codebase (the session has
   none, and the folder is a real second project: decision 13, rule 2), the
   card says so. Its choices are then "Allow and make the codebase", "Allow
   for this session only" (the folder is attached, and no codebase is made),
   and "Do not allow". The description of the first choice names the
   proposed name, and the person can change it: the card is a normal
   question card, so the words that the person types in its answer field are
   the name. The host reads the answer as the label of the choice, then
   ` — `, then the typed words (`attachAnswerOf`), which is how the card of
   each client sends a choice with a remark (`formatAnswer`). A codebase
   with a name from a person gets no generated name.

   Changed in the code: the choice "allow and add to the codebase" shows only
   when the session has a codebase. In a task folder session, an attach of a
   repository of the codebase gives the worktree of that repository, and
   makes one when there is none, so the session does not reach the shared
   checkout (§7).

   Changed in the code: an attach needs a request, and there are two kinds.
   A request by name: a person attaches a folder (`sessionAttachFolder`), or
   the agent calls `attach_folder`. An automatic trigger: Solus reads a path
   in a prompt, in a permission request, or in a write (§6). The mode table
   applies to the two kinds. These places are refused in each mode:

   | Place | An automatic trigger | A request by name |
   |---|---|---|
   | The root of the file system, the home directory | Refused | Refused |
   | The data of Solus: the data folder (`solusDir()`, `dataDir()`) and the attachment store of the host | Refused | Refused |
   | A temporary directory of the system: `os.tmpdir()`, `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`, and on Windows `%SystemRoot%\Temp` | Refused | Allowed |
   | A folder that cannot be read | Refused | Allowed, by the rule of the mode |
   | A folder that is no Git repository and is in no project that the host lists (`~/Downloads`, `~/.ssh`, the directory of a file that the agent read) | Refused | Allowed, by the rule of the mode |

   A path that Solus only read is not a request to work in such a place: the
   file of a pasted screenshot is in a temporary directory. A task folder
   and the folder of a chat are in the data folder, and they are folders of
   work, so they are not refused. A member of the session's codebase is not
   refused as a temporary place: a person put it in the codebase. The rules
   are `refusalForSolusData` and `automaticAttachTarget` in
   `execution/sessions/attach-target.ts`. No folder of a session is in the
   data of Solus: a root of a codebase and an attached folder of a record
   that are there are left out when the folders are resolved.

   Changed in stage 12: an automatic trigger attaches only a real project.
   `automaticAttachTarget` answers the folder that such a trigger attaches
   for the target of a path: the target when it is a Git repository, else
   the project that the host lists and that holds it (the project, not the
   folder of the path inside it), else nothing. The rule is in this one
   place, so the prompt trigger, the Claude permission trigger in `auto`, the
   Codex approval, "Allow for session", and the observed write all get it.
   When the trigger attaches nothing, the permission flow of the provider
   answers for that one call, as it did before session folders. Before this,
   a prompt that named `~/Downloads` in a sentence, and one blocked read of a
   file there, each attached the full folder.

   The prompt trigger reads only a prompt that a person wrote in a client:
   a prompt with no sender and no `via` (`isWrittenByAPerson` in
   `prompt-dispatch.ts`; `docs/plans/prompt-sender.md`). A report or a
   message of a different session, the prompt of an automation, a message
   that Solus made (the end of a background command, news of a watch), and a
   retry attach nothing.

   The record of an attached folder says that it was asked for by its name
   (`SessionAttachedFolder.byName`). At a turn start, an attached folder in
   a temporary directory of the system that has no such mark leaves the
   record (`SessionFolders.dropTemporaryFolders`): an earlier rule attached
   it from the path of a pasted file. A folder in a different place
   (`~/Desktop`) stays until a person detaches it.
9. **Parity with the T3 Code feature.** Discovery, opt out, the task folder,
   the layout commands, add a repository to a running session, one branch name
   in all repositories, review and Git actions for each repository.
10. **A folder with no Git is a member.** It is granted and listed. It has no
    diff. Its row has a "Track with Git" action (`initRepository`). There is no
    snapshot system for folders with no repository.
11. **New projects join the codebase.** `create_project` and `clone_project`
    add the new folder to the session's codebase unless the caller opts out,
    and they attach it to the session immediately. A new project in the
    project folder of the session needs no codebase: it is a part of that
    project, or, in a container, the read of the disk finds it (decision 14).
    A new project outside it, in a session with no codebase,
    is a real second project that the agent made on purpose, so it forms the
    codebase of the two folders (decision 13, rule 2).
12. **A session with no codebase has its working directory.** It is in one
    project (decision 14). It can still get attached folders. Decision 13
    says which sessions stay with no codebase.
13. **A codebase forms by itself.** The rule is on the
    host (`execution/sessions/session-codebase-formation.ts`, called by
    `SessionFolders`), so each client, a session that an agent starts, and an
    automation get it. At each turn start, for a session with no codebase:

    1. **Take the one that exists.** Exactly one live codebase holds the
       project folder on this host (`codebasesOfFolder`): the session takes
       it. More than one: the session takes none, and nothing is formed.

       **Rule 1a: the container.** No codebase holds the project folder, and
       the folder is a container (decision 14): the codebase of the container
       forms, and the session takes it (`containerCodebaseOf`). In each
       other case the session stays with no codebase.

    When a folder is attached to a session with no codebase:

    2. **Form one from the two folders.** After an attach with the source
       `attached` or `created` (the tool, the prompt trigger, a permission
       answer, a person's RPC, a project tool), a codebase whose roots are
       the project folder and the attached folder is made, but only when
       the attached folder is a real second project of the work: a Git
       repository (`folderStateOf`), or a folder that is, or is in, a
       project that the host lists (`listedProjectHolding`). For the source
       `observed`, only when the folder is in a listed project. A folder in
       the project folder is no second project: it is a part of that
       project. A folder that holds the project folder is none also: one root of a
       codebase is not inside a different one. A different folder that is
       attached (a folder of notes, the directory of a file that the agent
       read) stays a folder of that session only, and no codebase is made: a
       person can add it to a codebase by hand. A session that has a
       codebase gets no new root from an attach.

    Changed in stage 12, and again in stage 13: the first plan of this
    decision formed a codebase with one root from each project folder that
    holds a repository. Stage 12 removed that rule and let a project cover
    its repositories. Stage 13 has the container rule (decision 14): the
    folder is a codebase and is no project, so the picker shows its name one
    time.

    A codebase is made by a person, by the agent, or by a rule that has a
    reason on the disk: the folder is a container, or a second project of the
    work was attached. A pasted image is not a reason (decision 8: its path
    attaches nothing).

    The rules that apply:

    - **Name.** A container codebase has the name of its folder (`shop`),
      and no model names it. A codebase of two projects forms at once with a
      plain name (`plainCodebaseName`): the common start of the folder names
      when it has three or more characters (`solus` for `solus` and
      `solus-cloud`), else the first folder name and the count of the others
      (`api +1`). When a live codebase in the record scope of the person has
      the name, a number is added: `solus 2`.
    - **The generated name.** After the formation, a small model call gives
      the codebase of two projects a short name
      (`execution/sessions/codebase-name.ts`), the way Solus names a session
      and the branch of a worktree: the writing model of the person
      (`textGenerationModel`, through `writingBackendFor`), on the seat of
      the person, in one run of at most two turns and 30 seconds, with no
      built-in tool, and one tool that takes the answer. The model reads the
      names of the folders and the first 600 bytes of the README of each
      folder on this host. The answer must be one to three words of letters
      and digits, with no punctuation, at most 32 characters
      (`validGeneratedCodebaseName`); each other answer keeps the plain
      name. The name arrives as a normal save with a later `updatedAt`
      (`renameFormed`), so each host takes it, and the session gets
      `session_codebase` again with the new name. The formation never waits
      for the model. Nothing is saved when the codebase is deleted, and when
      it does not have its plain name then: a person renamed it, and that
      name stays. A name that a person typed on the attach card is used as
      it is.
    - **The setting.** `codebaseNaming` is a personal setting (`generated`,
      the default, or `folders`: the plain name stays, and no model is
      asked). It travels with the turn as each execution preference does,
      and a policy can manage it. `codebaseNaming` in the
      `.solus/config.json` of the project folder wins over the setting of
      the person (`resolveCodebaseNaming`), as the branch naming of a
      project does.
    - **One at a time.** The formation for one project folder is serialized
      (`runOneAtATime`), and it reads the codebases again inside the lock.
      Two sessions that attach one project at the same moment give one
      codebase.
    - **A person's "no" is kept.** A deleted codebase is a tombstone that
      keeps its roots. A tombstone stops rule 2 only when the codebase that
      the rule would make has the same set of roots as the tombstone (all on
      this host, compared by their real paths). A codebase with a different
      set of roots is a different codebase: the delete of a wrong codebase
      (`~/solus` with a temporary folder) does not stop `~/solus` with
      `~/solus-cloud`. The tombstone of a container codebase (one root, the
      folder) stops rule 1a for that folder, at a turn start and when the
      folder is added as a project: the folder is then a project again.
      Rule 1 does not read tombstones.
      "No codebase" on a draft is `SessionCtx.noCodebase`: no rule gives that
      session a codebase. The host keeps it in memory for the session, and
      the client sends it with each turn.
    - **No rule** for a chat (`isChat`) and for a guest. **No formation** for
      the home directory, the root of the file system, and the projects root
      of the host or of a member (`holdsTooMuch`). The rule asks this before
      it reads the folder: the read of a home directory is not small.
      The codebase is made in the organization of the acting person
      (`organizationForNew`) with that person as its creator, as
      `codebaseSave` does.
    - **Before the plan of a worktree.** The launcher calls
      `SessionFolders.settleCodebase` before `SessionTaskFolders.plan`, so
      the plan reads the members of a codebase that the session takes.
    - **Before the first turn.** The prompt trigger attaches before the
      launch. The choice of the person is not known then, so the turn start
      reads the folders that were attached before it.
    - **The event.** `session_codebase` (§4) tells the clients. A session
      that takes or forms a codebase gets the `<codebase>` block with its
      name at its next turn start.
    - **The divider.** A formation in a session (rule 1a at a turn start,
      and rule 2) is also one activity of the session, `codebase_formed`,
      which the host stores as it stores a move into a worktree
      (`recordActivity`). The conversation shows it as a divider at the
      point where the codebase formed. A session that takes a codebase that
      exists (rule 1, or the codebase that a turn names) gets no divider,
      and a codebase that formed when a person added the folder has no
      session to show it in.
14. **A project is one folder, and a container is a codebase.** Stage 12
    let a project cover the repositories inside it. Stage 13 replaced that
    rule: a plain folder `~/shop` that holds `api` and `web` then showed as
    a project with the note "2 repositories", which is two names for one
    kind of thing.

    - **A project is one folder or one repository.** Solus does not look
      inside it. A repository that holds a nested repository is one project.
      A session with no codebase has one checkout.
    - **A container is a codebase.** A container is a folder that is not a
      repository itself and that holds two or more repositories, found with
      the discovery of §5 (one level down, one more inside a plain child
      folder, own `.git` directory, the skip rules, `ignoreRepositories`):
      `isContainer` in `files/codebase-members.ts`. A folder that holds one
      repository or none is a normal project.
    - **The record.** One root, the container folder, with the mark
      `container: true` (`CodebaseRoot`). The members of a container root
      are the folder and the repositories that the host finds inside it at
      each read, so a repository that is cloned into the folder later is a
      member. A root with no mark is one project: one member, and the host
      does not look inside it. A folder that is a container at the time that
      it becomes a root of any codebase gets the mark (`rootOf` on the host,
      `rootFor` on a client, from the scan).
    - **A live codebase has two or more roots, or a container root**
      (`hasEnoughRoots`), and no root is inside a different root of the same
      host. `saveCodebase` refuses each. A tombstone is exempt, so each
      delete moves. A stored record that is not deleted and has less is not
      a codebase: no read answers it. There is no migration for such a row.
    - **It forms by itself** (decision 13, rule 1a), with the name of the
      folder: (a) at a turn start of a session with no codebase whose
      project folder is a container; (b) when a person adds or opens the
      folder as a project. Each path that records a project for a person
      asks the rule (`formContainerCodebases`): `trackRecentProject` (Open
      project, the directory picker of the project chip, a session start),
      `setupCloneProject`, `setupAdoptProject`, `setupCreateProject`, and
      `projectConfigSave`. A new repository can also make a container of the
      project that holds it (a clone into `~/shop`, which had one
      repository): the folder above the new repository, and the one above
      that, are asked when the host lists them as projects. The host then
      sends `codebases.changed`, so each client shows the folder under
      Codebases immediately.
    - **A session there works in the container folder**, so a path between
      two of its repositories works. Its repositories are session folders
      with the source `codebase`. They are inside the working directory, so
      they need no grant. A new worktree session gets a task folder with a
      worktree of each chosen repository (§7).
    - **Never under Projects.** A folder that is the container root of a
      live codebase is in no project list of a client. The one rule is
      `isContainerRoot` in `packages/client-core/src/codebases.ts`. Desktop
      and web ask it where each list is built (`ProjectsStore.projectsFor`
      and `recentProjectsFor`, which the project chip, the palette, the
      sidebar filter, and the settings lists read), and mobile asks it in
      its project list (§10). The host keeps its own project row for the
      folder (its config, its last use).
    - **The clients follow.** New codebase takes one container folder, or two
      folders. A root can be removed only when the roots that stay are a
      codebase (the refusal `too-few`): the text says to delete the
      codebase. The rules are in `packages/client-core/src/codebases.ts`.

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
/** A codebase that is not deleted has at least this many roots, or one container root. One project is not a codebase. */
export const CODEBASE_ROOTS_MIN = 2
/** A folder that is not a repository is a container when it holds at least this many repositories. */
export const CONTAINER_REPOSITORIES_MIN = 2
/** A new worktree session isolates every repository only up to this many. */
export const CODEBASE_WORKTREE_DEFAULT_MAX = 8

export interface CodebaseRoot {
  /** The host the folder is on (decision 2). */
  installationId: string
  /** Absolute on that host. Never `~`. */
  path: string
  name: string
  /** The root is a container: the host reads the repositories inside it as members (decision 14). */
  container?: true
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

/**
 * One folder that a session record keeps besides its working directory (`session_records.attached_folders`).
 * `byName`: a person or the agent asked for it by its name (decision 8).
 */
export interface SessionAttachedFolder { path: string; source: SessionFolderSource; byName?: boolean }

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
| { kind: 'codebase_formed'; codebaseId: string; name: string }
```

When a rule made the codebase, `SessionFolders.takeCodebase` records this
activity with `SessionRuntime.recordActivity` (`formationActivity` in
`session-codebase-formation.ts`). `name` is the name at that time. A client
shows the name that the codebase has now, and this one when it has no record
of the codebase (stage 13: the record kept the folder names before, for a
line that named them). The author is the actor of the turn
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
at most `CODEBASE_ROOTS_MAX` roots, each path absolute, no root twice, and,
for a copy that is not deleted, two or more roots or a container root
(`hasEnoughRoots`) and no root inside a different root of the same host),
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
- A stored row that is not deleted, and has fewer than two roots and no
  container root, is not a codebase (decision 14): `listCodebases`,
  `getCodebase`, and `codebasesOfFolder` do not answer it. A tombstone can
  have each number of roots.

**Discovery** `packages/server/src/files/codebase-members.ts`:

- `membersOf(codebase, installationId)`: each root on this host, and, for a
  container root, the repositories inside it. A root with no container mark
  is one project: one member (decision 14).
- `isContainer(folder)`: the folder is no repository, and discovery finds two
  or more repositories inside it.
- Inside a container root it looks one level down, and one more level inside
  a child that is a plain folder (`src`, `packages`).
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
- `scanFolder(path)` gives the answer of a container root for one folder that
  is not in a codebase yet (the folder, then the repositories inside it),
  plus the `.code-workspace` suggestions. A client reads from it whether the
  folder is a container (`isContainerScan`). A suggestion is given
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
`nested`, `limit`, `missing`, and `too-few` for a removal that leaves fewer
than two roots and no container), `isLiveCodebase` (not deleted, two or more
roots or a container root), `nextUpdatedAt`, `rootFor` (which sets the
container mark from the scan of the folder), `codebasesHolding`, and
`isContainerRoot` (the one rule "a container root is never a project" of
each client).

Proof: unit tests for discovery on real temporary Git repositories (nested
repository, plain wrapper folder, submodule, linked worktree, ignored
repository, link out of the root, a root with no container mark, the
container rule), for the newest-wins save and the tombstone, and for
`mergeCodebases`.

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
  codebase on this host (source `codebase`; for a container root, the
  repositories that the host finds inside it: decision 14), less the working
  directory and the repository that the working directory is in, plus the
  attached folders of the session record. Before that, an attached folder in a temporary
  directory of the system that nobody asked for by name leaves the record
  (decision 8). An attached folder that is gone stays in the record and is left out
  of the list until the folder comes back. A root of the codebase that is
  gone (a temporary folder that the system deleted) is a member of state
  `missing`: it is not a session folder, it is not granted, and it is not in
  the prompt block, and the turn starts. A member and an attached folder in
  the data of Solus are left out also (decision 8). A member inside the working directory is a session folder (Git
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
  attached folder gets a block with
  no name: `<codebase>`, then the same lines. A session in one repository
  with no other folder gets no block.
- In a task folder, the line of the working directory has the name of the
  member that it stands in for.
- The block has a stable order, so an unchanged list does not change the
  system prompt.

**Attach.** `SessionFolders.attach(sessionId, path, source, actor)` adds a
folder with no rule: the path must be a directory that this actor may use as a
working directory (the same check that a new session passes; a member of an
organization stays in their own folder), and it must not be in the data of
Solus (decision 8). A person's own `sessionAttachFolder` calls it, with
`byName`. After the attach, a session with no codebase can get one when the
folder is a second project: a repository, or a folder in a listed project,
that is not in the project folder (decision 13, rule 2). The attached
folder is then a member, and its source is `codebase`. One function in front of it decides for an agent,
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
   file system, the home directory, and a folder in the data of Solus are
   refused (`invalid`).
4. A member of the session's codebase: attach, in each mode. In a task folder
   session the worktree of the repository stands in for it (§7).
5. A request that is not by name (each caller but the `attach_folder` tool,
   which sets `byName`): only a Git repository, or the project that the host
   lists and that holds the folder, is attached (`automaticAttachTarget`).
   A temporary directory of the system, a folder that cannot be read, and a
   folder that is in no project are refused (`invalid`), in each mode and
   before a card.
6. Mode `full-access` or `auto`: attach.
7. Other modes: a question card (`question_request`, answered through
   `answerToolQuestionWith`) with the choices of decision 8. Its
   `questionId` starts with `attach-folder-`, so the question card of each
   client shows it with no change. One card for one folder: a second request
   waits for the same answer, and a refused folder is not asked again in the
   turn (`refused`). With no way to show a card, or when the turn stops
   before the answer, the folder is not attached (`not-asked`). When the
   attach forms a codebase (`SessionFolders.formationOf`, which asks
   `formationFor`), the card has the question and the three choices of
   decision 8 for that case, with the proposed name.

"Allow and add to the codebase" writes the folder as a root of the session's
codebase on this host (`addCodebaseRoot`), with a newer `updatedAt`, so each
host takes the copy. "Allow and make the codebase" attaches the folder, and
the attach forms the codebase with the name that the person typed, else with
its plain name. "Allow for this session only" attaches the folder with no
formation (`AttachCodebase.sessionOnly`).

The triggers:

| Trigger | Where |
|---|---|
| A prompt that a person wrote names a directory on this host (`~/x`, an absolute path) in its typed text, or a file or a folder that the person pointed at with an `@` mention, in a project that is not a session folder | `prompt-dispatch.ts` (`attachNamedFolders`, with `prompt-paths.ts`), before the launch, in `submitPrompt` only, for a prompt with no sender and no `via`. Not in `promptSession` (a report, a message of an agent, a watch, a webhook), `createSession` (`start_sessions`, a headless session), `retry`, and `startUnattendedSession`. Only in `full-access` and `auto`; in card modes the agent asks with the tool. At most three folders for one prompt. Only a Git repository or a listed project is attached (decision 8). A file path in the text alone attaches nothing: a pasted log names many files. An attachment attaches nothing: the text that a client writes for a pasted or dropped file (`[Attached file: …]`, `[Attached image: …]`, `[Attached design-selection: …]`, and the `Annotated capture: …` line of a browser annotation) is not read for paths, because the file is where the system or the host put it. An `@` mention is the text `@path` or `@"a path"` that the mention picker writes: a path of the project is relative and is not read, and the real case is a file of a different project, which has an absolute path. |
| The agent calls `attach_folder({ path })` | New tool `agents/tools/folder-tools.ts`, `requiresApproval: false`; the rule above decides. |
| Claude asks permission for a path outside its folders (`blockedPath`) | `claude-permissions.ts`. A request that matched an ask rule of the person always shows its card. "Allow for session" also attaches the project of the path. In `auto`, for a path in a Git repository or in a listed project, the answer is allow with `updatedPermissions: [{ type: 'addDirectories', destination: 'session' }]`, and no card. For each other path nothing is attached, and the permission card of Claude shows. A path in a granted folder that the running query does not know gets the same answer when the mode asks nothing for the call in the working directory (a read in each mode, an edit in `accept-edits`). |
| Codex asks approval for a write outside the sandbox | `codex-backend.ts` `onServerRequest`. In `accept-edits` and `auto`, a request whose paths are all inside granted session folders is accepted with no card (Codex applies new `writableRoots` only at the next turn). `supervised` asks for each write, so its card stays. "Accept for session" also attaches. |
| A tool changed a file in a repository that is not a session folder (`full-access` asks nothing) | At turn end (`observed-writes.ts`), from the write tools of both providers (a shell command names no file): `source: 'observed'`, `granted: false`. For review only, so a folder with no repository is left out. A turn that stopped before its end is read at the next turn start. A later attach of the same path replaces the observed entry. |

Each trigger in the table but the tool is an automatic trigger (decision 8):
the prompt trigger and Claude in `auto` go through `requestAttach` with no
`byName`, and "Allow for session", the Codex approval, and the observed write
go through `SessionFolders.attachFolderOf`. Each asks
`automaticAttachTarget`. Thus "Allow for Session" on a read of a file in
`/tmp` or in `~/Downloads` allows the read, and the folder does not become a
session folder.

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
`add_to_codebase?: boolean` (default true). After success
(`SessionFolders.adoptCreated`): a new folder in the project folder of the
session gets no root and makes no codebase of two roots. In a container, the
read of the disk gives it as a member. In a project folder that held one
repository, the second repository makes the folder a container, and the next
turn start forms its codebase (decision 14). For a
folder outside the project folder: when it is not inside a root, add it as a
root of the session's codebase; then attach it with `source: 'created'`. In a
session with no codebase, that attach makes the codebase of the two folders
(decision 13, rule 2), and `addedToCodebase` is true. With
`add_to_codebase: false`, the folder is only attached. A folder that a
session folder holds already is not attached a second time. Their
descriptions no longer tell the agent to start a session to work there. The
result has `sessionFolder`, `addedToCodebase`, and, on a failure,
`sessionFolderError`.

**Cleanup.** Delete `additionalDirs` from `Session`, `SessionCtx`, the tab
snapshot, tab persistence, the factories, and `session-config.svelte.ts`.

Proof: unit tests for the folder resolution (member on this host, member on a
different host, working directory inside a root, attached folder kept across
turns, a root that is gone, a root in the data of Solus, a folder in a
temporary directory that leaves the record), for the attach rule in each of
the five modes, for a path in no project with each automatic trigger, for a
prompt that no person wrote, for the places that each automatic trigger
and a request by name are refused (with a temporary place that the test
gives, `SessionRuntimeOptions.temporaryPlaces`, because the folders of a test
are in the temporary directory of the system), for a prompt with an
attachment in each mode, for the prompt block (order, limits, unsafe names),
for `sandboxPolicyFor` with roots, and for the child order that carries the
codebase.

## 7. Stage 3 — the task folder

**When.** A new worktree session works in a task folder when it gets a worktree
of more than one repository, or when its working member is a plain folder. A
worktree session of one repository keeps today's worktree in
`<repo>/.git/solus/worktrees/<slug>`. Both are correct; only the first keeps
relative paths between repositories. The members of the plan are the
members of the session's codebase. A session with no codebase is in one
project, so it gets one worktree inside its repository (decision 14). The
first worktree session in a container `~/shop` that holds `api` and `web`
works in a task folder with both: the host forms the codebase of the
container before the plan. The project folder must be a member: in each
other case the plan is null (`SessionTaskFolders.plan`), and the session
gets one worktree inside its repository. The host settles the codebase of
the session before the plan (decision 13), so the plan reads the members of
a codebase that the session takes or that the host forms then.

**Which repositories.** `worktreeRepositories(run)` null: every `git` member
of the codebase on the run host when the worktrees to make are at most
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
  (`SessionTaskFolders.candidates`: the repositories of the codebase that
  have no worktree), then reads the folders of the session
  again and publishes them.
- The setup card of the launch shows sub-steps (`taskFolderStages`; stage
  13). Each step that the host runs one time for each repository (fetch the
  base branch, check out files with the copy of the included files, init
  submodules) has one sub-step for each repository
  (`StatusCardStep.substeps`), in the order of the repositories: its name,
  its state, and its times on the clock of the host. The sub-steps of a
  step show from the first report of that step, and the step is active
  until each repository ended it. A warning stays on the row of its
  repository. The repository that fails names the error on its own row
  (`TaskFolderProgress` reports `error`), and the step does not repeat it.
  A sub-step that ran at that time is an error with no message. A setup of
  one repository has no sub-steps, and its card is as before. A layout
  command reports no stage, so its card has no sub-steps. The card had one
  `checkout` step with the detail "web (2 of 3)" before.
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
  create (the form takes one container folder, or two folders:
  `newCodebaseDraft` in `lib/codebase-view.ts`. "Create codebase" is enabled
  when the first folder is a container, or when a second folder is chosen.
  A container that is the only folder gives the codebase its name when the
  person typed none), rename, delete, add and remove roots on any connected
  host (a root cannot be removed when the roots that stay are no codebase:
  the page says to delete the codebase), the members of each root with
  their state, the `.code-workspace` suggestions with an Add button. The
  open codebase is the route param `codebase` of the settings route. The
  palette has "Open codebases" and "New codebase" (`codebaseCommands`). A
  delete is one tombstone that the store saves on each host with
  `codebaseSave`. `addRoot` scans the folder again, so the path in the
  record is the resolved path of the host and a container gets its mark,
  and it refuses a folder that is in the codebase, a folder that is inside
  a folder of the codebase or holds one, a folder that is `missing`, and a
  root above the limit. A change that no host saves is taken back from the
  list.
- **The naming setting.** The Codebases page has the section "Names" with
  the row "Codebase names" (`codebaseNaming`: "Generated name", the
  default, or "From the folder names"), with the row, the select, and the
  policy note of the "Branch names" row. The project override "Codebase
  names for this project" is in Settings → Source control, beside the
  branch names of the project (`ProjectCodebaseNamingSetting.svelte`): "Your
  setting", or one of the two ways. It is saved in `.solus/config.json`.
- **Never under Projects.** `ProjectsStore.projectsFor` and
  `recentProjectsFor` leave out a folder that is the container root of a
  live codebase (decision 14). Each project list reads them: the project
  chip, the palette, the sidebar filter, the settings lists, the directory
  picker. The store keeps the row that the host has for the folder, so a
  path inside the container still names its project key. The rule comes
  from the codebases store through `contexts/codebases/container-rule.ts`:
  the projects store is loaded by code that does not load the connection
  stores of the app.
- **Start.** The project chip has one choice: a run is in a project, or it
  is in a codebase (`chipAtRest` in `input/lib/codebase-choice.ts`). A run
  that has a codebase shows the codebase: the chip shows one name, the name
  of the codebase, with the favicons of its folders, and the list marks the
  row of the codebase and no row of the Projects group (`marksProjectRow`).
  A run with no codebase shows the project, and the list marks its project
  row and no row of the Codebases group. The chip never shows the two names.
  A choice of a codebase sets `codebaseId`. The folder of the run stays when
  the codebase holds it; else the run opens the first root of the codebase
  on the run host (`codebaseChoiceStep`). A choice of a container codebase
  opens the container folder, also for a run in one of its repositories: a
  session of a container works there (decision 14). The list has no step
  that asks which root: a row of the Projects group is how a person changes
  the working folder inside a codebase. A codebase with no root on the run
  host says so and lists the hosts that have one; a choice moves the run to
  that host. A project folder that is in exactly one codebase on its host
  starts with that codebase, decided one time for each folder, so "No
  codebase" stays the person's choice
  (`input/lib/codebase-start.svelte.ts`). A folder that no codebase holds is
  not decided: the host forms the codebase of a container when the folder
  is opened, and the record can arrive after the draft is there. The
  decision is in memory, for each tab and folder. Thus a choice of a project
  row inside a codebase shows that codebase on the chip. "No codebase" is
  the one way to a project-only run in such a folder. It is offered only
  while the run has a codebase.
  The Git dropdown
  gets the repositories of the new worktree (`input/lib/worktree-repositories.ts`
  has the rule of `planTaskFolder`) and, for a plain working member, the base
  branch. The list is the members of the codebase of the run. A run with no
  codebase is in one project, so it has no list. A Git answer for a folder
  with no repository keeps the base branch that the person named
  (`adoptGit`).
- **Running session.** The project panel has no Repositories card
  (changed in stage 12; `docs/project-panel.md`). Its content is in the two
  cards that the panel has:
  - **Git card: the repositories.** A session can work in more than one
    repository: the repository of its working directory, and each `git`
    session folder. The card then shows one row for each (its name, its
    branch, its changed-line counts, and the worktree icon for an isolated
    worktree), as it shows one row for each other linked pull request, where
    a choice of a row brings that pull request into the group
    (`lib/git-repositories.ts`, `GitRepositories.svelte`). The Git rows
    (branch, commit and push, changes, pull request, discard) work in one
    repository at a time: the chosen one. The repository of the working
    directory is chosen at first. The chosen row has `aria-current` and the
    wash of an open control (`MenuRow`'s `current`). The choice is in the
    view state of the conversation (`ConversationViewState.gitRepositoryPath`),
    so it survives a tab switch. A long list folds (stage 13): the card
    shows four rows, then "Show N more", as it folds its other linked pull
    requests (`foldGitRepositoryRows`). The chosen row always shows: when it
    is after the fourth row, it takes the place of the fourth. The fold is
    in the view state also (`ConversationViewState.gitRepositoriesExpanded`),
    and a row that the fold hides reads no Git state. There is one mounted
    Git section, aimed at
    the chosen repository with its `folder` prop (`GitCard.svelte`). With one
    repository the card has no repository rows. "Add repository…" of a task
    folder session reads `sessionWorktreeCandidates` when its menu opens. A
    working directory with no repository that holds repositories is a
    container, thus a codebase: the card lists the `git` session folders,
    and the first one is chosen. The Changes row opens the diff panel
    on the chosen repository (`showRepositoryDiff`).
  - **Environment card: one row, and the folders in its menu** (stage 13;
    the card had one row for each folder before). The card shows one name on
    its project row: the name of the codebase for a session in a codebase,
    else the name of the project (`lib/project-row.ts`). The caret of the
    project row opens a menu with one section for each folder
    (`lib/environment-folders.ts`, `environmentMenu`;
    `EnvironmentFoldersMenu.svelte`): the working folder, then each session
    folder in the order of the host, then each folder of the codebase on a
    different host. The heading of a section has the name of the folder,
    the host mark of the project row, and the state ("No repository", "Not
    attached", "Offline", "Not connected", "Missing"). A section of the run
    host has "Open in Solus" and the file manager of the host, then the
    options of the folder: Open terminal, Attach to this session or Detach
    from this session, Add to <codebase>, Track with Git. The working
    folder has "Track with Git" only when it holds repositories. A folder
    on a different host has the child sessions that work there as its
    items, each one time. "Add folder…" is the last item of the menu. It
    attaches a folder that the person chooses (the directory picker intent
    `choose-folder`). A session with one folder has one section with no
    heading and no "Open terminal" (the row "Open in" of the card has it),
    so its menu is the menu of a session with one project. A draft has that
    menu also. The panel item `environment.folders` is removed.
  The palette has "Add folder to this session" and "Open codebase settings"
  (`project-panel/lib/repository-commands.ts`). The diff
  panel gets a repository picker beside the scope picker. `lib/changedFiles.ts`
  makes a path relative to the longest session folder that holds it.
- **No offer.** The first plan had an offer "Make a codebase" in the
  panel, for a session with no codebase that got its second folder. The
  host makes that codebase now (decision 13, rule 2), so the offer and its
  code are removed. In each state where the host makes none (a tombstone
  with the same roots, "No codebase", a folder that the host only observed,
  an attached folder that is no repository and is in no listed project), the
  person said no, or the disk shows no second project of the work: they make
  a codebase in Settings.
- **The event.** On `session_codebase` the reducer gives the run of the tab
  the codebase (`chooseCodebase`).
- **The divider.** The `codebase_formed` activity is a divider of the
  conversation (`ActivityDivider`, with `TranscriptDivider` as each other
  divider): "Made codebase <name>", for example "Made codebase solus", in
  the grammar of the other dividers ("Continued in worktree fix-login",
  "Continued with Claude"), with no end period. Stage 13 made it short: it
  was "Made the codebase <name> from the folders <folder> and <folder>".
  The name is the one that the codebase has now
  (`codebasesStore.codebaseOf`), because the generated name arrives after
  the formation and a person can rename the codebase; the recorded name
  shows when this client has no record (`conversation/lib/codebase-divider.ts`).
  The name has the accent, and the divider is a button that opens Settings
  → Codebases on that codebase. It has no Undo: the delete of a codebase is
  on that page. A formation at a turn start (a container, or a folder that
  the prompt trigger attached before the first turn) is recorded while the
  bubble of the prompt is on screen, so the reducer puts the divider before
  that prompt, where a history read puts it. A toast said this before. A
  toast is gone after a reload and shows on one client only, so it was
  removed with its Undo and Open actions
  (`contexts/codebases/formed-codebase.ts`).
- **A deleted codebase.** When the store says that the codebase of a run is
  deleted (`codebasesStore.isDeleted`), the strip clears the codebase of the
  run (`useCodebaseStart`), also for a started session.
- **Before the first prompt.** A draft does not scan its folder (stage 13
  removed `readFolder` and `projectScanAt`): a run with no codebase is in
  one project, and a container is a codebase in the store, so the start
  control reads the members of that codebase. "No codebase" is
  `refuseCodebase`: the run sends `noCodebase`. It is offered only while the
  run has a codebase.
- **Project picker.** The Codebases group lists only the codebases of the
  store, and a container root is in no list of the Projects group, so no
  name shows two times. No row has a count (stage 13 removed each "N
  repositories" note). A row of the Codebases group shows the favicons of
  its folders in place of a generic icon: a small stack of at most three
  (`CodebaseFavicons.svelte`, with `ProjectFavicon`; a container shows the
  favicons of the repositories that its host found, and its own folder
  before that read). Its only note is "No folder on this host" or "No
  folder on a connected host". The details are in a tooltip, on the row and
  on the chip of a codebase run (`CodebaseTooltip.svelte`,
  `codebaseTooltip`): the name, then one line for each folder with the name
  of its host ("Unknown host" for a host that this client does not know),
  at most eight, then "and N more". The chip tooltip starts with "Change
  the project for this chat" and its shortcut, and ends with "Works in
  <folder> on <host>." (`chipHint`). The tooltip primitive draws its `value`
  as one line, so these lines are its children, as each other tooltip with
  more than one fact.
- **Git card of a container.** A container is a codebase, so a started
  session has its repositories as session folders, and the Git card lists
  them. The card of a draft whose working directory is no repository lists
  the `git` members of its codebase on the run host (`codebaseMembersOn`,
  `useDraftRepositoryReads`), and a draft with no codebase has no
  repository rows. In a draft the rows show what the session gets, and a
  row opens the files of its repository. "Track with Git" for the container
  itself is in the section of the working folder, in the menu of the
  project row of the Environment card.
- **Environment section.** The project row shows the name of the codebase of
  the run as its label, with the codebase icon, and the host in its trailing
  slot (`lib/project-row.ts`).
- **Git in a session folder.** The Git section, its branch row, the commit
  composer, and the publish dialog take a `folder`: the repository that the
  person chose in the Git card. The Git store reads that
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
- **Repositories and codebases of a project.** `src/solus/ProjectCodebases.tsx`
  shows, on the Solus project page (`ProjectSettings`), one "Repositories"
  section for the repositories that the host found in the project folder
  (the T3 Code model: a project and the repositories found inside it), then
  one group of sections for each codebase that holds the project folder: the
  folders on the host, the folders on other hosts, "Add folder", "Rename
  codebase", "Delete codebase", and "Make a codebase". "Make a codebase"
  stays: it is the way to make a codebase by hand, as Settings → Codebases
  is on desktop. It asks for the second folder with T3's Local folder
  screen, then for the name, and then makes the codebase of the two
  folders. `src/solus/codebase-folders.ts` and
  `codebase-rows.ts` give the T3 section its data.
- **Start.** `src/solus/DraftWorkspaceControls.tsx` has the codebase of the
  draft, the choice of a new worktree, and its repositories. The first
  prompt of the run carries `codebaseId` and `worktreeRepositories`. The
  draft reads its project folder (`solus.codebases.readFolder`), and the
  repositories control lists the repositories that the host found in it
  (`projectScanAt`), then the members of the codebase of the draft. "No
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
  session folders for `ThreadRepositoryRows` and the Git sheets. A
  repository of the project (source `project`) is a row with no mark, as a
  member of the codebase is. A sheet of a
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
(the repositories of the Git card and the folders of the Environment card),
`docs/projects.md` and `docs/solus-tools.md` (the
project tools and `attach_folder`), `docs/plans/session-pull-requests.md` (one
`branch` row for each repository), the Codebase Map and the glossary in
`AGENTS.md` (the new modules and words), and `docs/database-schema.md` (the
two tables and the two columns).

## 11a. Stage 8 — a codebase forms by itself

Decision 13 has the rules. The parts:

- **Host.** `execution/sessions/session-codebase-formation.ts` has the rules
  that take or make a codebase (`codebaseOfProjectFolder`,
  `codebaseForAttachedFolder`) and `projectFolderOf`. `SessionFolders` decides
  which session has no codebase (`hasCodebase`), calls the rules
  (`settleCodebase` at a turn start, `formForAttached` after an attach),
  writes the session record, records the `codebase_formed` activity of a
  formation, and publishes `session_codebase`.
  `run-launcher.ts` calls `settleCodebase` before the plan of a new worktree.
- **Desktop and web.** §9, from "No offer" to "Environment section".
- **Mobile.** §10, "Start" and "The event".

Proof: `tests/unit/session-codebase-formation.test.ts` (each rule on real
folders and repositories, the name, the lock, the tombstone, "No codebase",
the special folders, the event and its replay, the prompt block, the first
worktree session, and the divider: written one time on a formation, not
written for a codebase that exists, and at its place in the history that a
reload reads), `tests/unit/codebase-formed-divider.test.ts` (the text of the
divider and its place on the client, live and after a reload),
`tests/unit/codebase-formation-client.test.ts` (the reducer, the scan of the
project folder of a draft, the start members, the Environment row), and the
added cases in `project-chip-codebases.test.ts`,
`native-mobile-session-folders.test.ts`, and the mobile
`codebases-model.test.ts`.

## 11b. Stage 12 — two folders, a real project, and no Repositories card

The maintainers used the feature in the running app and decided three
changes.

- **The model** (replaced in stage 13: §11c). A project covered the
  repositories inside it with no codebase (`project-members.ts`, the session
  folder source `project`). The rule that made a codebase from one folder
  was removed, with the draft state for it on the clients
  (`formsCodebaseFor`, `newCodebaseAt`, the note "New codebase"). A live
  codebase had two or more roots, and no root inside a different one. A
  codebase that the host made had both folder names.
- **The automatic attach** (decision 8). `automaticAttachTarget` attaches
  only a Git repository or a listed project, the prompt trigger reads only a
  prompt that a person wrote, and a turn start removes an attached folder in
  a temporary directory that nobody asked for by name.
- **The project panel** (§9, "Running session"). The Repositories card, its
  section id, its show and hide entry, and the palette entry "Show
  repositories" are removed. The Git card has the repositories, and the
  menu of the project row of the Environment card has the folders (stage
  13).

Proof: `tests/unit/codebases-store.test.ts` (two roots, no nested root, a
stored record with one root), `session-codebase-formation.test.ts` (a project
covers its repositories, the name, the first worktree session of a plain
folder with no codebase after it), `session-task-folders.test.ts` (a session
with no codebase adds a repository of its project),
`session-folder-attach.test.ts` and `attach-target.test.ts` (a path in no
project, a prompt that no person wrote, `promptSession`),
`session-folders.test.ts` (the cleanup at a turn start),
`codebases-client-store.test.ts`, `project-chip-codebases.test.ts`,
`git-card-repositories.test.ts`, `environment-folders.test.ts`,
`repository-commands.test.ts`, and the mobile `codebases-model.test.ts`.

## 11c. Stage 13 — a container is a codebase, short names, and less text

The maintainers reviewed renderings of the feature and decided these
changes. Each one is a decision.

- **The model** (decision 14). A project is one folder or one repository.
  `project-members.ts`, the session folder source `project`, and each
  reader of them are removed. A container (a folder that is no repository
  and holds two or more repositories) is a codebase with one root that has
  the mark `container`: `isContainer` and `membersOf` in
  `files/codebase-members.ts`, `hasEnoughRoots` in the contract and in
  `saveCodebase`, `containerCodebaseOf` and `formContainerCodebases` in
  `session-codebase-formation.ts` (a turn start, and each path that records
  a project for a person). No project list of a client shows a container
  root (`isContainerRoot`).
- **Names** (decision 13). A codebase of two projects forms with a plain
  name and gets a short generated name after it
  (`execution/sessions/codebase-name.ts`, `renameFormed`). The personal
  setting `codebaseNaming` and the project key of the same name choose the
  way. The attach card says when the attach forms a codebase, and the person
  can name it there (decision 8, `session-folder-attach.ts`).
- **Desktop and web** (§9). The divider is "Made codebase <name>" with the
  name that the codebase has now. The rows of the project picker have no
  count, a codebase row has the favicons of its folders, and the details are
  in a tooltip. The Environment card shows one name, and the menu of its
  project row has one section for each folder of the session. The
  repository rows of the Git card fold after four. The worktree setup card
  has one sub-step for each repository.
- **Mobile** (§10). Fewer sections, rows, and sentences, in the upstream
  patterns.

Proof: `tests/unit/codebase-members.test.ts` (a container root, a root with
no mark, `isContainer`, a new clone), `codebases-store.test.ts` (one
container root is a codebase, one project is not),
`session-codebase-formation.test.ts` (the container rule at a turn start and
when the folder is added, a clone into a listed project, the tombstone, one
repository inside, the plain name, the generated name that arrives later,
an answer that is no name, a rename by a person, the setting, a name from
the card), `session-folder-attach.test.ts` (the card of an attach that forms
a codebase: its text, its three choices, the typed name),
`session-folders.test.ts`, `session-task-folders.test.ts` and
`task-folders.test.ts` (the task folder of a container, the sub-steps),
`projects-store.test.ts` (a container root is in no project list),
`codebases-client-store.test.ts` (a container from a scan, the removal
rule), `codebases-settings.test.ts` (the New codebase form, the naming
setting), `project-config-file.test.ts` (`codebaseNaming`),
`project-chip-codebases.test.ts` (no counts, favicons, the tooltip, the
choice of a container), `codebase-formed-divider.test.ts` (the short line
with the current name), `environment-folders.test.ts` and
`git-card-repositories.test.ts` (the menu sections and the fold),
`setup-card-substeps.test.ts`, and the mobile tests of §10.

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
| §6 | The prompt trigger attaches for each path that the prompt names | Only a directory in the typed text, or a file from an `@` mention; at most three. An attachment attaches nothing | A pasted log in `full-access` or `auto` attached many folders. A pasted screenshot attached the temporary folder of the system, and a codebase formed from it |
| §3, §6 | Each trigger attaches each folder but the root of the file system and the home directory | An automatic trigger attaches no temporary directory of the system and no folder that cannot be read. No request attaches a folder in the data of Solus | A path that Solus only read is not a request to work there, and the data folder holds the database and the secrets of the host |
| §3 | The attach rule of decision 13 (rule 2 now) forms a codebase from each attached folder | Only from a Git repository or a folder in a listed project, that is not in the project folder | A folder of that kind is a real second folder of the work. Each later session of the project gets the folders of the codebase |
| §3 | A tombstone that has the project folder as a root stops each formation for that folder | A tombstone stops only the codebase with the same set of roots | The delete of a wrong codebase must not stop a correct one |
| §6 | Claude: a path in a granted folder is always allowed with no card | Only when the mode asks nothing for that call in the working directory | Decision 8: edits in an attached folder follow the mode |
| §6 | Codex: a write in a granted folder is accepted with no card | Only in `accept-edits` and `auto` | `supervised` asks for each write, also in the working directory |
| §6 | The attach rule is in `session-folders.ts` | It is in `session-folder-attach.ts` | The file was above the review limit |
| §7 | The owner is a class `TaskFolders` with `plan`, `create`, `restore`, `remove` | Functions `planTaskFolder`, `createTaskFolder`, `restoreTaskFolder`, `removeTaskFolder`, and `findTaskFolderContaining` | One name for one concept; the module has no state besides the table |
| §7 | A `startFromOrigin` option for a task folder | No option | `createWorktree` has one rule for the start commit; a second rule makes the two kinds of worktree start from different commits |
| §7 | The default limit counts the other repositories | It counts the working member when that is a repository | The constant says "isolates every repository only up to this many" |
| §7 | A task folder for each worktree session of several repositories | Only when the project folder is a member of the session: of its project (stage 12), or of its codebase | A plan needs the list of the repositories of the session |
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
| §3 | Decision 12: a session with no codebase is unchanged, and only a person makes a codebase | The host gives a session the codebase of its project folder, or makes one from a second project that is attached (decision 13) | The main cases needed a manual step before a session could work in two folders |
| §9 | The Repositories section offers "Make a codebase" | No offer | The host makes that codebase when the second folder is attached |
| §9 | The Git section of a folder with no repository says to set up Git | The Git card of a folder that holds repositories lists them (stage 12) | The folder is the place of several repositories, not a project that lacks one |
| §3 | A session keeps the codebase id of a deleted codebase | Such a session is a session with no codebase, and the tombstone stops a new one with the same roots | A person can delete the codebase that the host made |
| §9 | A toast says that the host made a codebase, with Undo and Open | A divider in the conversation, stored as the `codebase_formed` activity | A toast is gone after a reload and shows on one client. The delete is on the page of the codebase |
| §9 | The project chip shows the project and, beside it, the codebase; its list marks one row in each group | One choice: the chip shows the codebase of a run that has one, else the project, and the list marks one row | Two names and two marks for one place did not say where the run is |
| §9 | A codebase with several roots on the run host asks which one | It opens the first root; a project row changes the folder | One list with one step |
| §3 | Decision 13, rule 2: a project folder that holds a repository forms a codebase with one root | Removed. A project covers the repositories inside it with no codebase (decision 14), with the session folder source `project` | The picker showed one name as a project and as a codebase |
| §3, §5 | A codebase has one or more roots | A live codebase has two or more roots, and no root inside a different root of the same host. A stored record with fewer is not read | One folder is a project. A project is never also a codebase |
| §3 | A codebase that the host makes has the name of the project folder | It has the names of its two roots, joined: `solus + solus-cloud` | A codebase with the name of the project reads as the project |
| §7 | A session with no codebase gets no task folder | It gets one from the repositories of its project | The plan reads the members of the session: its project and its codebase |
| §3, §6 | An automatic trigger attaches each folder but the refused places | Only a Git repository or a project that the host lists | A sentence that named `~/Downloads`, and one blocked read there, attached the full folder |
| §6 | The prompt trigger runs in `submitPrompt`, `promptSession`, and `createSession` | In `submitPrompt` only, for a prompt with no sender and no `via` | The report of a different session attached a directory that it named |
| §4 | An attached folder of a record is `{ path, source }` | It also has `byName`, and a turn start removes an attached folder in a temporary directory that has no such mark | The record kept the temporary folder that an earlier rule attached. A folder that a person asked for must stay |
| §9 | The project panel has a Repositories section | Removed. The Git card lists the repositories and works in the chosen one, and the Environment card lists the folders | The maintainers did not want a new card: the Git card has a precedent for more than one item |
| §9 | A row of the Repositories section mounts a second Git section below it | One Git section, aimed at the chosen repository | No second copy of the Git rows |
| §9 | The chip of a draft shows the note "New codebase", and the Codebases group has a row "New" | Removed | The host makes no codebase from one folder |
| §9 | New codebase asks for one folder | Two folders, and a root cannot be removed while two are left | A codebase has two or more folders |
| §10 | "Make a codebase" on mobile makes a codebase of the project folder | It asks for the second folder first | A codebase has two or more folders |
| §10 | The project page on mobile shows the found repositories only in the section of a codebase | One Repositories section for the project, then one section for each codebase (stage 12; replaced in stage 13) | A project covered its repositories with no codebase |
| §3 | Stage 12: a project covers the repositories inside it, with the session folder source `project` | Removed in stage 13. A project is one folder or one repository, and a container is a codebase with one root that has the mark `container` | A project with the note "2 repositories" and a codebase are two names for one kind of thing |
| §3, §5 | A live codebase has two or more roots | Two or more roots, or one container root | A container is a codebase by itself |
| §5 | Each root gives the repositories inside it as members | Only a container root does. A root with no mark is one member | A project is one folder: Solus does not look inside it |
| §3 | A codebase forms only at a turn start, or from an attach | The codebase of a container forms also when a person adds or opens the folder as a project | The picker must show it immediately |
| §3 | A codebase that the host makes has the names of its two roots, joined (stage 12) | A plain name at once (the common start of the folder names, else the first name and a count), then a short generated name, unless the setting or the project says "from the folder names" | `solus + solus-cloud` was long, and it was no name of the work |
| §3 | The attach card has the same choices with and without a codebase | When the attach forms a codebase: "Allow and make the codebase" with a name that the person can change, "Allow for this session only", "Do not allow" | The attach changes each later session of the project, so the person decides it and names it |
| §4 | The `codebase_formed` activity keeps the folder names | It keeps the id and the name of that time | The divider names only the codebase |
| §9 | The divider says "Made the codebase <name> from the folders <a> and <b>" | "Made codebase <name>", with the name that the codebase has now | It was longer than each other divider, and the generated name arrives after the formation |
| §9 | Rows of the project picker have "N repositories" notes | No count. A codebase row has the favicons of its folders, and a tooltip with each folder and its host | A count is noise on a row, and the details are one hover away |
| §9 | A draft scans its project folder (`readFolder`, `projectScanAt`) | Removed | A run with no codebase is in one project, and a container is a codebase in the store |
| §9 | The Environment card has one row for each folder, and the folders on other hosts below them (stage 12) | One name on the project row, and one section for each folder in the menu of that row | A session of five folders made the card long, and the card must say one thing: where the session is |
| §9 | The Git card has one row for each repository | Four rows at most, then "Show N more". The chosen repository always shows | A codebase can have many repositories |
| §7 | The setup card has one checkout step for all repositories, with "web (2 of 3)" | One sub-step for each repository below each step that runs one time for each repository | The detail did not say which repository ran, waited, or failed |
