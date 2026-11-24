# Codebases

A codebase is a named set of folders that one piece of work covers. The
folders can be on one host or on more than one host. With a codebase, one
session can read, change, review, and commit in more than one folder on its
host, and the agent knows which folders of the work are on a different host.

A codebase does not replace a project. A project is one folder on one host
([Projects](projects.md)). A session still has one project and one working
directory.

The design and the decisions are in [the plan](plans/codebases.md).

## Words

| Word | Meaning |
|---|---|
| **codebase** | A named set of folders, on one or more hosts, that one piece of work covers. |
| **root** | A folder that you or Solus put in a codebase: a host and an absolute path on that host. |
| **member** | A folder that a codebase covers on one host: each root, and each repository that the host finds inside a root. |
| **member state** | `git` (a Git repository), `plain` (a folder with no repository), or `missing` (the folder is not there). |
| **session folder** | A folder that one session works in besides its working directory. |
| **attach** | To add a session folder to a running session. |
| **task folder** | The folder that a worktree session of more than one repository works in. |

## When a codebase helps

A codebase helps when one piece of work changes more than one folder:

- Two repositories in one folder, for example `~/shop/api` and `~/shop/web`.
- A repository and a library that it uses, in a different folder.
- A service on a laptop and its infrastructure on a server.

Solus makes the codebase for the first two cases by itself. For folders on a
different host, add the folder to the codebase in Settings.

## How a codebase forms

You do not have to make a codebase before you start. The host of a session
gives a session that has no codebase the codebase of its project folder. The
project folder is the repository that the session works in, or the working
directory when that is a folder with no repository. For a session in a
worktree, it is the original folder.

At each turn start, in this order:

1. **One codebase holds the project folder.** The session takes that
   codebase. When more than one codebase holds the folder, the session takes
   none, and Solus makes none.
2. **The project folder holds a repository.** When no codebase holds the
   folder, and the host finds one or more repositories inside it, Solus makes
   a codebase with one root: the project folder. Thus a session in `~/shop`,
   a folder with no repository that holds `api` and `web`, has the two
   repositories as session folders at its first message.
3. In each other case, the session stays with no codebase.

When a folder is attached to a session that has no codebase:

4. **Solus makes a codebase from the two folders.** Its roots are the
   project folder and the attached folder. This applies to a folder that you
   attached, that the agent attached, that you allowed on a card, and that a
   project tool made. Thus a session in `~/solus` that is told to change
   `~/solus-cloud` makes a codebase, and the next session in `~/solus` starts
   with the two folders. For a folder that Solus only saw a write in (**Not
   attached**), Solus makes the codebase only when the folder is in a
   project of the host.

When the session has a codebase already, an attached folder stays a folder of
that session only. Its row offers **Add to** with the name of the codebase.

**The name.** The codebase has the name of the project folder. When a
codebase has that name, Solus adds a number: `shop 2`, `shop 3`. You can
rename it in Settings.

**The line in the conversation.** When Solus makes a codebase in a session,
the conversation shows a divider at that point. The divider names the folders
that the codebase was made from: "Made the codebase shop from the folder
shop", or "Made the codebase solus from the folders solus and solus-cloud".
A codebase that Solus makes at the start of a turn shows its divider before
the prompt of that turn. The divider is a part of the conversation: it is
there after a reload, and each client that opens the session shows it at the
same place. A session that starts with a codebase that exists shows no
divider.

Select the divider to open the page of the codebase in Settings. **Delete
codebase** on that page is the way back. No file is deleted.

