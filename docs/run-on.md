# Where a session runs

The strip above the composer of a new session reads left to right: **project**,
**Run on**, **branch**, **task**. Each chip answers one question. Nothing moves
or connects until you send the first prompt.

## Project

The project chip lists projects, not folders. A repository with checkouts on
several hosts is one row. The row opens the project in its checkout on the host
the session runs on. When that host has no checkout, the row opens the most
recently used checkout on another online host and names that host. A project
whose hosts are all offline stays in the list, marked **Offline**.

A folder with no Git remote is its own project on its host.

A folder becomes a project only when you open, clone, or add it. Sending a
prompt in a folder does not add it; it moves a known project to the top.

The **Scratchpad** row at the top of the list starts the session with no
project, in the Scratchpad folder of the Run on host. The row does not show
when that host does not offer Scratchpad. See [Projects → Scratchpad](projects.md#scratchpad).

## Run on

The Run on picker lists every host, and ends with **Add a host…**. It shows only
when another host is connected, or when the session already names a remote
host. To add the first remote host, use Settings → Connections. Each row says
what that host will use for the project:

| Row note | What Send does |
|---|---|
| none, with a check | The session runs on this host. |
| **Uses its checkout** | The session runs in the checkout that host already has. |
| **Copies the repository** | The host makes a partial clone of the repository (every branch and its full history; file contents are fetched when a checkout or diff first needs them), then runs the session in a new worktree by default. A checkout that an earlier version cloned without history gets its full history once, the next time work is sent to it; its files, commits, and HEAD stay as they are. The copy belongs to the device that sent the work; it never shows as a project. |
| **Choose a folder** | The project has no Git remote, so you pick a folder on that host. |

A cloud host that is not ready shows its state and takes no work. **Add a
host…** pairs a new host and selects it.

After a session starts, its host is fixed.

On a host where each member uses their own seat, a new session shows **Connect
Claude** or **Connect Codex** before the first send when you have no seat for
the chosen agent on the Run on host.

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

## Branch and checkout

The branch chip chooses the branch and where the session starts: **This
checkout** or **New worktree**. `⌥⇧B` toggles the same choice. The same choice
applies on every host, a cloud host too: each member has their own checkout
there, so working on the default branch is safe. A session sent to another host
starts in a new worktree by default; choose **Checkout** in its branch menu to
work in that host's checkout. An origin branch that the checkout already holds
is worked on in the checkout.

A new worktree starts on a temporary branch, `solus/<8 hex digits>`, so the
first prompt does not wait for a name. During the first turn, Solus renames the
branch from the prompt. It does not rename a branch the agent switched away
from, or a branch that has an upstream.
