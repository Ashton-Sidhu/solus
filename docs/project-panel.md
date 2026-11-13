# Project panel items

The project panel is the rail at the right of a conversation on desktop and web. The person chooses which sections it shows, and which kinds of row each section shows.

## Sections and rows

| Section | Row ids |
| --- | --- |
| `environment` | `environment.project` (project row and its Open in menu), `environment.terminal`, `environment.view` (Browser, Builds, or Artifacts), `environment.usage` (usage meters) |
| `git` | `git.branch`, `git.commit` (commit and push), `git.changes`, `git.pullRequestAction` (create a pull request, publish, or sync), `git.discard`, `git.conflicts` (merge conflict alert), `git.pullRequest` (the linked pull request and its actions), `git.otherPullRequests` (Also linked), `git.setup` (repository setup) |
| `goal` | `goal.objective`, `goal.details` (cost and time), `goal.budget` (token budget bar) |
| `webhooks` | None. The section lists one row per webhook, so it has no row kinds to choose. |

Goal shows only while a goal is set, and Webhooks only when the project has webhooks.

A section shows while it is on and at least one of its rows is on. When the last row of a section is off, the section hides. When the Environment section is hidden, the panel's header buttons (refresh, choose, collapse) and the window drag band stay in a bar with no card.

The Open in row replaces the Terminal row. Its main button opens the current working folder or worktree in the selected app. The arrow lists Terminal and installed editors, including VS Code, Cursor, Zed, and supported JetBrains and terminal editors. Choosing an app opens it and remembers the choice on this client. The initial choice uses the installed default editor from Settings, or Terminal. If the chosen editor is no longer available, the row uses the installed default editor or Terminal.

The Terminal option keeps the shared terminal session behavior and its keyboard shortcut. The shortcut always opens Terminal, even when an editor is selected. The row keeps the storage id `environment.terminal`, so existing visibility choices still apply. External apps remain restricted to local desktop sessions; web and remote sessions show the row disabled.

The Git Changes row uses one comparison for the current checkout. On a feature branch, it shows "Changes vs <target>" and counts all changes since the branch left its target, including committed and uncommitted work. A commit does not reset this count. On the target branch (or with detached HEAD), it shows "Changes" and counts uncommitted work against HEAD; a commit clears that count. The tooltip names the comparison. Selecting another linked pull request does not change the counts. Branch counts stay absent until the host loads them; the target branch can show a file count while its line counts load. The Changes row includes untracked files before the first commit. Its count and diff use an empty tree as the base until the repository has a commit. Reading changes does not change the staged files.

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

Desktop and web share this panel. The mobile app has no project panel, so it has no surface for this setting and no change.


Environment menus use the full row as their position anchor. Their arrows point down, and the menus open directly below the row, aligned with its left edge, with a small gap. The Open in menu matches the full row width. The Git action menus and branch picker use the same downward chevrons, position, and full row width. Window collision handling still keeps the menu on screen.

The split button and remembered app choice follow [T3 Code's OpenInPicker](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/OpenInPicker.tsx). Solus uses its existing editor detection, app icons, and desktop RPC handlers.
