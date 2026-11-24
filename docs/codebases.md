# Codebases

A codebase is a named set of folders that one piece of work covers: two or
more projects, or one folder that holds two or more repositories. The
folders can be on one host or on more than one host. With a codebase, one
session can read, change, review, and commit in more than one repository on
its host, and the agent knows which folders of the work are on a different
host.

A codebase does not replace a project. A project is one folder or one
repository on one host ([Projects](projects.md)). A project is never also a
codebase. A session still has one working directory.

The design and the decisions are in [the plan](plans/codebases.md).

## Words

| Word | Meaning |
|---|---|
| **codebase** | A named set of folders, on one or more hosts, that one piece of work covers: two or more projects, or one container. |
| **container** | A folder that is not a repository and that holds two or more repositories. A container is a codebase, not a project. |
| **root** | A folder that you or Solus put in a codebase: a host and an absolute path on that host. |
| **member** | A folder that a codebase covers on one host: each root, and each repository that the host finds inside a container. |
| **member state** | `git` (a Git repository), `plain` (a folder with no repository), or `missing` (the folder is not there). |
| **session folder** | A folder that one session works in besides its working directory: a folder of its codebase, or a folder that was attached. |
| **attach** | To add a session folder to a running session. |
| **task folder** | The folder that a worktree session of more than one repository works in. |

## A folder that holds repositories is a codebase

A folder that is not a repository itself and that holds two or more
repositories is a container, for example `~/shop` with `~/shop/api` and
`~/shop/web`. A container is a codebase with the name of the folder
(`shop`). It is not a project, so no project list shows it: it is in the
**Codebases** group of the project picker only.

Solus makes that codebase by itself:

- When you add or open the folder as a project (**Open project**, the
  folder picker, a clone into the folder). The picker shows it immediately.
- At the first turn of a session that works in the folder, for example a
  session that an agent started.

A session in a container works in the container folder, so a path from one
of its repositories to a different one works. Each repository inside it is a
session folder:

- The agent is told about each repository, and to commit each one
  separately.
