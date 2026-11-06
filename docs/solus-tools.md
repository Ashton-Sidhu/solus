# Solus tool settings

Settings → Tools lists Solus agent tools by function: Works,
Automations, Browser, Devices, Sessions, Tasks, Connections,
Insights, and Configuration. Search by group or tool name. Each tool has a switch; each group
has an Enable all switch that changes the full group, even during a search.
All tools are enabled by default.

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

A tool acts as the person whose turn calls it (docs/plans/access-model.md).
The Automations tools reach only the automations that person may see: their
own, or every one for a host administrator. `query_insights` runs SQL over every
person's turns, so only a host administrator's turn may call it; another
person's turn gets a refusal and can open Insights to see their own turns.
`connect_integration` adds a server only to the calling person's own servers,
and only from an exact catalog match. For any other address it opens a card
where the person enters and adds the server (docs/integrations.md).

These switches control Solus tools only. Provider-native tools and external MCP
servers keep their own settings. The internal `submit_review_guide` output tool
is required by review runs and is not a user-configurable tool.

The shared catalog lives in `packages/contracts/src/agent-tools.ts`. Host config
stores a sparse `solusTools` map: a missing entry means enabled. Patches merge
individual entries so changes from two clients to different tools do not replace
each other. Agents cannot change this map through `update_config`. A saved
entry for a removed tool (`wait_for_session`, `answer_session`, `review_plan`,
`create_session`, `prompt_session`, `find_sessions`, `read_automation_run`) is dropped when the host
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

A Solus client in a browser page opens without onboarding, so an agent sees the
route it opened. Add `?show-onboarding` to the URL to check the onboarding flow.

A snapshot does not record the value of a field the page masks: a password
field, or a field the page draws as dots (`-webkit-text-security`). Other field
values stay in the snapshot. A label is copied as the page wrote it, so a page
that puts a secret in a label still shows it.

The Devices group holds `device_list`, `device_open`, `device_screenshot`,
`device_close` and `device_install`. They work only when device support and
agent access are on for the host, and each call checks both again.
`device_open` returns the bound `agent-device` command the agent drives the
device with. `device_install` records an app build and installs it on a
simulator, emulator or connected phone. See
[Device previews](native-devices.md).

The Sessions group holds the orchestration tools: `delegate_task`, `start_session`,
`send_session`, `stop_session`, `read_session`,
`search_sessions`, and `list_agent_targets`. See
[Session orchestration](session-orchestration.md). It also holds
`move_to_worktree`, which moves the calling session into a new or an existing
worktree of its repository, so the diff, Git status, and branch follow. A
sub-agent cannot call it for its parent. `worktree_status` reports the
directory the session is bound to, its branch and target branch, and every
checkout of its repository. See
[Agent worktrees](worktree-names.md#agent-worktrees).

The Sessions group holds `link`, `list_links`,
`unlink`, and `watch_pull_request`. `link` attaches a work,
automation, pull request, or file to the calling session. It does not accept
`task_id`, task session membership, or Solus plan links. An agent that writes a
plan file links it with `kind=file` and `path`. Task links remain available
through the task interface.
`unlink` removes a link using the same `kind`, `target_id`, or `path` as `link`;
it does not delete the target. It can remove a file link after the file is gone.
`list_links` lists this session's works, automations, files, and pull requests.
Use the optional `kind` filter to select one type. PRs include their last known
state. Removed PRs stay excluded from automatic linking until explicitly linked again. See [Session pull requests](plans/session-pull-requests.md).

`read_task` includes linked session IDs. Use `read_session` for a session's
status, pending input, and history. There is no separate task-session read tool.
Organization task reads include only sessions the caller may read.

`render_artifact` saves a work associated with the calling session. It has no
task-link option. Use `link` to attach an existing work to the current session.

Works includes `publish_work` and `pull_work_upstream` for connected document
providers. Publish sends a work to Confluence or Google Docs and keeps the link.
Pull accepts exactly one of `url` (import into Solus) or `work_id` (refresh a
linked work). The separate external document tools are removed. Read imported
content with `read_work`; private replies use `reply_comment`.

Automation results use two existing reads. `list_automation_runs` returns run
status, start and finish times, errors, and the session ID when available. Pass
`automation_id` and optional `run_id` to inspect one run. Failures before a
session starts remain visible here. Use `read_session` with the returned
`session_id` for agent output and history.

An interval or cron trigger can have an end: `ends_at` in the tools, and Ends in
the automation's Schedule block. No scheduled run starts at or after that
instant, and this includes a run missed while Solus was closed. The automation
stays enabled, shows "Schedule ended", and can still run manually. Change or
remove the end to schedule it again.
