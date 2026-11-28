# Antigravity provider

Status: phases 1 to 5 built on `solus/antigravity-provider`. The steps for the next provider are in `docs/adding-a-provider.md`. Reference: T3 Code at `pingdotgg/t3code` commit `b8ef0600` (`apps/server/src/provider/acp/Antigravity*.ts`, `apps/server/src/provider/antigravity*.ts`), MIT. Files that port T3 Code logic keep its notice.

## 1. Problem

Solus runs two agents: Claude Code and Codex. People also want Google Antigravity. Antigravity's CLI, `agy`, speaks the Agent Client Protocol (ACP) over stdio. Other agents speak ACP too, so Solus gets one ACP backend, and Antigravity is its first agent.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **ACP** | The Agent Client Protocol: JSON-RPC 2.0, one message per line, over the agent's stdin and stdout. |
| **ACP backend** | The Solus `AgentBackend` that runs an ACP agent (`execution/agents/acp/`). |
| **ACP connection** | One running `agy acp` process and its JSON-RPC channel. One connection serves one Solus session. |
| **Antigravity** | The provider. Its `AgentId` is `antigravity`. Its label is `Antigravity`. |
| **agy** | The Antigravity CLI. Solus starts it as `agy acp`. |
| **Managed install** | The copy of `agy` that Solus downloads into `<data>/agents/agy/releases/` (§6). |
| **Antigravity profile** | The folder that `agy` keeps its sign-in, settings, and sessions in (`GEMINI_HOME`). Each seat has its own profile (§7). |
| **Kept history** | The transcript rows that Solus writes for each turn of an ACP session (§5.4). `agy` keeps its own history in a private format, so Solus does not read it. |

Do not say "Gemini provider", "agy provider", or "ACP provider". The provider is Antigravity. ACP is how Solus talks to it.

## 3. Decisions

1. **One list of provider ids.** `AGENT_IDS` in `contracts/src/types.ts` is the one list. Every `z.enum` of provider ids reads it. Code that differs by provider uses a table keyed by `AgentId`, not a `claude ? … : codex` choice, so a third provider cannot fall through to Codex.
2. **ACP is a backend, Antigravity is its agent.** The ACP backend knows ACP. `acp/antigravity.ts` knows `agy`: how to start it, its modes, its tool titles, its sign-in, and its quirks. A second ACP agent adds a second agent file, not a second backend.
3. **One connection per session, kept between turns.** `agy` unpacks about 1 GB at each start, so a connection stays open after a turn. It closes after 10 minutes with no turn, on Stop of a stuck turn, and on host shutdown. A later turn resumes the session with `session/resume`.
4. **Steering with a second prompt.** `agy` 1.5.0 and later join a `session/prompt` sent during a turn to that turn. Solus sends a steered message that way, and the turn ends only when the newest prompt answers; an older prompt's answer, or failure, is ignored (T3 Code does the same). Once the newest prompt answers, the turn is closing, and a message that arrives then waits in the Solus queue. An older `agy`, or one whose version it does not report, gets no steering.
5. **Solus keeps the history.** The backend writes kept history rows for each turn (§5.4). History, search, and handoffs read those rows. Solus does not parse `agy`'s SQLite and protobuf files.
6. **Solus tools over MCP.** An ACP agent gets the Solus tools as an MCP server over HTTP (`mcpServers`, named `solus`) in `session/new` or the resume, from the host's `/mcp` endpoint (`bindRunTools`, `docs/plans/external-mcp-server.md` §9). `agy 1.5.18` omits `mcpCapabilities` from `initialize` even though it connects to HTTP `mcpServers`, so Antigravity sends `mcpServers` unless `mcpCapabilities.http` is explicitly `false`. On interactive sessions, Antigravity enables deferred-proxy mode (`deferToolsProxy: true`): `tools/list` publishes only `alwaysLoad` tools plus `tool_search` (8 KB inline schema budget) and `tool_call`, keeping prompt size small when many Solus and MCP server tools are installed and letting newly added MCP servers work on the next turn without restarting `agy`. Ephemeral runs (such as text generation) still list their small tool set directly. ACP gives MCP servers only at `session/new` or resume, so each run binds its own tools with the Solus session id as the key (between turns the token reaches none), and a connection reopens with `session/resume` only when the listed catalog changes. agy asks through `session/request_permission` before it calls a Solus tool: `tool_search` and non-destructive Solus/MCP tools (`!requiresApproval`) auto-allow across modes, while destructive tools follow the session's permission mode.
7. **Permissions come from Solus.** Solus starts `agy` in its `default` mode, where it asks before it acts, and answers each `session/request_permission` from the session's permission mode (§5.3). `agy` refuses its own `yolo` and `auto_edit` modes, so Solus never sends them.
8. **Managed install uses the agent software installer.** Antigravity is a third `AgentSoftware`, with a release adapter that reads Google's manifest. The installer verifies SHA-512 because the manifest publishes SHA-512. Solus turns off `agy`'s own updater on every launch.
9. **Seats use the relayed sign-in.** A seat's Google sign-in runs `agy acp --login` in the seat's profile, as the Claude and Codex seats run their CLI's login. Gemini Enterprise relays agy's own browser sign-in. A Gemini API key and a Vertex AI credential are pasted (§7).
10. **One record of how a profile signs in.** `solus-sign-in.json` in the profile names the method, its Google Cloud project and location, and any pasted key. The newest sign-in replaces it. The launch, the seat status, and a reconnect read it.
11. **Skills reach Antigravity both ways.** Settings → Skills installs for Antigravity with the `skills` CLI's `antigravity-cli` agent, which writes `~/.gemini/config/skills`. A person's agent profile also copies their skills into each Antigravity seat (§7.1).

