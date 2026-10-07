# Solus tool settings

Settings → Tools lists Solus agent tools by function: Works, External documents,
Automations, Browser, Devices, Sessions, Tasks, Intelligence, Connections,
Insights, and Configuration. Search by group or tool name. Each tool has a switch; each group
has an Enable all switch that changes the full group, even during a search.
All tools are enabled by default. Intelligence includes `ask_jev`.

Choices belong to the selected host. The same page is available on desktop, web,
and mobile. Connected clients receive changes through `config.changed`; the page
reloads settings after reconnect. Failed writes retain the last confirmed values
and show a Retry action. Older hosts must be updated or restarted before these
controls can be used.

Both Claude and Codex omit disabled tools when they build a new tool catalog.
Each tool call also checks the current host settings, so an existing session
cannot start another call to a disabled tool. Calls already running may finish.
Start a new session after enabling a tool to ensure it appears in the provider's
catalog. Explicit Claude and Codex subagents obey the same settings.

These switches control Solus tools only. Provider-native tools and external MCP
servers keep their own settings. The internal `submit_review_guide` output tool
is required by review runs and is not a user-configurable tool.

The shared catalog lives in `packages/contracts/src/agent-tools.ts`. Host config
stores a sparse `solusTools` map: a missing entry means enabled. Patches merge
individual entries so changes from two clients to different tools do not replace
each other. Agents cannot change this map through `update_config`. A saved
entry for a removed tool (`wait_for_session`, `answer_session`, `review_plan`,
`create_session`, `prompt_session`, `find_sessions`) is dropped when the host
reads its settings; any other unknown name is refused.

The Browser group drives the pages in the user's browser pane. Besides open,
navigate, snapshot, click, type, press, scroll, evaluate and wait, it has five
controls for things a click cannot do:

- `browser_hover` moves the mouse over an element, for tooltips and hover menus.
- `browser_select` chooses options of a native `<select>` by value or label.
- `browser_drag` drags one element onto another. A `draggable` source gets HTML
  drag events from a page script, because mouse events from CDP do not start an
  HTML drag. Any other source gets a held mouse that moves in steps.
- `browser_upload` gives files on the host to a file input. The agent names the
  input, its label, or the upload button beside it, and does not click the
  button, because that opens the system file chooser.
- `browser_dialog` answers an alert, confirm or prompt. It answers the dialog
  that is open, or else the next one, so the action that opens it does not stop
  on it. An action that opens a dialog says what the page asked and how it was
  answered. On a headless host an unanswered dialog is dismissed, as before; on
  the desktop it stays open for the user. `browser_status` shows an open dialog.

The Devices group holds `device_list`, `device_open`, `device_screenshot`,
`device_close` and `device_install`. They work only when device support and
agent access are on for the host, and each call checks both again.
`device_open` returns the bound `agent-device` command the agent drives the
device with. `device_install` records an app build and installs it on a
simulator, emulator or connected phone. See
[Device previews](native-devices.md).

The Sessions group holds the orchestration tools: `start_session`,
`send_session`, `stop_session`, `read_session`, `read_task_sessions`,
`search_sessions`, and `list_agent_targets`. See
[Session orchestration](session-orchestration.md). It also holds
`move_to_worktree`, which moves the calling session into a new or an existing
worktree of its repository, so the diff, Git status, and branch follow. A
sub-agent cannot call it for its parent. `worktree_status` reports the
directory the session is bound to, its branch and target branch, and every
checkout of its repository. See
[Agent worktrees](worktree-names.md#agent-worktrees).

The Tasks group holds one tool for links, `link`. With a `task_id` it attaches
a work, plan, pull request, automation or session to the task. With `kind=pr`
and no `task_id` it links the pull request to the calling session.
`list_session_pull_requests` lists the pull requests linked to the calling
session with their last known state, so the agent can find one that it forgot
to link. See [Session pull requests](plans/session-pull-requests.md).

Ask Jev requires a TypeSafe API key. Add or remove the saved host key under
Settings → Tools → Intelligence. Without a saved key or TYPESAFE_API_KEY in the
host environment, its switch is disabled and both providers omit the tool.
See [TypeSafe configuration](typesafe.md).