- Each repository has its own diff, its own Git actions, and its own pull
  request ([Review](#review)).
- A new worktree session gets a worktree of each repository
  ([Worktree sessions](#worktree-sessions)).

The host finds the repositories at each turn start
([Folders that Solus finds](#folders-that-solus-finds)), so a repository
that you clone into the folder later is in the next turn.

A folder that holds one repository or none is a normal project. A
repository is one project also when it holds a different repository: Solus
does not look inside a project.

Solus makes no such codebase for a chat, for your home folder, for the root
of the file system, for the projects folder of the host, and for a guest of
a shared session. When you delete the codebase of a container, Solus does
not make it again, and the folder is a project again.

## When a codebase helps

A codebase helps when one piece of work changes more than one repository, or
folders on more than one host:

- A folder that holds the repositories of one product, for example `~/shop`
  with `api` and `web`.
- A repository and a library that it uses, in a different folder.
- Two projects that change together, for example `~/solus` and
  `~/solus-cloud`.
- A service on a laptop and its infrastructure on a server.

Solus makes the codebase for the first three cases by itself. For folders on
a different host, make the codebase in Settings.

## How a codebase forms

You do not have to make a codebase before you start. The project folder of
a session is the repository that the session works in, or the working
directory when that is a folder with no repository. For a session in a
worktree, it is the original folder.

At each turn start, for a session that has no codebase:

1. **One codebase holds the project folder.** The session takes that
   codebase. When more than one codebase holds the folder, the session takes
   none, and Solus makes none.
2. **The project folder is a container.** Solus makes the codebase of the
   container, and the session takes it
   ([A folder that holds repositories is a codebase](#a-folder-that-holds-repositories-is-a-codebase)).

When a folder is attached to a session that has no codebase:

3. **Solus makes a codebase from the two folders**, when the attached folder
   is a second project: a Git repository, or a folder in a project of the
   host. Its roots are the project folder and the attached folder. This
   applies to a folder that you attached, that the agent attached, that you
   allowed on a card, and that a project tool made. Thus a session in
   `~/solus` that is told to change `~/solus-cloud` makes a codebase, and the
   next session in `~/solus` starts with the two folders. For a folder that
   Solus only saw a write in (**Not attached**), Solus makes the codebase
   only when the folder is in a project of the host.

Solus makes no codebase from one project. It makes none from a folder that
is inside the project folder, and none from a folder that holds the project
folder.

A different folder that is attached (a folder of notes, a folder with no
repository that is not a project) stays a folder of that session only, and
Solus makes no codebase from it. You can add it to a codebase in Settings.

When the session has a codebase already, an attached folder stays a folder of
that session only. Its menu offers **Add to** with the name of the codebase.

### The name

A container codebase has the name of its folder.

A codebase that Solus makes from two projects gets a name in two steps:

1. It forms at once with a plain name: the common start of the folder names
   when that has three or more characters (`solus` for `solus` and
   `solus-cloud`), else the first folder name and a count (`api +1`). When a
   codebase has that name, Solus adds a number: `solus 2`.
2. A small model then gives it a short name of one to three words, for
   example **Solus Platform**, and that name replaces the plain one. The
   session does not wait for it. The model reads the names of the folders
   and the first lines of the README of each folder. It is the model that
   writes session titles (**Settings → Models**), on your own sign-in.

The generated name never replaces a name that you gave. You can rename a
codebase in Settings at each time.

**Settings → Codebases → Codebase names** chooses how Solus names a codebase
that it makes:

| Choice | Result |
|---|---|
| **Generated name** (the default) | The two steps above. |
| **From the folder names** | The plain name stays. No model names the codebase. |

A project can override this in **Settings → Source control → Codebase names
for this project**. The choice is saved as `codebaseNaming` in the
`.solus/config.json` file of the project, so you can commit it:

```json
{
  "codebaseNaming": "folders"
}
```

### The line in the conversation

When Solus makes a codebase in a session, the conversation shows a divider
at that point: "Made codebase solus". The line shows the name that the
codebase has now, so it changes when the generated name arrives and when you
rename the codebase. The divider is a part of the conversation: it is there
after a reload, and each client that opens the session shows it at the same
place. A session that starts with a codebase that exists shows no divider.

Select the divider to open the page of the codebase in Settings. **Delete
codebase** on that page is the way back. No file is deleted.

### Your "no" is kept

After you delete a codebase, Solus does not make a codebase with the same
folders again. It can still make a codebase with a different set of folders:
when you delete a codebase of `~/solus` and a wrong folder, a session in
`~/solus` that attaches `~/solus-cloud` makes the codebase of those two
folders. You can also make each codebase by hand. **No codebase** on the
project chip does the same for one session
(see [Start a session in a codebase](#start-a-session-in-a-codebase)).

### When Solus makes none

Solus makes no codebase for a chat, for your home folder, for the root of
the file system, for the projects folder of the host, and for a guest of a
shared session.

The rule is on the host, so it applies to each client, to a session that an
agent starts, and to an automation.

## Make and edit a codebase

Open **Settings → Codebases** (group Code). The command palette has **Open
codebases** and **New codebase**.

### Make a codebase

1. Select **New codebase**.
2. Type a name.
3. Below **First folder**, choose the host, then select **Choose folder** and
   choose the first folder. The page reads the folder and shows what it
   found, for example "A folder with no repository of its own. 2
   repositories were found inside it."
4. When the first folder holds two or more repositories and is no repository
   itself, it is a codebase by itself: **Create codebase** is available, and
   the name of the folder is used when you typed no name. In each other
   case, choose a second folder below **Second folder**. It can be on a
   different host. A folder that is the first folder, is inside it, or holds
   it is refused.
5. Select **Create codebase**.

After that, the page of the codebase shows its folders for each host. Use it
to:

- Rename the codebase.
- Add a folder with **Add folder**. A folder that is in the codebase already,
  a folder that is inside a folder of the codebase or holds one, and a folder
  that does not exist are refused. A codebase has at most 128 folders.
- Remove a folder with **Remove**. No file is deleted. **Remove** is not
  available for a folder when the folders that stay are no codebase (fewer
  than two, and none that holds repositories). The page then says: "A
  codebase has at least 2 folders, or one folder that holds repositories. To
  remove this folder, delete the codebase."
- Delete the codebase with **Delete**. The codebase is deleted on each host.
  No file is deleted.

One folder can be in more than one codebase.

### Folders that Solus finds

You add roots only. A root that is a container (a folder with no repository
of its own that holds two or more repositories) gets a mark when you add it.
Each host reads its disk and finds the repositories inside each such root. A
repository that you clone into it is found on the next read. A root that is
a repository, or a folder that holds one repository or none, is one project:
the host does not look inside it.

- The host looks one level below a container root. It looks one more level inside a
  child folder that is not a repository, for example `src` or `packages`.
- A repository is a folder whose `.git` is a directory. A linked worktree and
  a submodule have a `.git` file, so they are not found.
- The host does not look in folders whose name starts with a dot, or in
  `node_modules`.
- A link (a symbolic link) that goes to a place outside the root is not
  followed.

The page shows the state of each folder (**Git repository**, **Folder**, or
**Missing**) and the repositories found in it. A found repository can have
the mark **No commit** or **Submodule**.

You can add a linked worktree or a submodule as a root. It is then a member
with the state `git`.

### Leave a repository out

To leave a repository out of a container, write its path in
`ignoreRepositories` in the `.solus/config.json` file of the root. Each path
is relative to the root. A path also covers the repositories below it.

```json
{
  "ignoreRepositories": ["archive", "vendor/legacy-api"]
}
```

### A workspace file

When a root holds a `.code-workspace` file, the page lists the folders
outside the root that the file names and that exist. Each one has an **Add**
button. Solus does not add these folders by itself.

### Folders on other hosts

A root names its host. To add a folder on a different host, choose that host
in the folder picker. The host must be connected.

Each host keeps the full record of each codebase. Your client sends the
newest copy to each connected host that has an older one. A delete moves the
same way. Thus a host that was not connected gets the change when it
connects again.

The page shows a note for a host that this client cannot read:

- A host that is not connected shows its last answer with **Not current**.
- A host that is not on this device keeps its folders in the codebase, but
  the page cannot read them.

### A folder with no Git repository

A folder with no repository is a member. The agent can read and change its
files. It has no diff, no branch, and no Git actions.

To make a repository there, start a session that has the folder, open the
**Environment** section of the project panel, open the menu of the project
row, and select **Track with Git** in the section of the folder. The host runs `git init` in the
folder. The folder is then a repository of the **Git** section, with a
branch and a diff.

When the working directory of a session is a container, the **Git** section
of the project panel does not ask you to set up Git. It lists the
repositories, and its Git rows work in the one that you choose. **Track with
Git** for the folder itself is in the section of the working folder, in the
menu of the project row of the Environment section.

## Start a session in a codebase

The project chip above the composer has one choice: the session starts in a
project, or it starts in a codebase.

- A run that has a codebase shows the codebase: the chip shows the name of
  the codebase with the icons of its folders, and the list marks the row of
  that codebase. No row of the **Projects** group has a mark.
- A run with no codebase shows the project: the chip shows the name of the
  project, and the list marks the row of that project. No row of the
  **Codebases** group has a mark.

The chip never shows the two names. The chip of a run that has a codebase
does not show the folder that the session works in. The tooltip of the chip
does, and so does the Environment section of the project panel.

The list has two groups, **Projects** and **Codebases**. A folder that is a
container is in the Codebases group only, so no name shows two times.

A row of a codebase shows the icons of its folders as a small stack (at most
three), then its name. A container shows the icons of its repositories. No
row shows a count. Hold the pointer on a row of a codebase, or on the chip
of a run that has one, to see the details: the name, then each folder with
the name of its host.

- Select a codebase to start the session with it.
- When the project folder is in the codebase already, the folder stays.
- A container codebase opens its container folder, also when the run is in
  one of its repositories: a session of a container works in that folder.
- When the project folder is not in the codebase, the first folder of the
  codebase on the host of the run becomes the project folder. The list has
  no step that asks which folder.
- When the codebase has no folder on the host of the run, its row says "No
  folder on this host". A second step lists the folders by host. Choose one,
  and the run moves to that host.
- A codebase with no folder on a connected host says "No folder on a
  connected host" and cannot be chosen.

**A project in a codebase.** Select a row of the Projects group to work in
that folder. When exactly one codebase holds the folder, the session starts
with that codebase, so the chip then shows the codebase and the list marks
its row. This is how you change the folder that the session works in, inside
a codebase.

**The automatic choice.** When the project folder is in exactly one codebase
on its host, the session starts with that codebase. You do no extra step.
When the folder is in more than one codebase, the chip shows **Choose
codebase** beside the project.

**No codebase.** When the run has a codebase, the group has **No codebase**.
Select it to start the session with no codebase. The automatic choice does
not put the codebase back for that folder, and the host makes no codebase and
takes none for that session. To take the choice back, select the row of a
codebase.

A session that has a codebase keeps it. A session that started with no
codebase gets one later when a folder is attached to it
([How a codebase forms](#how-a-codebase-forms)).

## What the agent can reach

At each turn start, the host reads the codebase and the disk, and gives the
agent:

- The working directory.
- Each member of the codebase that exists on the host of the session, as a
  session folder. For a container, these are the repositories that the host
  finds inside it.
- Each folder that is attached to the session.

The agent also gets a short text in its instructions. The text names each
folder on this host and each root on a different host, with the name of that
host. The text tells the agent to run Git inside the repository that it
changes, and to commit each repository separately.

A session changes only the folders on its own host. To change a folder on a
different host, the agent starts a session on that host with
`start_sessions`. That session starts with the same codebase: the host of the
first session sends the record with it. No tool moves the work of a session
to a different host, and no tool clones a member to the host of the session
by itself.

The Environment section of the project panel shows the folders on other
hosts, and the sessions that the agent started there
([Project panel](project-panel.md#repositories-and-folders)).

## Attach a folder in a running session

To attach is to add a session folder to a running session. There are three
ways:

- **You attach.** In the Environment section of the project panel, open the
  menu of the project row, select **Add folder…**, and choose a folder on
  the host of the session. The command palette has **Add folder to this
  session**. A folder that you attach needs no card. You can attach each
  folder but the refused places below.
- **The agent asks.** The agent calls the `attach_folder` tool with a path.
- **Solus attaches automatically.** See the triggers below.

### Which folder is attached

A path names the folder to attach:

- A path in a Git repository attaches the root of that repository.
- A path to a folder that is in no repository attaches that folder.
- A path to a file that is in no repository attaches the folder of the file.

The root of the file system and your home folder cannot be session folders.
The data folder of Solus (`~/.solus`, and the data folder of the desktop app)
and the files that clients uploaded to the host cannot be session folders
also. A task folder and the folder of a chat are not refused, although
Solus keeps them in its data folder.
A path that is in the working directory or in a session folder is available
already, so nothing is attached.

**Solus attaches by itself only a real project.** An automatic trigger
attaches a Git repository, or the project of the host that holds the path.
For a path in a subfolder of such a project, it attaches the project. For
each other path, for example a file in `~/Downloads`, it attaches nothing:
the agent then asks permission for that one call, as it does in a session
with one folder. You or the agent can still attach such a folder by name:
with **Add folder…**, or with the `attach_folder` tool.

A temporary folder of the system (`/tmp`, `/var/folders`, the temporary
folder of your user) and a folder that cannot be read are attached only by
name also. At the start of a turn, Solus removes from a session a temporary
folder that an automatic trigger attached before this rule. A different
folder that was attached that way, for example `~/Desktop`, stays until you
detach it ([Detach a folder](#detach-a-folder)).

### The rule for each permission mode

| Mode | A member of the codebase of the session | A different folder |
|---|---|---|
| Full access | Attached. No card. | Attached. No card. |
| Auto | Attached. No card. | Attached. No card. |
| Supervised | Attached. No card. | A card asks you. |
| Accept edits | Attached. No card. | A card asks you. |
| Plan | Attached. No card. | A card asks you. |

The card has the title **Attach folder** and these choices:

| Choice | Result |
|---|---|
| **Allow for this session** | The folder becomes a session folder. |
| **Allow and add to the codebase** | The folder becomes a session folder and a root of the codebase of the session. This choice shows only when the session has a codebase. |
| **Do not allow** | The agent does not get the folder. Solus does not ask again for that folder in the same turn. |

When the session has no codebase and the folder is a second project (a Git
repository, or a folder in a project of the host), an allowed attach makes a
codebase ([How a codebase forms](#how-a-codebase-forms)). The card then says
so, and it has these choices:

| Choice | Result |
|---|---|
| **Allow and make the codebase** | The folder becomes a session folder, and Solus makes the codebase of the project folder and this folder. The choice shows the name that the codebase gets. To give a different name, type it in the answer field of the card before you send the choice. |
| **Allow for this session only** | The folder becomes a session folder. No codebase is made. |
| **Do not allow** | The agent does not get the folder. |

A codebase that you named on the card keeps that name: no generated name
replaces it.

One card is for one folder in one session. After you allow a folder, reads
and edits in it follow the permission mode, as in the working directory
([Permission modes](plans/permission-modes.md)).

When the path is in a root of the codebase on a different host, and it does
not exist on this host, the tool attaches nothing. It tells the agent the
host, and to start a session there.

### The automatic triggers

| Trigger | What Solus does |
|---|---|
| A prompt that you wrote names a folder on the host in its text (`~/x` or an absolute path), or names a file or a folder with an `@` mention | In Full access and Auto, Solus attaches the project of that path before the turn starts. One prompt attaches at most three folders. In the other modes, the agent asks with `attach_folder`. A file that you paste or drop into the prompt attaches nothing: an attachment is not a request to work in a folder. A prompt that you did not write attaches nothing: the report or the message of a different session, the prompt of an automation, and a message that Solus made. |
| Claude asks permission for a path outside its folders | In Auto, when the path is in a project, Solus attaches the project and allows the call with no card. On a permission card, **Allow for Session** also attaches the project. For a path in no project, the card of Claude answers for that call, and nothing is attached. |
| Codex asks approval for a write outside its sandbox | In Accept edits and Auto, Solus accepts the write with no card when each path is in a session folder. An approval for the session also attaches the project of each path. |
| A file tool of the agent changed a file in a repository that is not a session folder | At the turn end, the repository shows in the Git section and in the Environment section of the project panel with **Not attached**. The agent was not given the folder. Select **Attach to this session** in the section of that folder, in the menu of the project row of the Environment section, to give it. |

### Detach a folder

In the Environment section of the project panel, open the menu of the
project row, find the section of the folder, and select **Detach from this
session**. You can detach a folder
that was attached and a folder that a project tool made. A member of the
codebase cannot be detached: remove it from the codebase in Settings. A
folder whose attach made the codebase of the session is a member of that
codebase. A repository of a container is a member also.

### When the agent gets the folder

A folder that is attached in the middle of a turn is a session folder
immediately. Each provider gets its folders when a turn starts, so the turn
of the attach has these rules:

- **Claude.** A call in the new folder runs with no card when the mode asks
  nothing for that call in the working directory: a read in each mode, and an
  edit in Accept edits, Auto, and Full access.
- **Codex.** Codex can read the folder, and a write there needs an approval.
  In Accept edits and Auto, Solus gives that approval with no card. In
  Supervised, each write asks, as in the working directory.

## Worktree sessions

A new worktree session can get a worktree of more than one repository: the
repositories of its codebase. Those worktrees are in one folder, the task
folder.

### When a session gets a task folder

A new worktree session works in a task folder when all of these are true:

- The session has a codebase, and its project folder is a folder of that
  codebase on the host of the session. The first worktree session in
  `~/shop`, a container that holds `api` and `web`, gets a task folder with
  the two: Solus makes the codebase of the container before it makes the
  worktrees.
- More than one repository gets a worktree, or the project folder is a folder
  with no repository.

A session with no codebase is in one project, so it gets one worktree.

In each other case the session gets one worktree inside its repository, as
before ([Agent worktrees](worktree-names.md#agent-worktrees)).

### Which repositories get a worktree

Open the branch chip and select **New worktree**. The menu shows
**Repositories with a worktree**: the working folder, then each other
repository of the codebase on the host, with a check.

- With no choice from you, each repository gets a worktree when the session
  has at most eight repositories that can get one. The working repository is
  in that count. Above eight, no other repository gets a worktree unless you
  choose it.
- A row with **Submodule**, **No commit**, or **Other drive** cannot be
  chosen. A submodule comes with the worktree of its parent repository.

A repository that gets no worktree is not a session folder of that
session. The session stays isolated: it does not reach the shared
checkout of that repository.

### The task folder

The task folder is in the Solus data folder of the host:
`<data folder>/solus-task-folders/<branch name>-<8 hex digits>`. For a member
of an organization on a shared host, it is in the folder of that member. The
data folder is never inside a repository.

The task folder stands in for the deepest folder that holds the working
folder and each chosen repository. Each worktree is at the same relative
place as its repository, so a relative path between two repositories also
works between their worktrees.

```text
On the disk                      Task folder
~/shop/            (no .git)     <data folder>/solus-task-folders/fix-login-1a2b3c4d/
  README.md                        README.md   link to ~/shop/README.md
  api/             (.git)          api/        worktree, branch fix-login
  web/             (.git)          web/        worktree, branch fix-login
```

In this example the project folder is `~/shop`, and the session works in the
task folder itself.

### The setup card

While the host makes the worktrees, the conversation shows the setup card.
For a task folder, each step that runs one time for each repository (fetch
the base branch, check out files, init submodules) has one row for each
repository below it, with the name of the repository, its state, and its
time. A repository that fails names its error on its own row. A session
with one repository has no such rows.

### One branch name

Each worktree of a task folder is on a branch with the same name. Solus
chooses a name that is free in each repository, and adds a number to the name
when it is not free.

- Each repository starts from the base branch when it has that branch. A
  repository that does not have it starts from its default branch.
- When Solus names the branch from your first prompt, it renames the branch
  in each repository or in none. It does not rename a branch that was pushed.
- The branch row of a worktree in a task folder cannot switch branches.

### A folder with no repository becomes links

When the project folder has no repository, its place in the task folder is a
real folder that holds a link to each file and folder of the original. Only
the folders on the way to a repository are real folders. A repository is
never linked.

**An edit of a linked file changes the original for every session.** The
start control and the Environment section of the project panel say so.

A new worktree of a folder with no repository needs a base branch. The branch
chip shows **This folder**, and the start control has a **Base branch**
field. With no base branch, the host makes no worktree, and the session works
in the folder itself.

### Add a repository to a running session

In a session that works in a task folder, the Git section of the project
panel has **Add repository…**. It lists the repositories of the codebase of
the session that have no worktree in the task folder and that can get one.
Select one, and the host makes its worktree on the branch of the session.

The agent can do the same: `attach_folder` on a repository of the codebase
gives the session the worktree of that repository, and makes the worktree
when there is none.

A session that works in one worktree inside its repository cannot get a
second repository. Start a new worktree session.

### When a task folder is removed

- The agent leaves the task folder with `move_checkout` and asks to remove
  it. A worktree with uncommitted changes stays, and so does a file that
  exists only in the task folder. Solus tells the agent what stayed. A task
  folder that a different session works in stays.
- At the start of the host, a task folder that no session names is removed.
  A worktree with uncommitted changes stays.

If a worktree or the working folder of a task folder is deleted outside
Solus, the host puts it back at the next turn start.

### Layout commands

A project can make and remove the worktrees with its own commands. Put
`worktreeLayout` in the `.solus/config.json` file of the folder that the
session works in (the project folder):

```json
{
  "worktreeLayout": {
    "create": "./scripts/make-worktrees.sh",
    "remove": "./scripts/remove-worktrees.sh"
  }
}
```

`create` replaces the built-in layout. `remove` is optional. Each command
runs through the shell (`sh -c`, or `cmd.exe` on Windows) in the project
folder, with these environment variables:

| Variable | Value |
|---|---|
| `SOLUS_CODEBASE_ROOT` | The project folder: the folder that the session works in, as it is on the disk. |
| `SOLUS_WORKTREE_ROOT` | The task folder. Solus made it already. |
| `SOLUS_WORKTREE_PRIMARY_PATH` | The folder in the task folder that stands in for the project folder. It becomes the working directory of the session. |
| `SOLUS_WORKTREE_BRANCH` | The branch name of the session. |
| `SOLUS_WORKTREE_BASE` | The base branch. Empty when the session named none, for `remove`, and when `create` runs again to put back a worktree. |
| `SOLUS_WORKTREE_REPOSITORIES` | The repositories that get a worktree, one path for each line. |

What `create` must do:

- Make `SOLUS_WORKTREE_PRIMARY_PATH` a folder.
- Make each checkout as a linked worktree of its repository
  (`git worktree add`) on the branch `SOLUS_WORKTREE_BRANCH`.
- Put the worktree of each repository at the same place from
  `SOLUS_WORKTREE_PRIMARY_PATH` as the repository is from
  `SOLUS_CODEBASE_ROOT`.
- When the project folder is a repository, make its worktree at
  `SOLUS_WORKTREE_PRIMARY_PATH`.

After the command, Solus looks in the task folder at the place of each
repository of the codebase that is inside the folder that the task folder
stands in for. A checkout there must be a linked worktree of that repository
on the branch. If one is not, or if the command fails, Solus
removes all that the creation made. The command can also make the worktree of
a repository that was not chosen.

Other rules:

- A command can run for ten minutes. The commands of one project folder run
  one at a time.
- With a layout command, Solus copies no `.worktreeinclude` files and makes
  no links.
- `remove` runs first when Solus removes the task folder, and after a
  creation that failed. Solus then removes what the command left.
- `create` runs again when Solus puts back a missing worktree.

## Review

### The repositories of the Git section

The project panel has no card of its own for repositories. When a session
works in more than one repository, the **Git** section starts with one row
for each: the repository of the working directory, then each session folder
that is a repository, with the branch and the line counts of that checkout.
Select a row to choose that repository. The Git rows of the section then
work in it. The list shows four rows at most: **Show N more** opens the
rest, and the chosen repository always shows. See
[Project panel](project-panel.md#repositories-and-folders).

### The folders of the Environment section

The project row of the Environment section shows one name: the name of the
codebase of the run, else the name of the project. Its trailing slot marks
the host.

The arrow of the project row opens a menu with one section for each folder
of the session: the working folder, then each session folder, then the
folders of the codebase on other hosts. The heading of a section has the
name of the folder, its host, and its state (**No repository**, **Not
attached**). Each section has **Open in Solus**, which opens the files pane
at that folder, and the options of the folder. On the desktop app, for a
session on this machine, a section also has **Open in Finder** and **Open
terminal**. **Add folder…** is the last item of the menu.

### The repository picker of the diff panel

When a session has more than one repository, the diff panel has a
**Repository** picker beside the scope picker. It lists the working
directory, then each session folder that is a repository.

- Each scope (changes, uncommitted, session, or one turn) reads the chosen
  repository.
- A session folder has a turn only when that turn changed it.
- When you change the repository, a selected turn stays selected if the other
  repository has that turn. If not, the panel shows the session scope.
- The Guide and the Lens read the working directory, so they do not show
  while the panel reads a session folder.

A file of a session folder is named by its path from the working directory,
for example `../api/src/handler.ts`. Comments and the changed-files card use
that name, so two repositories never give one file the same name. When more
than one repository has changes, the changed-files card shows one row for
each repository. Select a row to open the diff panel on that repository.

### Git actions for one repository

Select the row of a repository at the top of the Git section. The Git rows
below the list (branch, commit and push, changes, pull request, discard, and
merge conflicts) then work in that repository only. The session stays in its
working directory. The repository of the working directory is chosen at
first, and your choice stays when you go to a different tab and come back.

One Git action is in one repository. To commit in two repositories, commit in
each one.

### Pull requests

The Git rows of the chosen repository have the pull request row of that
repository. Solus also finds the pull request of a branch by itself, and a
session keeps one found pull request for each repository. For a session
folder, Solus looks only at a folder that a turn of the session changed, and
at a worktree of the session. A folder that the session only reads is not
looked up on the code host.

## New projects

The agent tools `create_project` and `clone_project` make a new folder on the
host of the session ([Projects](projects.md#agent-tools)). After the call:

- The new folder becomes a session folder, so the agent can work there in the
  same session. No card shows: you approved the tool call.
- A new folder inside the project folder makes no codebase of two folders:
  it is a part of that project. In a container, it is a repository of the
  container at once. When the project folder held one repository, the second
  one makes the folder a container, and the next turn makes its codebase.
- For a new folder outside the project folder: when the session has a
  codebase, the new folder also becomes a root of the codebase. It does not
  when the call has `add_to_codebase: false`, or when a root of the codebase
  holds the folder already.
- For a new folder outside the project folder, in a session with no
  codebase: Solus makes one from the project folder and the new folder
  ([The name](#the-name)). It makes none when the call has
  `add_to_codebase: false`.

The result of the tool has `sessionFolder` and `addedToCodebase`.

## Mobile

The mobile app has the same capability in its own screens.

| Thing | Where it is on mobile |
|---|---|
| The repositories of a project | The settings of a project show one **Repositories** section with the repositories that the host found inside the project folder. A project with no repository inside it has no such section. |
| The codebases of a project | After that, the settings show one section for each codebase that holds the project folder: the folders on the host, then the folders on other hosts. **Add folder**, **Rename codebase**, and **Delete codebase** are there. A project that is in no codebase has **Make a codebase**: it asks for the second folder, then for the name, and makes the codebase of the two folders. |
| The codebase of a new session | A folder in exactly one codebase gives the draft that codebase. A folder in more than one adds a **Codebase** control with each codebase and **No codebase**. A folder in no codebase starts with none, and the session gets the repositories of its project. |
| The repositories of a new worktree | The workspace controls of the draft have a repositories control. A submodule and a repository with no commit show as rows that you cannot choose. The control lists the repositories that the host found in the project folder, then those of the codebase. |
| The session folders | The Git overview of a session lists one row for each session folder. A row opens the Git sheet of that repository. |
| Folder actions | The Git sheet of a session folder has **Track with Git** for a folder with no repository, **Attach** for a folder that the agent was not given, and **Detach** for an attached folder. |
| Add a repository | In a task folder session, the list of other repositories comes from the host, and a choice makes the worktree. |
| The linked folder | The Git overview shows a **Linked folder** text when the working directory holds links to a folder with no repository. |
| Review | The review sheet joins the changes of each repository that has changes. |
| The attach card | The card shows as a normal question. |

Differences on mobile:

- A new worktree of a folder with no repository has no base branch field.
  Each repository starts from its default branch.
- A row of a session folder shows its branch and the number of changed files,
  with no line counts.
- "Make a codebase" chooses the second folder on the host of the project.
  Add a folder on a different host after that, with **Add folder**.
- The conversation shows no divider when Solus makes a codebase. To delete
  the codebase, use **Delete codebase** in the settings of the project.
- A draft shows the project in its heading. It shows the codebase only when
  more than one codebase holds the folder, in the **Codebase** control.

The mobile app has no project panel.

## Limits

**Hosts**

- A session changes only the folders on its own host. For a folder on a
  different host, the agent starts a session there.
- No tool clones a member to a host that does not have it.
- Each host keeps its own copy of a codebase. A copy moves only when a client
  that has it is connected to the host, or when `start_sessions` starts a
  session on that host. There is no copy in the account.
- A guest of a shared session does not see or change codebases.

**The codebase of a session**

- A session that has a codebase keeps it. You cannot give a started session
  a different codebase.
- The automatic choice is kept in memory on the client. After a restart of
  the client, a draft with **No codebase** for a folder that is in exactly
  one codebase gets that codebase again.
- **No codebase** is kept with the run on the client that chose it, and that
  client sends it with each message. The host keeps it only while it runs.
  After a restart of the host, a message from a different client, or from an
  agent, can give the session a codebase.
- A session in one repository of a container that has no codebase yet (a
  session of the project `api` in `~/shop`, when nobody opened `~/shop`)
  stays a session of that project. Solus makes the codebase of a container
  only when the container folder is added, opened, or worked in.
- A folder that held one repository becomes a container when it gets a
  second one. A session that runs there gets the codebase at its next turn.
- The generated name needs a model that the host can run on your sign-in.
  With none, the plain name stays. The host asks one time, when the codebase
  forms.
- In the project picker, a folder that is a container on one host shows
  under Codebases only when your client has read the codebases of that
  host. Before that read, it can show as a project for a moment.
- A stored codebase with one folder that is no container, from an earlier
  version, is not shown and is not used.

**Discovery**

- A host looks two levels below a container at most. A repository that is
  deeper is not a member: attach it by name.
- A host looks inside a root only when the root has the container mark. A
  root gets the mark when it is added. A folder that becomes a container
  after it was added as a root of a codebase of two projects does not get
  the mark by itself: remove the folder and add it again.
- A codebase has at most 128 roots.

**Attach**

- The prompt trigger works only in Full access and Auto, for at most three
  folders in one prompt, and only for a prompt that a person wrote. It does
  not run for a retry, for a message from a different session, or for a
  session with nobody present.
- An automatic trigger attaches only a Git repository or a project of the
  host. In Auto, a read of a file in a different folder (`~/Downloads`) shows
  a permission card for that call.
- The record of a session does not say who asked for a folder that was
  attached before this rule. Such a folder stays until you detach it, but
  for a temporary folder of the system, which Solus removes.
- A pasted or dropped file attaches no folder. In Auto, a read of such a file
  in a temporary folder of the system can show a permission card, because
  Solus does not attach that folder automatically.
- A codebase that has a temporary folder as a root keeps that root until you
  remove it. When the system deletes the folder, the sessions of the codebase
  do not get it, and the codebase page shows it as **Missing**.
- Solus sees only the writes of the file tools of the agent. A write that a
  shell command makes is not observed.
- A folder with no repository is never shown as **Not attached**, because it
  has no diff to review.
- The observed write is the tool call, so an edit that was refused can still
  show its repository as **Not attached**.
- Codex gets its writable folders at a turn start. A write in a folder that
  was attached in the same turn needs an approval.

**Worktrees and task folders**

- Without a choice, the repositories get worktrees only when there are at
  most eight, the working repository counted.
- A repository with no commit, a submodule, and a repository on a different
  drive from the working folder get no worktree.
- A session in one worktree inside its repository cannot get a second
  repository.
- An edit of a linked file changes the original for every session.
- A write to a linked file under a Codex sandbox is refused. Claude asks
  permission for the real path of the file.

**Review**

- Solus has no file rewind. Codebases add none.
- One Git action is in one repository. There is no commit and no push across
  repositories in one action.
- The keyboard shortcuts for commit and push and for sync work in the working
  directory.
- The Guide and the Lens read the working directory only.
- A folder that was attached in the middle of a turn shows, for that turn,
  the files written after the turn started. A file that was deleted in that
  turn is not in the diff of that turn.
- A turn that changed only a session folder gets no changes card below the
  turn.
- On a row of a change summary, the "open file" mark can be wrong when two
  repositories have a file with the same relative path.
- After a restart of the host, Solus looks for the pull request of a session
  folder again at the next turn end of its session.

**A session on a different host**

- A session that is copied to a different host loses the snapshots and the
  diffs of its session folders there. Session sync, the session archive, and
  code bundles read the working directory only. The uncommitted code of a
  session folder is not copied.
- An attached folder in the session record is a path on the first host.