**Your "no" is kept.** After you delete a codebase that has a folder as a
root, Solus makes no codebase for that folder again. You can still make one
by hand. **No codebase** on the project chip does the same for one session
(see [Start a session in a codebase](#start-a-session-in-a-codebase)).

**When Solus makes none.** Solus makes no codebase for a chat, for your home
folder, for the root of the file system, for the projects folder of the host,
and for a guest of a shared session.

The rule is on the host, so it applies to each client, to a session that an
agent starts, and to an automation.

## Make and edit a codebase

Open **Settings → Codebases** (group Code). The command palette has **Open
codebases** and **New codebase**.

### Make a codebase

1. Select **New codebase**.
2. Type a name.
3. Choose the host, then select **Choose folder** and choose the first folder.
   The page reads the folder and shows what it found, for example "A folder
   with no repository of its own. 2 repositories were found inside it."
4. Select **Create codebase**.

After that, the page of the codebase shows its folders for each host. Use it
to:

- Rename the codebase.
- Add a folder with **Add folder**. A folder that is in the codebase already,
  and a folder that does not exist, are refused. A codebase has at most 128
  folders.
- Remove a folder with **Remove**. No file is deleted.
- Delete the codebase with **Delete**. The codebase is deleted on each host.
  No file is deleted.

One folder can be in more than one codebase.

### Folders that Solus finds

You add roots only. Each host reads its disk and finds the repositories
inside each root. A repository that you clone into a root is found on the
next read.

- The host looks one level below the root. It looks one more level inside a
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

To leave a repository out of a codebase, write its path in
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
**Repositories** section of the project panel, open the menu of the row, and
select **Track with Git**. The host runs `git init` in the folder. The row
then shows a branch, and the folder has a diff.

When the working directory of a session is a folder with no repository that
holds repositories, the **Git** section of the project panel does not ask you
to set up Git. It shows one row, for example "2 repositories in this folder".
Select the row to open the Repositories section. **Track with Git** for the
folder itself is in the menu of that row.

## Start a session in a codebase

The project chip above the composer has one choice: the session starts in a
project, or it starts in a codebase.

- A run that has a codebase shows the codebase: the chip shows the name of
  the codebase with the codebase icon, and the list marks the row of that
  codebase. No row of the **Projects** group has a mark.
- A run with no codebase shows the project: the chip shows the name of the
  project, and the list marks the row of that project. No row of the
  **Codebases** group has a mark.

The chip never shows the two names. The chip of a run that has a codebase
does not show the folder that the session works in. The tooltip of the chip
does, for example "Works in api on Laptop", and so does the Environment
section of the project panel.

The list has two groups, **Projects** and **Codebases**. A row of a codebase
that has a folder on the host of the run shows how many repositories the
codebase covers there, for example "2 repositories".

- Select a codebase to start the session with it.
- When the project folder is in the codebase already, the folder stays.
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

**A new codebase.** When the project folder is in no codebase and holds
repositories, the chip shows the project with the note **New codebase**.
Solus makes this codebase when you send the first prompt. Until then the run
is in the project, so the list marks the row of the project. The Codebases
group has a row with the name of the folder and the note "New", with no mark.
The control for the
repositories of a new worktree works from the repositories that the host
found, before the codebase exists.

**No codebase.** When the run has a codebase, or gets a new one, the group
has **No codebase**. Select it to start the session with no codebase. The
automatic choice does not put the codebase back for that folder, and the host
makes no codebase and takes none for that session. To take the choice back
for a new codebase, select its row.

A session that has a codebase keeps it. A session that started with no
codebase gets one later when a folder is attached to it
([How a codebase forms](#how-a-codebase-forms)).

## What the agent can reach

At each turn start, the host reads the codebase and the disk, and gives the
agent:

- The working directory.
- Each member of the codebase that exists on the host of the session, as a
  session folder.
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

The project panel shows the folders on other hosts, and the sessions that the
agent started there ([Project panel](project-panel.md#repositories)).

## Attach a folder in a running session

To attach is to add a session folder to a running session. There are three
ways:

- **You attach.** In the Repositories section of the project panel, select
  **Add folder…** and choose a folder on the host of the session. The command
  palette has **Add folder to this session**. A folder that you attach needs
  no card.
- **The agent asks.** The agent calls the `attach_folder` tool with a path.
- **Solus attaches automatically.** See the triggers below.

### Which folder is attached

A path names the folder to attach:

- A path in a Git repository attaches the root of that repository.
- A path to a folder that is in no repository attaches that folder.
- A path to a file that is in no repository attaches the folder of the file.

The root of the file system and your home folder cannot be session folders.
A path that is in the working directory or in a session folder is available
already, so nothing is attached.

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

One card is for one folder in one session. After you allow a folder, reads
and edits in it follow the permission mode, as in the working directory
([Permission modes](plans/permission-modes.md)).

When the path is in a root of the codebase on a different host, and it does
not exist on this host, the tool attaches nothing. It tells the agent the
host, and to start a session there.

### The automatic triggers

| Trigger | What Solus does |
|---|---|
| Your prompt names a folder on the host (`~/x` or an absolute path), or names a file with an `@` mention or an attachment | In Full access and Auto, Solus attaches the folder before the turn starts. One prompt attaches at most three folders. In the other modes, the agent asks with `attach_folder`. |
| Claude asks permission for a path outside its folders | In Auto, Solus attaches the folder and allows the call with no card. On a permission card, **Allow for Session** also attaches the folder. |
| Codex asks approval for a write outside its sandbox | In Accept edits and Auto, Solus accepts the write with no card when each path is in a session folder. An approval for the session also attaches the folder. |
| A file tool of the agent changed a file in a repository that is not a session folder | At the turn end, the repository shows in the Repositories section with **Not attached**. The agent was not given the folder. Select **Attach to this session** in the menu of the row to give it. |

### Detach a folder

In the Repositories section, open the menu of the row and select **Detach
from this session**. You can detach a folder that was attached and a folder
that a project tool made. A member of the codebase cannot be detached: remove
it from the codebase in Settings. A folder whose attach made the codebase of
the session is a member of that codebase.

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

A new worktree session of a codebase can get a worktree of more than one
repository. Those worktrees are in one folder, the task folder.

### When a session gets a task folder

A new worktree session works in a task folder when all of these are true:

- The session has a codebase. Solus makes one before it makes the worktrees,
  when the project folder holds repositories
  ([How a codebase forms](#how-a-codebase-forms)).
- The project folder is a member of the codebase on the host of the session.
- More than one repository gets a worktree, or the project folder is a folder
  with no repository.

In each other case the session gets one worktree inside its repository, as
before ([Agent worktrees](worktree-names.md#agent-worktrees)).

### Which repositories get a worktree

Open the branch chip and select **New worktree**. The menu shows
**Repositories with a worktree**: the working folder, then each other
repository of the codebase on the host, with a check.

- With no choice from you, each repository gets a worktree when the codebase
  has at most eight repositories that can get one. The working repository is
  in that count. Above eight, no other repository gets a worktree unless you
  choose it.
- A row with **Submodule**, **No commit**, or **Other drive** cannot be
  chosen. A submodule comes with the worktree of its parent repository.

A repository of the codebase that gets no worktree is not a session folder of
that session. The session stays isolated: it does not reach the shared
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
start control and the Repositories section say so.

A new worktree of a folder with no repository needs a base branch. The branch
chip shows **This folder**, and the start control has a **Base branch**
field. With no base branch, the host makes no worktree, and the session works
in the folder itself.

### Add a repository to a running session

In a session that works in a task folder, the Repositories section has **Add
repository…**. It lists the repositories of the codebase that have no
worktree in the task folder and that can get one. Select one, and the host
makes its worktree on the branch of the session.

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

### The Repositories section

The project panel of a started session has a **Repositories** section when
the session has a codebase or a session folder. It has one row for the
working directory and one row for each session folder, with the branch and
the line counts of that checkout. It also lists the folders of the codebase
on other hosts. See [Project panel](project-panel.md#repositories).

The menu of each row has **Open files**, which opens the files pane at that
folder. On the desktop app, for a session on this machine, it also has **Open
terminal**.

### The Environment section

The project row of the Environment section shows the name of the codebase of
the run, with the host of the run. On a different host, it shows the name of
the codebase, then the name of the host.

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

Select the row of a session folder in the Repositories section. The Git rows
show below it: branch, commit and push, changes, pull request, discard, and
merge conflicts. They work in that folder only. The session stays in its
working directory.

One Git action is in one repository. To commit in two repositories, commit in
each one.

### Pull requests

The Git rows of a session folder have the pull request row of that
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
- When the session has a codebase, the new folder also becomes a root of the
  codebase. It does not when the call has `add_to_codebase: false`, or when a
  root of the codebase holds the folder already.
- When the session has no codebase, Solus makes one from the project folder
  and the new folder. It makes none when the call has
  `add_to_codebase: false`.

The result of the tool has `sessionFolder` and `addedToCodebase`.

## Mobile

The mobile app has the same capability in its own screens.

| Thing | Where it is on mobile |
|---|---|
| The codebases of a project | The settings of a project show one section for each codebase that holds the project folder: the folders on the host, then the folders on other hosts. **Add folder**, **Rename codebase**, and **Delete codebase** are there. A project that is in no codebase has **Make a codebase**. |
| The codebase of a new session | A folder in exactly one codebase gives the draft that codebase. A folder in more than one adds a **Codebase** control with each codebase and **No codebase**. A folder in no codebase that holds repositories gets its codebase from the host at the first prompt. |
| The repositories of a new worktree | The workspace controls of the draft have a repositories control. A submodule and a repository with no commit show as rows that you cannot choose. For a folder that gets a new codebase, the control lists the repositories that the host found in the folder. |
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
- A draft does not show that its folder gets a new codebase, and it has no
  **No codebase** choice for it.
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
- A client cannot tell that a folder is your home folder or the projects
  folder of the host. A draft there can show **New codebase**, and the host
  then makes none.
- Solus makes a codebase only for repositories that the host finds: at most
  two levels below the project folder.

**Discovery**

- A host looks two levels below a root at most. Add a repository that is
  deeper as its own root.
- A codebase has at most 128 roots.

**Attach**

- The prompt trigger works only in Full access and Auto, for at most three
  folders in one prompt. It does not run for a retry or for a session with
  nobody present.
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
