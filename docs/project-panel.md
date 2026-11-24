# Project panel items

The project panel is the rail at the right of a conversation on desktop and web. The person chooses which sections it shows, and which kinds of row each section shows.

## Sections and rows

| Section | Row ids |
| --- | --- |
| `environment` | `environment.project` (project row and its Open in menu), `environment.terminal`, `environment.view` (Browser, Builds, or Artifacts), `environment.usage` (usage meters) |
| `git` | `git.branch`, `git.commit` (commit and push), `git.changes`, `git.pullRequestAction` (create a pull request, publish, or sync), `git.discard`, `git.conflicts` (merge conflict alert), `git.pullRequest` (the linked pull request and its actions), `git.otherPullRequests` (other linked pull requests, behind Show N more), `git.setup` (repository setup) |
| `repositories` | `repositories.folders` (the working directory, each session folder, Add folder, and Add repository), `repositories.otherHosts` (the folders of the codebase on other hosts) |
| `servers` | None. Its own card lists running web and API servers. |
| `goal` | `goal.objective`, `goal.details` (cost and time), `goal.budget` (token budget bar) |
| `agents` (desktop) | `agents.running`, `agents.previous` |
| `webhooks` | None. The section lists one row per webhook, so it has no row kinds to choose. |

Goal shows only while a goal is set, and Webhooks only when the project has webhooks. Repositories shows only for a started session that has a codebase or at least one session folder.

The desktop Agents section and the Agents card on Threads read the same session tree. They show the parent, fork source, recent forks, provider sub-agents, and direct child sessions. While agents run, earlier agents are under Previous agents.

A child row shows its latest turn outcome when the host has one. It can also show the saved delegation outcome when the turn digest has no newer result.

- Select a sub-agent to open its transcript. Expand Workflow progress to see the Claude workflow's phases, members, and member states.
- Use Stop on a running child session or a supported provider sub-agent. Claude supplies task controls for its sub-agents and workflows. Codex supplies a turn control for a native child.
- Select a remote child to open it on its runner when the client has a connection. Otherwise, the parent's host can relay a paged, read-only text transcript when the reader has access to the child on both hosts.
- Select Merge back on a fork source to queue a prompt in the source session with excerpts from the fork's completed work. The prompt uses conversation text and preserves any unsent draft in the source session.

A section shows while it is on and at least one of its rows is on. When the last row of a section is off, the section hides. When the Environment section is hidden, the panel's header buttons (refresh, choose, collapse) and the window drag band stay in a bar with no card.

The Open in row replaces the Terminal row. Its main button opens the current working folder or worktree in the selected app. The arrow lists Terminal and installed editors, including VS Code, Cursor, Zed, and supported JetBrains and terminal editors. Choosing an app opens it and remembers the choice on this client. The initial choice uses the installed default editor from Settings, or Terminal. If the chosen editor is no longer available, the row uses the installed default editor or Terminal.

Chats hide the project row and the Open in row, both before and after the first message. Project sessions keep these rows and follow the saved visibility choices.

When the run has a codebase, the project row also shows the name of the codebase in its trailing slot ([Codebases](codebases.md)). On this machine, the name is beside the laptop glyph. On a different host, the row shows the name, then the name of the host, for example "shop · Build server". When the panel is narrow, the name of the codebase is cut first. The tooltip of the row has the full text: "Codebase shop" and "Runs on Build server".

The Terminal option keeps the shared terminal session behavior and its keyboard shortcut. The shortcut always opens Terminal, even when an editor is selected. The row keeps the storage id `environment.terminal`, so existing visibility choices still apply. External apps remain restricted to local desktop sessions; web and remote sessions show the row disabled.

The Git **Changes** row shows line counts for the current checkout. Select it to open the same comparison on desktop or web. The mobile review sheet uses it for its **Changes** option. The host compares the checkout with the merge base of its target branch. It uses the available remote-tracking ref first, so Changes can include local commits on the default branch. If there is no comparison ref, the host uses HEAD. Before the first commit, it uses an empty tree.

When the working directory is not a repository, the Git section shows "This folder isn't a Git repository yet." and the **Initialize Git** button. A folder that holds repositories is different: the section then shows one row, for example "2 repositories in this folder". In a started session, select the row to open the Repositories section. The menu of the row has **Track with Git**, which makes a repository in the folder itself. In a draft, the row opens that menu, because the Repositories section shows only for a started session.

Select **Uncommitted** to see staged, unstaged, and untracked changes against HEAD. Select **Session** or a turn to see changes from the session snapshots. The line counts in the project panel stay on the checkout comparison. Reading either checkout comparison preserves the staging area.

The linked pull request group starts with an Open row. Its menu has "In Solus", which opens the pull request pane, and "In browser", which opens the pull request on the code host. While the session watches the pull request, the group shows "Stop watching". The row stops the watch on the host that runs the session; a viewer who may not change the session's watches sees it disabled. When a row is narrow, the repository name of a pull request in another repository is cut first, then the title. The number always shows. The group heading and the other linked pull request rows use the same order.