## 4. Provider id wiring

| Area | Change |
|---|---|
| Contracts | `AgentId` adds `antigravity`. `AGENT_IDS` replaces the copied enums. `AGENT_BIN.antigravity = 'agy'`. `SetupAgent` adds `agy`. `seatProviderSchema` adds `antigravity`. Model profiles add an `antigravity` entry. |
| Server | `backend-registry.ts` registers the ACP backend. Tables keyed by provider replace the two-way choices in seats, setup, indexing, and insights. |
| Desktop and web | `ProviderMark`, the session chip, settings, and usage read the provider label and mark from one table. |
| Mobile | Solus provider ids already pass to the T3 client as driver ids. T3's client knows `antigravity`. The Solus mobile lists of providers add it. |

## 5. The ACP backend

### 5.1 Connection

- Start: `<agy> acp --gemini-dir <profile> --app-data-dir antigravity-acp` in the session's working directory, resolved with `resolveHomePath`.
- Environment: the seat's launch environment, without inherited Google, Gemini, and `agy` variables (`antigravity.ts`), plus `GEMINI_HOME=<profile>`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `PYTHONUNBUFFERED=1`, and, for a Google account, `SSH_CONNECTION` so that `agy` keeps the sign-in in the profile and not in the shared OS keyring. On macOS, `agy` 1.5.18 still keeps a Google sign-in in the keychain (item `gemini`), so Solus does not look for a token file: a clean exit of `agy acp --login` records the seat as verified (`verifiedAt`), as for Gemini Enterprise. A turn whose sign-in is gone fails with the sign-in error and asks for `/login`.
- Temp folder: each launch unpacks about 1 GB into its temp folder. A process that runs as the host's own user gets its own folder, `<profile>/antigravity-acp/tmp/run-*`, as `TMPDIR`, `TEMP`, and `TMP`. Solus removes it when the process exits, and the first launch of a backend removes the `run-*` folders that a crash left. A process that runs as another user (member isolation, §9) uses its own temp folder. The sign-in processes (`--login`, Gemini Enterprise) still use the host's temp folder.
- `initialize` with protocol version 1, `fs.readTextFile: true`, `fs.writeTextFile: false`, `terminal: false`, `elicitation.form`. Writes stay off: with them on, `agy` sends whole files instead of edits.
- `session/new` (first turn) or `session/resume` (later turns, after a restart or an idle close) with the working directory and the Solus MCP server. The session id that `agy` returns is the provider thread id.
- Codebase folders reach `agy acp` as repeatable `--add-dir` arguments. Solus starts a new process and resumes the conversation when the working directory or the set of granted directories changes. An active turn can read a newly granted folder through Solus. Its Antigravity workspace refreshes on the next prompt. The ACP backend sends the shared codebase block with the first prompt of each turn so a resumed session gets current folder information.
- A session that moves to another checkout (Continue in worktree, `move_checkout`, or a worktree offer) resumes its own thread in the new working directory on its next turn, as in T3 Code. The thread id stays the same, so agy keeps the conversation and the transcript keeps every turn; the session record moves the folder of the active thread (`moveSessionLineageThread`). Claude and Codex fork their thread into the new directory instead. ACP has no fork in Solus: a fork request fails with an error, because a new agy session holds none of the source thread.
- The managed install is always Google's current release. Solus does not check the version of an `agy` it did not install (§9).

