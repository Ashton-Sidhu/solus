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
`add_mcp_server` adds a server the agent installed for its own CLI, from the
person's own Claude Code or Codex config file, with no approval: the person
asked for the install. It never adds a server that only a repository file
holds, and a command needs a host administrator's turn.
`list_integration_resources`, `read_integration_resource`, and
`watch_integration_resource` join a run only when one of that person's servers
in the run has resources (the watch tool: one that sends changes). They are
deferred, reach only those servers by slug, and read as the person. A watch
starts the agent again in its session when the resource changes, within the
limits that docs/integrations.md lists.

These switches control Solus tools only. Provider-native tools and external MCP
servers keep their own settings. The internal `submit_review_guide` output tool
is required by review runs and is not a user-configurable tool.

**Which MCP servers are whose.** An MCP server that you add in Settings → MCP
is Solus's: the host runs it and gives its tools to the agent as Solus tools
named `<slug>__<tool>`, with your sign-in and your tool switches. A server in a
provider CLI file (`.mcp.json`, `~/.claude.json`, `~/.codex/config.toml`, or
`.codex/config.toml` in a project) is the CLI's: the CLI starts it and holds
its credential. When both have the same server, a run that Solus starts leaves
out the CLI's copy, so the agent sees each tool once and the credential stays
out of the agent process (the CLI skip, `docs/integrations.md`). Only the
server with the same address is left out, and only in that run; Solus does not
change the CLI's files.

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