## Repositories

The Repositories section is for a session that works in more than one folder ([Codebases](codebases.md); the design is in [the plan](plans/codebases.md)). It has one row for the working directory, then one row for each session folder. A row shows the name of the folder, the branch, and the line counts of its own checkout.

- A worktree of a task folder has the worktree icon. Its tooltip says that its changes stay out of the repository until they are merged.
- A row with "Not attached" is a folder that the agent changed a file in, but that the session was not given. Open the menu of the row and select "Attach to this session".
- A row with "No repository" is a folder with no Git repository. It has no diff. Select the row to open its menu, and select "Track with Git" to make a repository there.
- Select the row of the working directory to open its changes.
- The menu of each row has "Open files", which opens the files pane at the folder of that row. On the desktop app, for a session on this machine, it also has "Open terminal", which opens a terminal in that folder.
- Select the row of a session folder to show the Git rows for that folder: branch, commit and push, changes, pull request, discard, and merge conflicts. These are the rows of the Git section, and they work in that folder only. The session stays in its working directory. The keyboard shortcuts for commit and push and for sync work in the working directory.
- A worktree of a task folder keeps the branch of its session, so its branch row cannot switch branches.
- The menu of a row has "Detach from this session" for a folder that was attached or that a project tool made, and "Add to <codebase>" for a folder that is not in the codebase of the session. A folder of the codebase cannot be detached.
- "Add folder…" opens the folder browser on the host of the session and attaches the folder that you choose. The palette has the same command: "Add folder to this session".
- "Add repository…" shows in a session that works in a task folder. It lists the repositories of the codebase that have no worktree in the task folder. Select one to make its worktree on the branch of the session. If the host refuses, the message of the host shows.
- When the working folder of a task folder session has no repository, its row says that its files are links to the originals, and that an edit of a linked file changes the original for every session.

The "Folders on other hosts" rows list each folder of the codebase that is on a different host, with the name of the host and "Offline" or "Not connected" when this client cannot reach it. A session changes only the folders on its own host. The child sessions that this session started on a host show below the folders of that host, with the branch and line counts of their checkout when this client has them. Select a child session to open it.

The section has no offer to make a codebase. The host makes the codebase when a folder is attached to a session that has none, and a divider in the conversation says so ([How a codebase forms](codebases.md#how-a-codebase-forms)). The attached folder is then a folder of the codebase, so its row has no "Detach from this session". To make a codebase by hand, use Settings → Codebases.

The palette entry "Show repositories" opens the project panel and this section, and it shows the section again if it was hidden. "Open codebase settings" opens the page of the codebase of the session in Settings.

The logic is in `packages/workspace-ui/src/components/project-panel/lib/repositories-section.ts`.

## How to change them

- Right-click anywhere in the panel.
- With the keyboard: press Shift+F10 or the context-menu key while focus is in the panel, or Tab to the "Choose what the panel shows" button in the panel header and press Enter.
- In Settings, open Appearance > Layout > Project panel.

The menu has one submenu for each section that has rows. Each submenu has "Show <section>" and then a checkbox for each row. The rows of a hidden section are disabled, and their choices stay for when the section shows again. Webhooks is a checkbox in the top menu. "Reset to default" shows everything. A change applies immediately.

When every section is hidden, the panel shows "The panel shows no sections" with Show all and Choose buttons.

A hidden item unmounts. Its data reads and subscriptions stop (for example, the webhook watch, the usage meters, and the linked pull request's checks). Collapse is a different thing: a collapsed section stays mounted, and collapse stays per device. Keyboard shortcuts such as commit and push keep working while their row is hidden.

## Storage

The choice is the personal setting `projectPanelHiddenItems`. It syncs with the account. It stores only the ids that the person hid, so an empty list (the default) shows everything, and an item that a later version adds shows until the person hides it. A client keeps ids that it does not know, so an older and a newer client do not erase each other's choices. Reset stores the empty list.

The logic is in `packages/workspace-ui/src/components/project-panel/lib/panel-items.ts`.

## Clients

Desktop and web share this panel. The Agents section and its visibility controls are available on desktop. The mobile app has no project panel.


Environment menus use the full row as their position anchor. Their arrows point down, and the menus open directly below the row, aligned with its left edge, with a small gap. The Open in menu matches the full row width. The Git action menus and branch picker use the same downward chevrons, position, and full row width. Window collision handling still keeps the menu on screen.

The split button and remembered app choice follow [T3 Code's OpenInPicker](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/OpenInPicker.tsx). Solus uses its existing editor detection, app icons, and desktop RPC handlers.

Running servers are grouped by checkout and include API endpoints. See [Running servers](running-servers.md) for discovery, remote opening, and Stop behavior.