### 5.2 Events

`session/update` becomes `NormalizedEvent`:

| ACP update | Solus event |
|---|---|
| `agent_message_chunk` | `text_chunk` |
| `agent_thought_chunk` | `thinking` (`start`, `update`, `stop` at the next non-thought update) |
| `tool_call` | `tool_call` |
| `tool_call_update` | `tool_call_update`; at `completed` or `failed`, `tool_call_complete` and `tool_result`. Its `content` replaces the call's output, as ACP says; output over 64 KB keeps its tail |
| `plan` | `progress` (todos) |
| `tool_call` titled `Run invoke_subagent` or `Run start_subagent` (and their `Running …` and `…?` forms), or `Run swarm` with action `add` | `tool_call` named `Agent` with `isSubagent` and `subagentType: antigravity`: the subagent card, with the role and prompt (`antigravity-subagents.ts`). A call that agy marks `is_mcp_tool_call` is an MCP server's tool. The child's own steps are not read yet |
| Other swarm calls (`swarm` kill, status, model…, `post_message`, `read_board`, `swarm_wait`) | a tool card with a readable title, such as `Post to #backend` |
| `tool_call` titled `Running client_view_file` whose file Solus served | completed when Solus serves the read: agy never completes a subagent's read and later fails it with an unrelated error |
| `tool_call` titled `Run update_steps` (kind `other`), and its later updates by id | `progress` (todos), no tool card: agy sends its checklist only this way (`antigravityStepsTool`) |
| `usage_update` | `usage` |
| `available_commands_update` (also outside a turn) | the agent's commands in the slash menu (`PluginCommandsResult.builtin`), kept in `<data>/acp-history/.<agent>-commands.json`: agy reports them only when a session opens |
| `user_message_chunk` | ignored (a replay of history) |

The `usage` of each `session/prompt` answer of a turn, steers included, adds to the turn's tokens in `task_complete`: agy's `inputTokens` leaves out cache reads, as Solus counts them, `cachedReadTokens` and `cachedWriteTokens` are the cache tokens, and `thoughtTokens` (part of the output) are the reasoning tokens. agy reports no cost. Insights prices the tokens from LiteLLM's price list at Google's own API rate (`gemini/<model>`), as it prices Codex tokens (`docs/model-prices.md`).

The `session/prompt` response ends the turn: `end_turn` gives `task_complete`; `cancelled` gives an exit with `SIGINT`; `refusal`, `max_tokens`, and `max_turn_requests` give `task_complete` with the reason as an error line.

### 5.3 Permissions

`session/request_permission` names a tool call with a `kind`. Solus picks an option of kind `allow_once` or `reject_once`, or asks the person:

| Permission mode | read, search, fetch, think | edit, delete, move | execute, other |
|---|---|---|---|
| `full-access` | allow | allow | allow |
| `auto`, `accept-edits` | allow | allow | ask |
| `supervised` | allow | ask | ask |
| `plan` | allow | deny | deny |

A request whose tool call id starts with `interaction_` is a question from the agent, not a permission. It shows as a question card.

agy's `ask_question` arrives as `elicitation/create` (form mode), which Solus advertises with `clientCapabilities.elicitation.form`. It shows as the MCP form card (`kind: mcp_form`) and is read and answered by the MCP form rules in `codex-permissions.ts`. Accept sends the fields; decline and Stop send only the action. An unattended run cancels the form.

### 5.4 Kept history

Each turn adds rows to `<data>/acp-history/<thread id>.json`: the prompt, the prose, the reasoning, and each tool row with its result. After each kept turn, the backend gives the history to `indexSessionMessages`, which adds the new user and assistant messages to the host's session search, as the Codex backend does for its turns. The rows are `SessionLoadMessage`s, so `loadSession`, `loadSessionPage`, and `loadSessionFirstTurn` read them directly. The replay backend writes the same rows, so the row writer moves to `agents/kept-history.ts`.

