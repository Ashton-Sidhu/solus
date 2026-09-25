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
| **Copies the repository** | The host clones the repository, then runs the session in a new worktree. The copy belongs to the device that sent the work; it never shows as a project. |
| **Choose a folder** | The project has no Git remote, so you pick a folder on that host. |

A cloud host that is not ready shows its state and takes no work. **Add a
host…** pairs a new host and selects it.

After a session starts, its host is fixed.

On a host where each member uses their own seat, a new session shows **Connect
Claude** or **Connect Codex** before the first send when you have no seat for
the chosen agent on the Run on host.

## Branch and checkout

The branch chip chooses the branch and where the session starts: **This
checkout** or **New worktree**. `⌥⇧B` toggles the same choice. A session sent to
another host always starts in a worktree.

A new worktree starts on a temporary branch, `solus/<8 hex digits>`, so the
first prompt does not wait for a name. During the first turn, Solus renames the
branch from the prompt. It does not rename a branch the agent switched away
from, or a branch that has an upstream.
