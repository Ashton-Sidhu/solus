# Where a session runs

The strip above the composer of a new session reads left to right: **project**,
**Run on**, **branch**, **task**. Each chip answers one question. Choosing a
folder on another host points the session there at once, so the branch chip
shows that host's branches. Nothing is cloned, and no host that is offline is
connected, until you send the first prompt.

## Project

The project chip lists projects, not folders. A repository with checkouts on
several hosts is one row. The row opens the project in its checkout on the host
the session runs on. When that host has no checkout, the row opens the most
recently used checkout on another online host and names that host. A project
whose hosts are all offline stays in the list, marked **Offline**.

A folder with no Git remote is its own project on its host.

A folder becomes a project only when you open, clone, or add it. Sending a
prompt in a folder does not add it; it moves a known project to the top.

A chat has no project, so any host can run it. When a draft has a project, the
last item of the chip's menu is **Switch to chat**. In the Run on picker, a
chat moves to the host you select as a new chat there. See
[Projects → Chats](projects.md#chats).

## Run on

The Run on picker lists every host, and ends with **Add a host…**. It shows only
when another host is connected, or when the session already names a remote
host. To add the first remote host, use Settings → Hosts. Each row is one
line: the host name, then a mark for each organization the host belongs to.
Organizations have no logo, so the mark is the first letter of the
organization name; hover over it to see the full name. A personal host has no
mark. The current host has a check. What Send does depends on the host:

| Host | What Send does |
|---|---|
| The current host | The session runs on this host. |
| A host that has a checkout of the project | The session runs in the checkout that host already has. The session points there when you select the row; Send connects to the host first if it is not online. |
| A host that has no checkout | The host makes a partial clone of the repository (every branch and its full history; file contents are fetched when a checkout or diff first needs them), then runs the session in a new worktree by default. A checkout that an earlier version cloned without history gets its full history once, the next time work is sent to it; its files, commits, and HEAD stay as they are. The copy goes in the host's projects folder, named for the repository like `git clone` names it (`~/projects/solus`), and the host lists it as a project. When that folder holds a checkout of the same repository, the host uses it, and a checkout you made there yourself always gets a new worktree, so the agent never works in your checkout; when it holds something else, the copy is `solus-2`, then `solus-3`. |

### Auto balance

Auto balance chooses the host of a new session from the current CPU and memory of
each eligible host. It is off by default. Turn it on in Settings → Hosts → **Auto
balance**, which shows when you have two or more hosts. On mobile, it is in
Settings → Hosts. Your choices are personal settings, so they apply on each client.

Each host has a preference: **Prefer**, **Normal**, **Less often**, or **Manual
only**. They are preferences, not fixed shares. Auto balance never chooses a Manual
only host.

A host is eligible when it is connected, it can run the agent, and it already has
a checkout of the project. Any such host can run a chat. Auto balance does not start
a clone: to copy a repository to another host, choose that host yourself.

The check runs once, when you start a new session. Then the choice stays. Choosing a
host, a branch, or a worktree overrides it, and choosing another project checks again.
Existing sessions stay where they started.

A check never moves a session that you have started to write. If you type or attach a
file before it ends, the session keeps its host, and Run on does not say that Auto
balance chose it. To move it, choose **Auto balance** in Run on. That checks again and
moves the session with its text. A session with attachments stays, because attachments
are on their host, and Run on says **Auto balance unavailable**.

When the check fails or each host is full, Run on says **Auto balance unavailable**.
The session stays on the host that Run on names. Choose another host by hand, or
send there. A host counts as full at 95% CPU, or with 5% or less of its memory
available.

### What Send does for a copy

Send connects to the host and then sends the prompt. The prompt carries the
repository, so the client does not wait for the copy. On desktop, the prompt
also carries your GitHub credential, so the host clones as you.

The host copies the repository before the run starts. It uses the checkout of
the repository that its projects folder already has, or it makes a new one. On
desktop, a copy the host made commits and pushes as you. A checkout you made
there yourself keeps its own git config, and uses the host's credentials. The host, not the client,
decides the folder of the copy. It decides the folder when the prompt arrives,
so the session's owner, its organization, and its first record name that
folder before the copy starts. The conversation shows one
setup card for all of the work: **Connecting to** the host, **Preparing
repository**, the worktree steps when the session asked for a worktree (**Fetch
base branch**, **Check out files**, and **Init submodules**, see
[worktree names](worktree-names.md#start-point)), and **Start agent**. While git receives the
repository, the repository step shows the percentage that git reports. The
card updates at most four times each second.

If the copy fails, the repository step shows the error and nothing starts.
When the host clones with your Solus account and the account has no GitHub
connection, the card shows **Connect GitHub**.

A host that has no checkout of the project, when the project has no Git remote,
is not listed. When no project is chosen yet, every host is listed, and you pick
the project on the host you choose.

A cloud host that is not ready is disabled and takes no work. **Add a
host…** pairs a new host and selects it.

After a session starts, its host is fixed.

On a host where each member uses their own seat, a new session shows **Connect
Claude** or **Connect Codex** before the first send when you have no seat for
the chosen agent on the Run on host.

The work Solus does for you in the background also uses your seat: session and
worktree names, commit messages, pull request text, Insights questions, review
guides, review lenses, and subagents. Names, commit messages, and pull request
text use the host's writing model when you have a seat for it, and otherwise the
other agent's writing model. If you have no seat for either agent, a session or
worktree keeps its first-prompt name, a pull request uses text made from its
commits, and a commit asks you to connect an agent or write the message. A
review guide, a review lens, an Insights question, or a subagent
that needs a seat you do not have stops and tells you which agent to connect.

On such a host, your agent and Solus commit as your GitHub account and push with
your GitHub connection, not the host's. Your instructions and skills come with
you: see [Agent profile](agent-profile.md).

If your Solus account has no GitHub connection, or the host cannot read it, you
can still read and edit. A commit or a push then fails with the reason; it never
uses the host's author, credential helper, or SSH key for GitHub. When you
connect a different GitHub account, a Codex session that is running keeps the
old account until its run ends; send again after it finishes.

`GitIdentityManager` (`git/git-identity-manager.ts`) chooses the identity. Your
token is kept in a 0600 file on the host only while one of your processes or
Git actions uses it, and is never put in a process environment, an argument, or
checkout config. On a host, every member's agent runs as the same operating
system user, so this is not isolation from another member's agent.

### Copied files

A clone has only what git tracks. Files that git ignores, such as `.env`, stay
on your machine unless the project's `.worktreeinclude` names them. On each Send
that makes or uses a copy, the client reads those files from the project's own
checkout and carries them in the prompt. The two hosts never talk to each
other. During **Preparing repository**, the host writes each file that the copy
does not have yet, and it writes `.worktreeinclude` too, so the worktrees it
makes later get the same files. When the host's folder is a checkout you made
yourself, the host writes nothing into it: the new worktree the session runs in
gets the files instead. A file that already exists is never replaced, because
the agent or you may have changed it there.

To choose the files, select **Configure copied files…** in the Run on list, or
open Settings → Projects → **Files copied to other hosts**. The dialog lists the
files that git ignores in the project. A folder that git ignores whole, such as
`node_modules`, is not listed. Each checkbox adds or removes the file in
`.worktreeinclude`. A pattern that is already in the file keeps its meaning:
when you clear one file that a pattern names, the dialog adds a `!/path` line
for that file only. When the project has no `.worktreeinclude`, its env files
(`.env*`, `.envrc`, `.dev.vars`) are selected, and **Save** makes the file.

A file larger than 1 MB is not copied, and one send copies at most 4 MB. When
the project's host cannot be reached, the send goes without the files. The
mobile app has no Run on list, so it has no copied files either.

## Branch and checkout

The branch chip chooses the branch and where the session starts: **This
checkout** or **New worktree**. `⌥⇧B` toggles the same choice. The same choice
applies on every host, a cloud host too: each member has their own projects
folder there. A session sent to another host from a checkout works on the
repository's default branch in the copy the host made, and the chip shows that
branch. When the host's folder is a checkout you made, such as a cloud project,
the session gets a new worktree of it instead. A session that asked for a
worktree gets a new worktree there. The branch menu also offers that host's worktrees and its origin
branches. An origin branch that the checkout already holds is worked on in the
checkout; any other branch gets its own worktree.

A new worktree starts on a temporary branch, `solus/<8 hex digits>`, so the
first prompt does not wait for a name. During the first turn, Solus renames the
branch from the prompt. It does not rename a branch the agent switched away
from, or a branch that has an upstream.
