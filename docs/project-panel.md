# Project panel items

The project panel is the rail at the right of a conversation on desktop and web. The person chooses which sections it shows, and which kinds of row each section shows.

## Sections and rows

| Section | Row ids |
| --- | --- |
| `environment` | `environment.project` (project row and its Open in menu), `environment.terminal`, `environment.view` (Browser, Builds, or Artifacts), `environment.usage` (usage meters) |
| `git` | `git.branch`, `git.commit` (commit and push), `git.changes`, `git.pullRequestAction` (create a pull request, publish, or sync), `git.discard`, `git.conflicts` (merge conflict alert), `git.pullRequest` (the linked pull request and its actions), `git.otherPullRequests` (Also linked), `git.setup` (repository setup) |
| `goal` | `goal.objective`, `goal.details` (cost and time), `goal.budget` (token budget bar) |
| `agents` | `agents.running`, `agents.previous` |
| `webhooks` | None. The section lists one row per webhook, so it has no row kinds to choose. |

Goal shows only while a goal is set, Agents only after the conversation starts agents, and Webhooks only when the project has webhooks.

A section shows while it is on and at least one of its rows is on. When the last row of a section is off, the section hides. When the Environment section is hidden, the panel's header buttons (refresh, choose, collapse) and the window drag band stay in a bar with no card.

The Git Changes row includes untracked files before the first commit. Its count and diff use an empty tree as the base until the repository has a commit. Reading changes does not change the staged files.

## How to change them

- Right-click anywhere in the panel.
- With the keyboard: press Shift+F10 or the context-menu key while focus is in the panel, or Tab to the "Choose what the panel shows" button in the panel header and press Enter.
- In Settings, open Appearance > Layout > Project panel.

The menu has one submenu for each section that has rows. Each submenu has "Show <section>" and then a checkbox for each row. The rows of a hidden section are disabled, and their choices stay for when the section shows again. Webhooks is a checkbox in the top menu. "Reset to default" shows everything. A change applies immediately.

When every section is hidden, the panel shows "The panel shows no sections" with Show all and Choose buttons. When Agents shows but its visible kind of row is empty, the card says "No running agents." or "No previous agents.".

A hidden item unmounts. Its data reads and subscriptions stop (for example, the webhook watch, the usage meters, the agent scan, and the linked pull request's checks). Collapse is a different thing: a collapsed section stays mounted, and collapse stays per device. Keyboard shortcuts such as commit and push keep working while their row is hidden.

## Storage

The choice is the personal setting `projectPanelHiddenItems`. It syncs with the account. It stores only the ids that the person hid, so an empty list (the default) shows everything, and an item that a later version adds shows until the person hides it. A client keeps ids that it does not know, so an older and a newer client do not erase each other's choices. Reset stores the empty list.

The logic is in `packages/workspace-ui/src/components/project-panel/lib/panel-items.ts`.

## Clients

Desktop and web share this panel. The mobile app has no project panel, so it has no surface for this setting and no change.
