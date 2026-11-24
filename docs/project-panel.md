# Project panel items

The project panel is the rail at the right of a conversation on desktop and web. The person chooses which sections it shows, and which kinds of row each section shows.

## Sections and rows

| Section | Row ids |
| --- | --- |
| `environment` | `environment.project` (project row and its menu, which has the folders of the session), `environment.terminal`, `environment.view` (Browser, Builds, or Artifacts), `environment.usage` (usage meters) |
| `git` | `git.branch`, `git.commit` (commit and push), `git.changes`, `git.pullRequestAction` (create a pull request, publish, or sync), `git.discard`, `git.conflicts` (merge conflict alert), `git.pullRequest` (the linked pull request and its actions), `git.otherPullRequests` (other linked pull requests, behind Show N more), `git.setup` (repository setup) |
| `servers` | None. Its own card lists running web and API servers. |
| `goal` | `goal.objective`, `goal.details` (cost and time), `goal.budget` (token budget bar) |
| `agents` (desktop) | `agents.running`, `agents.previous` |
| `webhooks` | None. The section lists one row per webhook, so it has no row kinds to choose. |

Goal shows only while a goal is set, and Webhooks only when the project has webhooks. The panel has no Repositories section: the repositories of a session are in the Git section, and its folders are in the menu of the project row of the Environment section ([Repositories and folders](#repositories-and-folders)).

The desktop Agents section and the Agents card on Threads read the same session tree. They show the parent, fork source, recent forks, provider sub-agents, and direct child sessions. While agents run, earlier agents are under Previous agents.

A child row shows its latest turn outcome when the host has one. It can also show the saved delegation outcome when the turn digest has no newer result.

- Select a sub-agent to open its transcript. Expand Workflow progress to see the Claude workflow's phases, members, and member states.
- Use Stop on a running child session or a supported provider sub-agent. Claude supplies task controls for its sub-agents and workflows. Codex supplies a turn control for a native child.
- Select a remote child to open it on its runner when the client has a connection. Otherwise, the parent's host can relay a paged, read-only text transcript when the reader has access to the child on both hosts.
- Select Merge back on a fork source to queue a prompt in the source session with excerpts from the fork's completed work. The prompt uses conversation text and preserves any unsent draft in the source session.

A section shows while it is on and at least one of its rows is on. When the last row of a section is off, the section hides. When the Environment section is hidden, the panel's header buttons (refresh, choose, collapse) and the window drag band stay in a bar with no card.

The Open in row replaces the Terminal row. Its main button opens the current working folder or worktree in the selected app. The arrow lists Terminal and installed editors, including VS Code, Cursor, Zed, and supported JetBrains and terminal editors. Choosing an app opens it and remembers the choice on this client. The initial choice uses the installed default editor from Settings, or Terminal. If the chosen editor is no longer available, the row uses the installed default editor or Terminal.

Chats hide the project row and the Open in row, both before and after the first message. Project sessions keep these rows and follow the saved visibility choices.

The project row shows one name. When the run has a codebase, it is the name of the codebase, with the codebase icon ([Codebases](codebases.md)). When the run has none, it is the name of the project. The trailing slot marks the host: the laptop glyph on this machine, the name of the host on a different one, for example "Build server". The tooltip of a run in a codebase has the full text: "Codebase shop", "Works in api", and "Runs on Build server".

The Terminal option keeps the shared terminal session behavior and its keyboard shortcut. The shortcut always opens Terminal, even when an editor is selected. The row keeps the storage id `environment.terminal`, so existing visibility choices still apply. External apps remain restricted to local desktop sessions; web and remote sessions show the row disabled.

The Git **Changes** row shows line counts for the current checkout. Select it to open the same comparison on desktop or web. The mobile review sheet uses it for its **Changes** option. The host compares the checkout with the merge base of its target branch. It uses the available remote-tracking ref first, so Changes can include local commits on the default branch. If there is no comparison ref, the host uses HEAD. Before the first commit, it uses an empty tree.

When the working directory is not a repository, the Git section shows "This folder isn't a Git repository yet." and the **Initialize Git** button. A folder that holds two or more repositories is different: it is a container, and the section then lists its repositories ([Repositories and folders](#repositories-and-folders)). **Track with Git**, which makes a repository in the folder itself, is then in the section of the working folder, in the menu of the project row of the Environment section.

Select **Uncommitted** to see staged, unstaged, and untracked changes against HEAD. Select **Session** or a turn to see changes from the session snapshots. The line counts in the project panel stay on the checkout comparison. Reading either checkout comparison preserves the staging area.

The linked pull request group starts with an Open row. Its menu has "In Solus", which opens the pull request pane, and "In browser", which opens the pull request on the code host. While the session watches the pull request, the group shows "Stop watching". The row stops the watch on the host that runs the session; a viewer who may not change the session's watches sees it disabled. When a row is narrow, the repository name of a pull request in another repository is cut first, then the title. The number always shows. The group heading and the other linked pull request rows use the same order.

## Repositories and folders

A session can work in more than one folder ([Codebases](codebases.md); the design is in [the plan](plans/codebases.md)). The panel has no card of its own for them. The Git section shows the repositories, and the menu of the project row of the Environment section has the folders.

### The repositories of the Git section

When a session works in more than one repository, the Git section starts with one row for each repository: the repository of the working directory first, then each session folder that is a repository. The section lists them as it lists the other linked pull requests of a session: one row for each, and a choice of a row makes it the one that the rows of the section work with. The title of the section says how many repositories there are, for example "3 repositories".

- A row shows the name of the repository, its branch, and the line counts of its own checkout.
- A worktree of a task folder has the worktree icon. Its tooltip says that its changes stay out of the repository until they are merged.
- A row with "Not attached" is a repository that the agent changed a file in, but that the session was not given. Attach it from its section in the menu of the project row of the Environment section.
- Select a row to choose that repository. The Git rows below the list (branch, commit and push, changes, pull request, discard, and merge conflicts) then work in that repository only. The session stays in its working directory. The chosen row keeps the highlight of an open control, and a screen reader hears it as the current row.
- The repository of the working directory is chosen at first. The choice stays when you go to a different tab and come back.
- The list shows four repositories at most. With more, the row "Show N more" opens the rest, and "Show less" closes them. The chosen repository always shows: when it is after the fourth row, it takes the place of the fourth. The fold stays when you go to a different tab and come back.
- The Changes row opens the diff panel on the chosen repository.
- A worktree of a task folder keeps the branch of its session, so its branch row cannot switch branches.
- The keyboard shortcuts for commit and push and for sync work in the working directory.
- "Add repository…" shows in a session that works in a task folder. It lists the repositories of the session that have no worktree in the task folder. Select one to make its worktree on the branch of the session. If the host refuses, the message of the host shows.

A session in one repository has no repository rows: the section looks as it does for each session with one project.

A folder with no repository that holds two or more repositories is a container, and a container is a codebase. The section lists its repositories, and the first one is chosen. In a draft, the rows show what the session gets: a row opens the files of its repository, and the Git rows show when the session starts. A draft with no codebase has no repository rows.

### The folders of the Environment section

The Environment section names the work on its project row. It has no row for each folder. The arrow of the project row opens a menu with one section for each folder of the session: the working folder first, then each session folder, then each folder of the codebase that is on a different host.

- The heading of a section shows the name of the folder and the mark of its host: the laptop glyph on this machine, the name of the host on a different one. It also shows the state of the folder: "No repository", "Not attached" for a folder that the session was not given, "Missing" for a folder that is gone, and "Offline" or "Not connected" for a host that this client cannot reach.
- Each section of a folder on the host of the session starts with "Open in Solus", which opens the files pane at that folder, and "Open in Finder" (or the file manager of the host), on the desktop app for a session on this machine.
- A folder then has its options: "Open terminal" (on the desktop app, for a session on this machine), "Attach to this session" for a folder that is not attached, "Detach from this session" for a folder that was attached or that a project tool made, "Add to <codebase>" for a folder that is not in the codebase of the session, and "Track with Git" for a folder with no repository. A folder of the codebase cannot be detached.
- The working folder has "Track with Git" when it has no repository and holds repositories.
- A session changes only the folders on its own host. The section of a folder on a different host lists the child sessions that this session started there, with the branch and line counts of their checkout when this client has them. Select a child session to open it. With no child session, the section says "No session works here".
- "Add folder…" is the last item of the menu. It opens the folder browser on the host of the session and attaches the folder that you choose. The palette has the same command: "Add folder to this session".
- A repository of the codebase has a section here for its place, and a row in the Git section for its Git state.
- The menu scrolls when it is longer than the window. The arrow keys, Home, End, and the first letters of an item go through the items of all sections. A heading is not a stop.
- When the working folder of a task folder session has no repository, a text below the project row says that its files are links to the originals, and that an edit of a linked file changes the original for every session.

A session with one folder has no heading in the menu: it is the menu of a session with one project ("Open in Solus", the file manager, "Add folder…"). The Open in row of the section opens the terminal of that folder. A draft has that menu also, because the folders of a session exist when it starts.

The panel has no offer to make a codebase. The host makes the codebase when a second project is attached to a session that has none, and a divider in the conversation says so ([How a codebase forms](codebases.md#how-a-codebase-forms)). The attached folder is then a folder of the codebase, so its menu has no "Detach from this session". To make a codebase by hand, use Settings → Codebases.

The palette entry "Open codebase settings" opens the page of the codebase of the session in Settings.

The logic is in `packages/workspace-ui/src/components/project-panel/lib/git-repositories.ts` and `lib/environment-folders.ts`.

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

The Running servers list and each agent list show up to three rows when the panel has 800 pixels of available height or less, and up to five rows when it has more height. Select **Show more** to see additional rows. The lists stay expanded when you resize the panel.
