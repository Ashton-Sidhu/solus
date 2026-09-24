# Solus tool settings

Settings → Tools lists Solus agent tools by function: Works, External documents,
Automations, Browser, Sessions, Tasks, Intelligence, Connections, Insights, and
Configuration. Search by group or tool name. Each tool has a switch; each group
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

The Sessions group holds the orchestration tools: `start_session`,
`send_session`, `stop_session`, `read_session`, `read_task_sessions`,
`search_sessions` and `list_agent_targets`. See
[Session orchestration](session-orchestration.md).

Ask Jev requires a TypeSafe API key. Add or remove the saved host key under
Settings → Tools → Intelligence. Without a saved key or TYPESAFE_API_KEY in the
host environment, its switch is disabled and both providers omit the tool.
See [TypeSafe configuration](typesafe.md).