The Sessions group holds the orchestration tools: `start_sessions`,
`send_session`, `stop_session`, `read_session`,
`search_sessions`, and `list_agent_targets`. See
[Session orchestration](session-orchestration.md). The group also holds
`move_checkout`: the agent names the checkout the calling session works in next
(the project folder, an existing worktree, or a new worktree) and the branch it
must be on, and Solus runs the Git steps when the turn ends, so the diff, Git
status, and branch follow. It can also remove the worktree the session leaves. A sub-agent cannot call it for its parent.
`checkout_status` reports the directory the session is bound to, its branch and
target branch, every checkout of its repository, and, on request, its branches.
See
[Agent worktrees](worktree-names.md#agent-worktrees).
`attach_folder` adds a folder on the host to the folders the calling session
works in. A path in a Git repository attaches the root of the repository. In
the modes Full access and Auto the folder is attached immediately. In the
other modes a card asks the person, one time for each folder. A folder of the
session's codebase needs no card. In a session that works in a task folder,
a repository of the codebase gives the session its worktree of that
repository. For a folder of the codebase on a different host, the tool tells
the agent to start a session there. The tool is in the Sessions group, so
you can turn it off in Settings → Tools. See
[Codebases](codebases.md#attach-a-folder-in-a-running-session).

The Sessions group holds `link`, `list_links`,
`unlink`, and `watch_pull_request`. `link` attaches a work,
automation, pull request, or file to the calling session. With `kind=task` and
the task key as `target_id`, it links the calling session to a GitHub or Jira
task as a working session, so the task page lists it. This is the only way an
agent puts a session on a task: `start_sessions` joins no task. `link` does not
accept Solus plan links. An agent that writes a plan file links it with
`kind=file` and `path`.
`unlink` removes a link using the same `kind`, `target_id`, or `path` as `link`;
it does not delete the target. It can remove a file link after the file is gone.
`list_links` lists this session's works, automations, files, and pull requests.
A task's link belongs to the task, so `read_session` names the session's task.
Use the optional `kind` filter to select one type. PRs include their last known
state. Removed PRs stay excluded from automatic linking until explicitly linked again. See [Session pull requests](plans/session-pull-requests.md).

GitHub and Jira own every task (see
[Provider-owned tasks](plans/provider-owned-tasks.md)). The Tasks group reads
the host's copy of the tasks and writes to the provider, with the connection of
the person the turn acts for. This is the same on a personal host and on an
organization machine: a task tool never calls the Solus API. A task id is a
task key (`github:<node id>` or `jira:<site>:<issue id>`).

Tasks belong to no project. The task sources are the person's own: they reach
the host with each prompt in the execution preferences (`taskSources`), so
the calling session's folder does not limit them.

- `list_tasks` lists the tasks of the person's task sources, with their task
  keys and status category (`open`, `active`, `done`), and names the source
  keys. `status` and `source` (a source key) limit the list. It reads the
  host's copy only.
- `read_task` asks the provider for one task and answers its description,
  state, columns, epic, comments, linked items, and linked session IDs. When
  the provider does not answer, it answers the host's last copy and says so.
- `create_task` creates a real task in the source that `source` names by its
  source key: a GitHub issue, a draft item of a GitHub Project, or a Jira
  issue. Without `source`, the task goes to a source of the task the session
  works on, else to the source of the GitHub repository of the session's
  checkout, else to the person's only source. With several sources and no such
  match, it creates nothing and answers with the person's sources, so the
  agent names one. A source that is not one of the person's is refused. With no task source, it gives an error that says to add
  one on the Tasks page. It takes a permission prompt in a supervised session.
- `update_task_status` takes a status category or the exact name of a column of
  a board that lists the task. A category closes or reopens a GitHub issue and
  moves it on each GitHub Project that lists it; a Jira issue makes a legal
  workflow transition, and the tool says so when there is none. The lifecycle
  policy still applies: `none` refuses each change, and `moderate` refuses a
  move to `done`.
- `comment_task` posts a comment on the provider. A comment the provider did
  not take stays on the task as unsent, and the tool reports the reason.

In a dispatched session the task is read on another host, so `read_task`
answers from the snapshot the prompt carried, and `update_task_status` and
`comment_task` go through the outbox to the host that reads the task.

`read_task` includes linked session IDs. Use `read_session` for a session's
status, pending input, and history. There is no separate task-session read tool.

`render_artifact` saves a work associated with the calling session. It has no
task-link option. Use `link` to attach an existing work to the current session.

Apps (docs/apps.md) have seven tools. `save_app` commits an app project (a
project from the `create-app` skill) as a new revision. It takes the
project folder as `path`; a folder that `checkout_app` or an earlier save
wrote names its app, and a new app needs no `app`. A save changes nothing that
runs and needs no approval. It is refused when the app has a newer revision
than the folder came from. `deploy_app` takes `app` (a slug) and has the host
build the newest revision, or the one `revision` names, and make the version
active. It links the app to the calling session; it needs approval.
`preview_app` has the host build the project folder and answers a picture of
its UI; it saves nothing and needs no approval. `checkout_app` writes the
source of a revision into a folder, so a later session can change the app.
`list_apps` lists the apps of the host with their operations. `inspect_app`
reads what the host kept of an app: its state and instructions, its call log
with each call's input, log lines, and trace, its workflow runs, its signals,
and its build logs. When a deploy leaves a workflow run that failed on an
older version, `deploy_app` lists it; `retry_app_run` takes `app` and `run_id`
and starts that run again on the active version, with no approval.
`set_app_signal_action` makes or changes what one signal of an app does; it
needs approval.

Each operation of a running app is also a tool, named `<slug>__<operation>`,
in every run that starts after the deploy, while the app's agent access is on.
A query and a mutation run with no approval of their own. `link`, `unlink`, and `list_links` take `kind: "app"`
with the app's slug or id.

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

## Remote host pairing

`pair_host` pairs a remote Solus server from an owner chat session. It takes an
address and a session-bound `secretRef` from `request_secret`, never a raw code.
`list_hosts` lists reachable and unavailable machines with connection status.
`list_agent_targets` lists providers and models on one selected machine.
`remove_host` forgets a pairing. Both Claude
and Codex use the same tools. See [Pair hosts](host-pairing.md) for the CLI, client
credentials, access limits, and removal behavior.