### 5.5 Models

`model-profiles.json` lists Gemini 4 Neon, Carbon, Argon, and Hydrogen, the three Gemini Orchestrator options, and the Gemini 3 models that Antigravity offers. Saved handoffs use the bundled list for a display name when the host catalog has no entry for that model ID. It includes the current [Enterprise model IDs](https://antigravity.google/docs/enterprise#supported-models-in-gemini-enterprise) and the older IDs that Solus already recognized. The `model` option of `session/new` names the models agy offers the account, and once agy has reported them they are the list (T3 Code also trusts the agent's list): the published list only gives the label, effort levels, legacy flag, and default of a model it knows, and is the list only before the first session. A model the published list lacks shows under agy's label. Each model's efforts are agy's: `session/new` also answers `models.availableModels`, which names each effort of a model as its own id (`gemini-4-neon-low` to `gemini-4-neon-xhigh`); the `thought_level` option lists them only for the selected model. A model with no such ids, such as an Orchestrator, has none. A published model agy does not offer is left out. As in T3 Code's model catalog, the published list marks Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.1 Pro legacy under both the current IDs and the older IDs (`gemini-3.7-flash-high`, `gemini-pro-agent`, and so on). The picker puts these models under Legacy when agy offers them. After `session/set_model`, agy resets the level and sends the new model's options only after its answer, so a run that changes the model always sends its effort, checked against the reported efforts of that model. The default is the published default when agy offers it, else agy's first model. The metadata says so with `modelsOffered`, and `agentForProject` then builds the instance catalog (hidden models, order, groups, custom models) on the offered models (`offeredModelProfiles`). Clients hear of a new report through `host.modelProfilesChanged`, as they do for Claude's reported models. agy reports the models only when a session opens, so the host also asks it without a turn (`AcpBackend.refreshModels`: `initialize`, `session/new`, then it stops the process): at boot when agy is installed and the host's login is signed in, after each Antigravity sign-in with that seat, and when a person refreshes the model list (`modelProfilesRefresh`: Settings → About on desktop and web, the model picker on mobile). A plan change on the account then shows without a session. A refresh that fails keeps the last list. On macOS, agy 1.5.18 answers `initialize` in under 0.1 s and writes nothing to its temp folder; the 1 GB unpack that T3 Code describes was not seen there.

Google Antigravity has one provider instance, the built-in `antigravity` (Settings → Providers). It has the enabled switch, a binary path (`DEFAULT_INSTANCE_BINARIES`: `agy`), and the model controls; the schema refuses a home, launch arguments, or environment on it, and the store refuses a second Antigravity instance. agy keeps its sign-in in one keychain item for every profile (§9), so a second instance could not hold a second account: sign-in stays in Seats. A stored document from before this gets the built-in instance when it is read. A client older than this change parses the instance snapshot strictly and fails on the new provider, so Settings → Providers needs a client of the same release. A run that asks for a model the account does not offer fails before its prompt with a clear message; an older id of an offered model (`gemini-3.8-flash-high`) still runs. The commands and models of the last report stay in `<data>/acp-history/.<agent>-report.json` (`acp-agent-report.ts`). The backend sends the model with `session/set_model` and the reasoning effort with `session/set_config_option` on the option of category `thought_level`, when the agent offers that option and that level.

### 5.6 Turn outcome

agy reports an upstream failure (a 502, a quota) as an answer and `end_turn`. Its session log, `<profile>/antigravity-acp/conversations/<thread id>.db`, ends that turn with an error step (type 17). Before the first prompt of a turn, the agent's `watchTurnOutcome` notes the log's last step and file identity. After the turn, it reads only the steps the turn added, read-only, and only from the session's own file: a link or another file gives no evidence. The rules port T3 Code's `AntigravityTurnOutcome.ts`.

- A quota or rate limit (`429`, `RESOURCE_EXHAUSTED`, `QUOTA_EXHAUSTED`, or the `refusal` stop reason) gives a `rate_limit` event with the reset agy names, and the run exits 0: it parks as a Claude or Codex limit does.
- Any other error step fails the run with the API's message. Google's account check names Google's link only.
- No error step: the stop reason is the whole answer.

## 6. Managed install

- Manifest: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<target>.json`, with `version`, `url`, and `sha512`. `<target>` is `darwin_arm64`, `darwin_amd64`, `linux_amd64`, `linux_arm64`, and so on.
- The package URL must be under `https://storage.googleapis.com/antigravity-public/antigravity-cli/`. The package is a `.tar.gz` that holds the `antigravity` executable.
- The install goes to `<data>/agents/agy/releases/<version>-<id>/` and is selected by `current.json`, as for Claude and Codex. An install keeps the new release and the one it replaced, which a running turn may still use, and removes every other release.
- The backend uses, in order: the managed install, then `agy` on the PATH.
- Settings shows Antigravity's install, version, and update state through the existing agent software status, on desktop, web, and mobile.

## 7. Sign-in and seats

- A seat's Antigravity profile is its seat folder: `<seats>/antigravity/<member folder>/`. The host login's profile is `<data>/agents/agy/profile/`, because `agy`'s default profile uses the OS keyring, which a remote sign-in cannot reach.
- **Google account:** the relayed sign-in runs `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp --login`. It prints a Google link. The person opens it on any device, signs in, and pastes the code from the Antigravity page into Solus. Solus writes it to the process's input. The seat is connected when the process exits with code 0 and `<profile>/antigravity-acp/acp_token.json` exists.
- **Gemini Enterprise:** the person gives a Google Cloud project and location. Solus writes them to `agy`'s `settings.json` and starts `agy acp` with `BROWSER` set to a helper in the seats' `bin`, which prints the link. `authenticate` with `oauth-business` sends Google's link with a redirect to a listener on the host. The person signs in on any device and pastes the address their browser ends on. Solus checks it (the listener's address, the sign-in's `state`, one code or one error, Google as the issuer) and sends it to the listener. The seat is connected when `authenticate` answers. `agy` keeps this sign-in where Solus cannot see it, so the record keeps the time it was accepted.
- **Gemini API key:** the person pastes a key. The record keeps it (mode 0600), and each turn gets it as `GEMINI_API_KEY`.
- **Vertex AI:** the person gives a project and location, and pastes a Google Cloud API key or their `application_default_credentials.json`. A key goes to each turn as `GOOGLE_API_KEY`; credentials are kept in the profile and named by `GOOGLE_APPLICATION_CREDENTIALS`. The project and location go in `settings.json`, because the key in the environment would win over them there.
- `/login` and a reconnect sign in the way the seat last signed in: a Gemini Enterprise seat keeps its project.
- Sign-out deletes the token, the record, and the credentials, and keeps the folder.
- A turn whose sign-in `agy` refuses (`-32000`, or "No browser is available here") marks the seat expired, as for Claude and Codex.

### 7.1 Skills and profile files

- `agy` reads a profile's global skills in `config/skills` and `antigravity-cli/skills`, and a project's in `.gemini/skills`, `.agents/skills`, and `.agent/skills`.
- The slash menu lists those skills, the project's first. A skill's name and description come from its `SKILL.md` front matter.
- The agent profile carries Antigravity's `skills` entry. For Antigravity, a profile's home is `<profile>/config`, so a copied skill lands where `agy` reads it. Registry skills are written there too. On the person's own computer, the profile is read from `~/.gemini/config` and `~/.gemini/antigravity-cli`.
- Settings → Skills passes `-a antigravity-cli` to the `skills` CLI (skills 1.9.0 knows it), which installs into `$HOME/.gemini/config/skills`. For the host owner that is the real `~/.gemini`, which the host login's profile links to. A member's CLI runs with their Claude seat as `HOME`, so Solus links `<Claude seat>/.gemini` to their Antigravity profile first, and the skill lands in `<profile>/config/skills`.
- The host login's profile links `config/skills`, `antigravity-cli/skills`, `AGENTS.md`, `GEMINI.md`, and `config/skills.json` to the owner's `~/.gemini`, so the host login reads what `agy` reads in a terminal. A folder that holds files is never replaced by a link.

- Plugin skills: the slash menu also lists the skills of each plugin in `<profile>/config/plugins/<plugin>/skills`, after the profile's own. A plugin that `<profile>/config/config.json` turns off (`plugins.<name>.enabled: false`) adds none. As in T3 Code, the person's own `~/.gemini` plugins are not linked into the host login's profile.

## 8. Phases

1. One provider id list and the provider tables. No behavior changes.
2. The ACP client, the backend, the Antigravity agent, kept history, and the provider wiring on every client.
3. The managed install.
4. Sign-in and seats.
5. Solus tools over `/mcp`: Solus tools, MCP integrations and app tools in a turn, text generation, and the review agent.

## 9. Later work and limits

- **Work that outlives the prompt (t12, done; read on agy 1.5.18).** A background command (`run_command` with a short `WaitMsBeforeAsync`) and a one-time `schedule` keep `session/prompt` open until they end, so their reply is part of the turn. A daemon call (`IsDaemon: true`, such as a recurring `schedule`) ends the prompt, and agy later sends `agent_message_chunk` updates with no prompt. The backend holds such updates (`acp-agent-work.ts`), wakes the session once with `background-task-completed` and the prompt `agentWorkPrompt`, and the turn that carries that prompt takes the held updates and sends no prompt, so agy does not answer twice. agy sends no end of its own work: that turn ends after `AGENT_WORK_QUIET_MS` with no update and no open call. A connection whose agent started a daemon call does not close when idle (`startsDaemon`).
- **A subagent's own steps (t8b, done; read on agy 1.5.18).** agy sends a child's own tool calls on the parent session as `<child session id>:call_…`. The launch call names no child, so `antigravity-children.ts` reads the child's database, read-only: `trajectory_metadata_blob` field 5 is the parent session and field 8 the launch (2 role, 3 prompt). The child's calls go into the card whose launch has that prompt (`parentToolUseId`); a child with no readable record goes to the newest launch with no child yet. Solus follows the native child transcript when it can verify the launch from the child's record or the parent's detached-subagent records. ACP keeps the live tool IDs it already reported. Solus adds missing calls and child replies, drains late replies before saving the turn, and keeps the result in the subagent card.
- **Plan mode (t14, done).** `applyMode` sets agy's `mode` option to `plan` for Solus's plan mode and to `default` otherwise. In plan mode agy writes its plan to `<profile>/antigravity-acp/brain/<session>/<name>.md` with `write_file` and `ArtifactMetadata.RequestFeedback: true`, without a permission request; `antigravityPlanTool` makes that call the plan card (`plan` event), as Codex's plan is.
- **agy's own MCP servers (m4, m5, done).** agy reads `<gemini-dir>/config/mcp_config.json` (`mcpServers` by name: `command`, `args`, `env`, or `url`, with the older `serverUrl`). The host login's profile links the person's `~/.gemini/config/mcp_config.json` (agy makes an empty file at each start, which the link replaces). The found-servers list reads that file as `antigravity-config`.
- **Version check (s4, done).** `agy --version` prints the bare version (`1.5.18`) in under a second, so an agy that Solus did not install is asked (`antigravityVersion`).
- **Threads in another place (h5, h6, h7, done).** A Solus thread keeps the id of the agent session that started it; `acp-thread-places.ts` maps it to the agent session in each profile. A profile without the session (another member's seat, or another host after the cloud copy) gets a new agent session whose instructions are the handoff seed (`buildHandoff` from the kept history; agy reads the transcript, checked on agy 1.5.18). The backend emits `thread-handed-off`, and the host records an `agent_switched` activity with the same provider before and after, so the transcript shows the same handoff divider as a switch of agent or model. The kept history is one JSON row per line and only grows, so `threadFiles` gives it to the session cloud copy and `importThread` writes it on the host that continues. A switch from Claude or Codex to Antigravity is the send-time handoff; its seed reaches agy through `session/new` `_meta.antigravity.systemPrompt.append`.

- **Writing and reviews.** Text generation (titles, codebase and worktree names, commit and pull request text) and reviews read the model's answer from a Solus capture tool, so `SOLUS_TOOL_AGENT_IDS` bounds those settings and pickers; Antigravity is in it since it reaches Solus tools over `/mcp`. As a writing fallback it comes last (`DEFAULT_TEXT_GENERATION_MODELS`), since each agy launch is slow.

What Antigravity still leaves out, and why:

- Antigravity quota and credits. ACP has no quota method. Google does not support third-party apps calling internal quota APIs or wrapping `agy -p /usage` for personal subscriptions. The scheduler uses the limit reported by the turn that reached it. [Google's ACP quota guidance](https://discuss.ai.google.dev/t/tos-clarification-read-only-agy-p-usage-credits-from-acp-clients-or-native-quota-surface/203283/2)
- Google and Gemini Enterprise sign-ins on a host with an OS keyring: `agy` keeps them in one keychain entry (`gemini`) for every profile. Seats on such a host share the last sign-in, and a sign-out in Solus does not remove the keychain entry.
- Gemini Enterprise and Vertex AI first sign-in on mobile (s10, out of scope by decision). Mobile has no seat settings for any provider; its `/login` signs in again the way the seat last signed in.
- Hosts where each member is their own OS user: the host object (solus-cloud `host-worker/src/member-users.ts`) makes `/run/solus-seats/antigravity/<user>`, the member's agy profile, and Solus writes the profile's settings as the member (`prepareAntigravityProfile` with the member's user). The sign-in record there is readable by the server's group, which starts agy with its method. The sign-in is in memory: after a restart a member signs in again (`forgetLostSignIn` drops the seat's stale `connected` row). agy's sessions (`antigravity-acp/conversations` and `brain`) are links to `/data/members/<user>/.antigravity-sessions`, which the backup keeps, as Claude's and Codex's transcripts are on disk: after a restart a thread resumes its own agy session. A recorded session that agy refuses to resume (`AcpRequestError`) continues by handoff (`continueSession`). A managed host refuses agent installs, so agy is in the host image (`/usr/local/bin/agy`). The cloud proof (`solus-cloud/host-worker/proof/run.ts --cloud --e2e`, 2026-11-27) showed: the folder (member, group `solus`, 2750); the sign-in as the member; `settings.json` 0640 (`applyMemberFiles` adds group read); agy 1.5.18 on Linux keeps its Google sign-in in `config/config.json` and `antigravity-acp/cache/acp-auth-state.json`, not `acp_token.json`; a real turn as the member's uid; and no write by the server user. Not yet proven on the cloud: the turn after a restore (handoff) and the member's removal.
- Antigravity seats on a Solus Cloud machine. The account keeps Claude and Codex connections only, so Settings hides the Antigravity seat there.

## 10. Where the code is

| Area | Files |
|---|---|
| ACP backend | `execution/agents/acp/acp-backend.ts`, `acp-connection.ts`, `acp-protocol.ts`, `acp-turn-normalizer.ts`, `acp-permissions.ts` |
| Antigravity | `execution/agents/acp/antigravity.ts` (launch, protocol, steering rule), `antigravity-auth.ts` (sign-in record, settings, environment), `antigravity-skills.ts` (skills and the host login's links) |
| Turn outcome | `execution/agents/acp/antigravity-turn-outcome.ts` |
| Work after the prompt, subagents, plan, threads | `execution/agents/acp/acp-agent-work.ts`, `antigravity-children.ts`, `antigravity.ts` (`antigravityPlanTool`), `acp-thread-places.ts`; the agent interface is `acp-agent.ts` |
| Kept history | `execution/agents/kept-history.ts` (shared with the replay backend) |
| Managed install | `updates/antigravity-software-adapter.ts`; SHA-512 in `updates/agent-software.ts` |
| Seats | `execution/seats/seat-manager.ts` (tables by provider, table migration, pasted credentials), `seat-login.ts`, `seat-connect.ts`, `antigravity-enterprise-sign-in.ts` |
| Sign-in form | `workspace-ui/src/components/seats/AntigravitySignIn.svelte`, `lib/antigravity-sign-in.ts`; the address step in `client-core/src/sign-in-steps.ts` |
| Provider ids | `AGENT_IDS`, `agentIdSchema`, and `AGENT_LABELS` in `contracts/src/types.ts` |
| Tests | `tests/unit/acp-backend.test.ts`, `antigravity-agent.test.ts`, `antigravity-seats.test.ts`, `antigravity-skills.test.ts`, `antigravity-sign-in-form.test.ts`, `antigravity-turn-outcome.test.ts`, `antigravity-plan-and-children.test.ts`, `antigravity-thread-handoff.test.ts`, `antigravity-version.test.ts`; the fake agent is `tests/unit/helpers/acp-fake-agent.ts` |

