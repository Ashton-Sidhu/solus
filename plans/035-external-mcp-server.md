# External MCP server

Status: phases 1 to 4 built; phase 5 needs a decision (§0.3). Reference: T3 Code at `pingdotgg/t3code` commit `60375a56` (`apps/server/src/mcp/`). User page: `docs/outside-apps.md`.

## 0. What was built, and where it differs from the design

### 0.1 Built

| Part | Where |
|---|---|
| One access rule for each tool (`TOOL_ACCESS`), checked before each call | `execution/agents/tools/tool-access.ts`, `execution/sessions/run-lifecycle.ts` |
| `/mcp` with run tokens; Claude over HTTP | `execution/agents/tools/agent-tool-endpoint.ts`, `transport/mcp-endpoint.ts`, `claude/claude-backend.ts` |
| Codex over `mcp_servers` (`solus` and `solus-direct`) | `codex/codex-solus-tools.ts`, `codex/codex-backend.ts` |
| The host's OAuth server, consent page, pairing codes, app grants | `transport/mcp-oauth.ts`, `admission/app-sign-in.ts`, `admission/auth.ts` (`app:<access>` rows in `host_device`) |
| The tools an outside app may use (`APP_TOOLS`) | `execution/agents/tools/tool-access.ts` |
| RPCs `connectionsAppEndpoint`, `connectionsCreateAppPairingCode` | `transport/handlers/connections-handlers.ts` |

### 0.2 Differences from the design below

1. **Tokens.** A Claude run gets a token for the run. A Codex session keeps one token across its runs, because Codex may keep a loaded thread's MCP config; between runs the token reaches no tools. There is no `ActiveRun` registry: the run that holds the token gives its tools, context, and approval (`RunToolBinding`).
2. **Approval.** Claude still asks through `canUseTool`, for each Solus tool that is not in `allowedTools`; this works the same over HTTP. Codex's approval comes from the endpoint, with the card the dynamic tools used, and the Codex adapter accepts Codex's own approval request for the Solus servers. `effect` was not added to the rule: `requiresApproval` stays the approval flag.
3. **Call ids.** §9.1 was not needed. The Claude CLI stamps `claudecode/toolUseId` on calls to every MCP server. Codex names no item, so a call takes the `mcpToolCall` item that Codex started for that tool and those arguments (`SolusCallItems`).
4. **Outside app approval.** The consent page starts the pair approval that a device uses (`PairApprovals` takes the grant it hands out), so the request already shows on desktop, web, and mobile. Through the public tunnel, only a pairing code approves: pairing is local authorization. A cloud machine has no app sign-in.
5. **App grants.** A grant is a `host_device` row of kind `app:read`, `app:write`, or `app:full`, so it is listed, revoked, and kept with the paired devices with no migration. It acts as the host owner (`via: 'local'`), bounded by its access. Tokens live while used within thirty days; there is no refresh token.
6. **Tools for outside apps.** The first list (`APP_TOOLS`) has only tools that work with no calling session: works, project and codebase reads, tasks except create, automations except create, and `list_agent_targets`, `search_sessions`, `read_session`, `start_sessions`, `stop_session`, `organize_session`. The `session_id` arguments, the requester key (§8), and the pull request, link, `send_session`, and `read_session_exchange` tools are not built yet.
7. **Provider of an app's call.** An outside app has no harness. Its calls record `claude-code` where a tool records a provider.
8. **Sessions that an app starts.** `createSession` with no parent now works for the tool call's person (`toolCallActor` in `prompt-dispatch.ts`), not the host. This also applies to a parentless session that a harness turn starts.

### 0.3 Phase 5: decision needed

Approval with a Solus account needs the account plane to treat a linked host as a client that signs a person in through a browser. Today a host client has no redirect addresses and only `client_credentials`, token exchange, and `refresh_token` (`solus-cloud: src/lib/server/auth/host-clients.ts`). The proposal:

1. Host clients also get `authorization_code`, with the redirect `<tunnel>/oauth/mcp/account/callback`, registered at link and when the tunnel address changes. Existing host clients are updated once.
2. The consent page sends the person to app.solus.sh with PKCE and `resource` = the host. The callback spends the code with `private_key_jwt` and checks the token as `access-tokens.ts` does.
3. The grant keeps the account principal (a new `host_device` column, by migration). Each `/mcp` call checks that the person is still a member of the organization, as the socket does.

This changes what a host may ask app.solus.sh for, so it is a decision for the maintainers before it is built.

## 1. Problem

Solus gives its tools to each harness in a different way:

- Claude gets an in-process MCP server (`createSdkMcpServer` in `execution/agents/claude/claude-tool-adapter.ts`).
- Codex gets dynamic tools, which are not MCP (`execution/agents/codex/codex-tool-adapter.ts`, the `item/tool/call` branch in `codex-backend.ts`).
- A tool gets the person's authority from an `AsyncLocalStorage` principal that is set when the turn is admitted (`execution/sessions/run-lifecycle.ts`, `credentialScopedAgentTools`).

So each new harness needs a new adapter, and no app outside the host process can use the tools. People want to use Solus from other apps: Claude Desktop, Cursor, Grok, ChatGPT, or their own Claude Code or Codex CLI.

## 2. Decisions

1. **One MCP endpoint on each host.** Every harness and every outside app connects to `/mcp` on the host. After the move, the two tool adapters are deleted.
2. **Two kinds of caller.** A *session caller* is a harness turn. Its token gives its session. A *client caller* is an outside app. Its token gives a person and a grant, and no session. A tool never takes "the calling session" from its arguments.
3. **One access gate.** Every tool declares its access. The endpoint checks it with `authorize()` (`admission/access-policy.ts`), the gate that RPC and the Solus API already use. A tool runs only after the gate passes. There is no second access model.
4. **Outside apps get an allow-list.** A tool is hidden from client callers unless it sets `exposeToApps: true`. About 45 tools are on the list (§7). Harnesses still get every tool.
5. **Integrations only through a session.** No integration tool is on the outside list. To use an integration, an outside app starts a session. The session runs as the person and uses that person's integrations. Integration tokens never leave the host.
6. **Approval moves into the endpoint.** The endpoint asks for approval in the same way for every harness and every outside app. The harnesses do not ask a second time.
7. **Each host is its own OAuth server.** Outside apps sign in with OAuth to the host, as in T3 Code (`apps/server/src/auth/McpOAuth.ts`). This works on a host that is not linked to an account. The person approves the sign-in in the Solus app or with a pairing code. On a linked host, the person can also approve it by signing in to their Solus account (§10).
8. **Cards come from the tool result.** A tool whose card shows in the conversation returns the card's data in its result (`structuredContent`). The event normalizers build the card from the row's own result. No tool depends on a call id that the harness sends in `_meta`. T3 Code does the same (`packages/shared/src/htmlRender.ts`).

## 3. The endpoint

- `POST`, `GET`, and `DELETE` on `/mcp`, on the host's Hono app (`transport/http.ts`). It uses streamable HTTP with the `Server` from `@modelcontextprotocol/server`, which Solus already uses in `integrations/solus-servers/solus-server.ts`.
- A request with an `Origin` header gets `403`. This stops browser requests and DNS rebinding. (T3 Code: `McpHttpServer.ts:400`.)
- A request with no usable token gets `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. There is no default principal and no fallback to `system`.
- Addresses:
  - A harness on the same host uses `http://127.0.0.1:<port>/mcp`. The host always listens on loopback (`boot-server.ts`).
  - An outside app uses the host's tunnel URL or a LAN address, plus `/mcp`. OAuth needs `https://` or `localhost`.

## 4. Callers and tokens

```ts
type McpCaller =
  | { kind: 'session'; requester: `session:${string}`; sessionId: string; run: ActiveRun }
  | { kind: 'client'; requester: `client:${string}`; principal: Principal; grant: McpGrant }

/** Set by the run launcher when a run starts, cleared when it ends. */
interface ActiveRun {
  runId: string
  actor: Actor
  provider: AgentId
  cwd: string
  tools: AgentTool[]          // the run's list, with its integration and app tools
  permissionMode: PermissionMode
  emit(event: NormalizedEvent): void
  abortSignal: AbortSignal
}

interface McpGrant {
  grantId: string
  label: string               // "Claude Desktop"
  level: 'read' | 'write' | 'full'
  scopes: SolusApiScope[]
}
```

### 4.1 Session tokens

- A token is 32 random bytes. The host keeps only its SHA-256 hash, in memory, linked to the Solus `sessionId`. (T3 Code: `McpSessionRegistry.ts`.)
- The host makes the token when the session's provider process or thread starts. It drops the token when the session is released or stopped, or when the session is handed to another provider. A handoff gets a new token.
- The token gives only the session. The actor, cwd, tools, `emit`, and stop signal come from the session's `ActiveRun` when the call arrives.
  - A call between turns is refused: "no active turn".
  - In a shared session, a later turn can work for another person. Each call uses the person of the current turn.
  - A Claude process that stays open between turns keeps its token.
- A host restart drops all session tokens. Restart recovery starts the provider again with a new token.

### 4.2 Client tokens

- The host issues them (§10). Each token is opaque. The host keeps its hash with a grant record in its database: grant id, app label, person, level, scopes, creation time, and expiry. An access token lives one hour. A refresh token lives 30 days.
- Admission reads the grant and gives:
  - an `owner` principal when the host owner approved the sign-in (in the app or with a pairing code);
  - the account's principal (`owner` or `org-member`) when the person approved it with their Solus account on a linked host;
  - and the `McpGrant` in both cases.
- A client token is accepted only on `/mcp`. A normal client token is refused on `/mcp`. (T3 Code: `EnvironmentAuth.ts:723-730`.)

## 5. Tool access

### 5.1 The rule of each tool

Every Solus tool has one rule in `TOOL_ACCESS` (`execution/agents/tools/tool-access.ts`). The table is keyed by tool name and must name every tool in `SOLUS_AGENT_TOOL_NAMES`: the type check fails when a tool has no rule, as it does for an RPC method that the access tables do not name (`contracts/src/permissions.ts`). A tool made for one run (an integration's tool, a resource tool, an app operation) carries its rule in its own `access` field. A tool with no rule is refused.

```ts
type ToolAccess =
  | { permission: Permission }                                  // a permission on the host
  | { action: ResourceActionPath; resource: ToolResource }      // a verb on the record the call names

/** The record a call names: from an input field (`work_id`, `session_id`, …), or the session the call runs in. */
type ToolResource = (input: ToolCallInput, callerSessionId: string | undefined) => AccessResource | null
```

Each rule is the rule of the RPC method for the same action. For example, `update_work` needs `edit` on the work (as `agentSaveWork`), `run_automation` needs `drive` on the automation (as `automationRun`), the pull request writes need `host.git.write` (as `prMerge`), and a tool that acts on its own session needs the verb on that session (`move_checkout` needs `drive.prompt`, as `sessionAttachFolder`).

Later phases add two fields to the rule:
- `effect: 'read' | 'write' | 'destructive'` (Phase 2, when approval moves into the endpoint; `destructive` then replaces `requiresApproval`);
- `exposeToApps: true` (Phase 4).

There is no Solus API scope in the rule. The scope list has no scopes for automations, projects, or pull requests, so the grant level (read, write, or full) is the only limit on an outside app.

### 5.2 The gate

The check is `toolAccessRefusal(tool, input, callerSessionId, principal)`. It calls `authorize()` (`admission/access-policy.ts`), the decision that RPC and the Solus API use, through `toolActionRefusal` in `admission/workspace-tool-authority.ts`. Phase 1 runs it in `credentialScopedAgentTools` (`execution/sessions/run-lifecycle.ts`), before each tool call of a run, with the turn's principal. A refused call returns an error result and the tool does not run.

The endpoint runs these checks in this order. A tool runs only when all of them pass.

1. **Caller.** A client caller may call only an `exposeToApps` tool (Phase 4).
2. **Grant.** For a client caller, the tool's `effect` must be within the grant level (Phase 4).
3. **Person.** `toolAccessRefusal` with the principal of the caller: the actor of the active run, or the client's principal.
4. **Settings → Tools switch.** This stays in `executeAgentTool`.
5. **Approval** (§6).
6. **Run.** `execute` runs inside `withActorScope(actor)` and `withWorkspaceToolAuthority(principal)`, with an `AgentToolContext` built from the caller.

`tools/list` uses the same rules: the caller kind, the grant, and the host permission. Resource checks run only on a call. A session caller gets the `tools` of its active run. When they change, the endpoint sends `notifications/tools/list_changed`.

MCP annotations come from the rule:
- `effect` becomes `readOnlyHint` and `destructiveHint`.
- `alwaysLoad` becomes `_meta: { "anthropic/alwaysLoad": true }`. T3 Code uses this for Claude (`toolkits/orchestrator/tools.ts:221`).

### 5.3 A call with no principal

Some tools still read "no principal" as the host's own work and act as `system` (`app-tools.ts`, `automation-tools.ts`, `webhook-tools.ts`, `insights-tools.ts`, `add-mcp-server-tool.ts`, `connect-integration-tool.ts`, and `toolMayRead` and `assertToolMay`). This stays: plans/031 rule 1 says that the host's own work, with no person, may do everything, and `tests/unit/tool-access.test.ts` keeps that rule. The risk is closed at the gate instead. `toolAccessRefusal` takes a principal that cannot be absent, and every way into a tool (a run's tools, and later the endpoint) runs it first. The endpoint never sends a request with no principal to a tool.

### 5.4 Access gaps fixed in Phase 1

These tools could be reached from the harness turns of organization members and guests:

| Tool | Gap | Now |
|---|---|---|
| `update_config` | Wrote host config and SSH device hosts with no check (`config-tools.ts`) | `host.connect`, and `host.admin` for the `host` and `deviceManager` sections |
| `reply_comment`, `resolve_comment` | No access check | `comment` on the work, or on the session of a plan |
| `publish_work`, `pull_work_upstream` | No role check on the local path | `edit` on the work |
| Every host-wide tool from a guest's turn | A guest's turn reached tools that its guest cannot reach from a client | Refused: a guest has no `host.use` (plans/031: "a guest still reaches only its link's resource") |

These gaps are for callers with no session, so they move to Phase 4:

| Tool | Gap |
|---|---|
| `create_automation`, `create_webhook` | With no session, the host user becomes the owner. Record the actor as the owner. |
| `start_sessions` | With no parent, the session runs as the host (`prompt-dispatch.ts:388-399`). Run as the caller's person. |

`read_task` has no gap: the task RPCs also use `host.use`.

## 6. Approval

**A session caller with a `destructive` tool.** The endpoint follows the session's permission mode:

- `plan`: refuse.
- `full-access`: run.
- Any other mode: emit the existing `permission_request` card on the session, wait for the person's answer, and use the input-request owner (`execution/sessions/input-requests.ts`).

The harnesses must not ask a second time:
- Claude gets `mcp__solus__*` in `allowedTools`.
- Codex sends its own MCP approval requests to the app as `mcpServer/elicitation/request`, which Solus already handles (`codex-backend.ts`). The endpoint asks by card, never by elicitation, for a session caller. So an elicitation from the `solus` or `solus-direct` server can only be Codex's own approval request, and the adapter accepts it at once. No Codex config key is needed. (T3 Code routes these requests in `CodexAdapterV2.ts:6532`.)

**A client caller with a `destructive` tool.**
- If the client supports MCP elicitation, the endpoint asks through elicitation.
- If it does not, a `full` grant runs the tool and any other grant refuses it.

A session that a client starts gets approval cards in Solus as normal. Its highest permission mode comes from the grant level.

## 7. Tools for outside apps

The rule: an outside app acts directly on records. Anything that needs a live environment (a checkout, the browser, a device, a card in a conversation, an integration) it gets by starting a session. T3 Code uses the same rule (`docs/user/outside-agents.md`).

### 7.1 Exposed (`exposeToApps: true`)

| Area | Tools | T3 Code tools they match |
|---|---|---|
| Sessions | `list_agent_targets`, `list_sessions`, `search_sessions`, `read_session`, `start_sessions`, `send_session`, `read_session_exchange`, `stop_session`, `organize_session`, `queue_session` | `t3_thread_*`, `t3_thread_launch`, `orchestrator_capabilities`, `t3_queue` |
| Projects | `list_projects`, `read_project`, `create_project`, `clone_project`, `update_project`, `list_codebases`, `read_codebase` | `t3_project_*` |
| Tasks | `list_tasks`, `read_task`, `create_task`, `comment_task`, `update_task_status` | issues |
| Pull requests | `pull_request_list`, `pull_request_read`, `pull_request_create`, `pull_request_update`, `pull_request_respond`, `pull_request_review`, `pull_request_merge`, `ci_logs`, `ci_rerun`, `list_thread_pull_requests`, `link`, `unlink`, `list_links` | pullRequests |
| Automations | `create_automation`, `list_automations`, `read_automation`, `update_automation`, `delete_automation`, `run_automation`, `list_automation_runs` | `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` |
| Works | `list_works`, `read_work`, `create_work`, `update_work` | none (T3 Code has no works) |

### 7.2 Inside sessions only

- `browser_*` and `device_*`.
- `render_artifact` and the app tools.
- The webhook tools, `query_insights`, `add_host`, `remove_host`, `list_hosts`, `connection_status`, `connect_integration`, and `add_mcp_server`.
- `request_secret`, `background_wait`, `move_checkout`, `checkout_status`, `attach_folder`, `watch_pull_request`, and `fork_session`.
- `comment_document`, `reply_comment`, `resolve_comment`, `read_plan`, `publish_work`, `pull_work_upstream`, and `request_work_review`.
- `delete_project`, `update_codebase`, `delete_codebase`, `read_config`, `update_config`, `read_theme`, and `update_theme`.
- Every integration tool, the integration resource tools, and the app operation tools.

To add a tool to the list, set `exposeToApps`, make it work with no session (§8), and add a test.

## 8. Sessions and ids

An outside app never has a session id at the start. T3 Code works the same way (`threadAccess.ts:241-262`).

- **Optional `session_id`.** An exposed tool that acts on a session takes an optional `session_id`. A session caller that leaves it empty gets its own session. A client caller gets: `Pass session_id: this app is not running inside a Solus session.` The app finds ids with `list_sessions` and `search_sessions`, or from the result of `start_sessions`.
  - `list_sessions` takes `project` or `all_projects` when it has no session.
  - The pull request tools use the checkout of the session they name.
- **Requester key.** Every caller has a requester key: `session:<id>` or `client:<grantId>`. Exchanges use this key instead of `senderSessionId` (`execution/orchestration/exchange.ts`, `exchange-ledger.ts`). Then `start_sessions`, `send_session`, and `read_session_exchange` work for an outside app, and a request that is sent again is found again. (T3 Code: `requestNamespace`, `McpOAuth.ts:644`.)
- **Sessions that a client starts.** A session that `start_sessions` starts for a client caller:
  - runs as the client's person, with that person's seat and integrations;
  - gets its organization from `organizationForNew(principal)`;
  - has a permission mode at or below the grant level;
  - is marked "Started by <app label> via MCP" and shows in the person's session list, where it can be opened or stopped like any session.
- **Results.** `start_sessions` in wait mode waits up to 600 s. For longer work, the app calls `read_session_exchange` or `read_session`.

## 9. Harness configuration

| Harness | Configuration |
|---|---|
| Claude (Agent SDK) | `mcpServers.solus = { type: 'http', url, headers: { Authorization }, timeout: 65 min }`, and `allowedTools: ['mcp__solus__*']`. Tool names stay `mcp__solus__*`, so transcripts do not change. |
| Codex app-server | On `thread/start` and `thread/resume`: `config["mcp_servers.solus"] = { url, http_headers, tool_timeout_sec: 3900 }`. The `alwaysLoad` tools are also put on `mcp_servers["solus-direct"]` with `enabled_tools` and `omit_tools_from: ["deferred"]`, as T3 Code does (`CodexAdapterV2.ts:1680-1767`). `codexToolNameForItem` reads `solus-direct` as `solus`. |
| Later harnesses | The same URL and header. |

Codex `mcpToolCall` items are already handled (`codex-utils.ts:752`, `codex-event-normalizer.ts:949`), and `mcpServer/elicitation/request` is already answered (`codex-backend.ts`). An MCP call is named `solus.<tool>`, the same name as a dynamic call today.

Both timeouts are above the one-hour wait of `request_secret`.

### 9.1 Cards and progress without a call id

Today three outputs are attached to their own transcript row by call id: `render_artifact` (`artifact_created`), `update_work` (`work_updated`), and integration progress (`tool_progress`). After the move:

- `render_artifact` and `update_work` return the card's data in `structuredContent`. The Claude and Codex event normalizers make the card from the row's own result.
- Integration progress uses MCP progress notifications. Codex turns them into `item/mcpToolCall/progress`, which Solus already handles.
- `parentToolUseId` is deleted from `AgentToolContext`.

## 10. Outside app sign-in and UI

**OAuth on the host.** The routes follow T3 Code (`packages/contracts/src/environmentHttp.ts:683-731`):
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` name the host as the authorization server.
- `/.well-known/oauth-authorization-server` gives the host's endpoints.
- `/oauth/mcp/register` registers a client. The host signs the `client_id` with the app name and redirect URIs, so registration stores nothing. (T3 Code: `McpOAuth.ts:148-155`.)
- `/oauth/mcp/authorize` shows the consent page: the app name, the host, and the access level to choose (read, write, or full). It uses authorization code with PKCE. A code lives 60 seconds.
- `/oauth/mcp/token` and `/oauth/mcp/revoke`.

**How the person approves.** Approval uses one of three ways:
1. **In the Solus app.** The consent page opens a pair approval on the host (`admission/pair-approvals.ts`). The app shows it on desktop, web, and mobile, and the owner approves or denies it there. This needs no account.
2. **With a pairing code.** The owner makes a one-time code in Settings and types it on the consent page. This needs no account, and it works when the app is not open.
3. **With a Solus account.** This works only on a linked host. The consent page signs the person in through the host's existing account sign-in (plans/010). This is the only way for an organization member, who is not the host owner, to connect an app.

**Where it works.**

| Host | Apps on the same machine (Claude Code, Codex, Claude Desktop, Cursor) | Cloud apps (claude.ai, ChatGPT) |
|---|---|---|
| Not linked | Yes: `http://localhost:<port>/mcp`. OAuth accepts `localhost`. | No: they need a public `https` address. |
| Linked, with a tunnel | Yes | Yes: `https://<tunnel>/mcp` |

OAuth needs `https://` or `localhost`, so a plain `http://` LAN address cannot complete the sign-in.

**Setup.**
```sh
claude mcp add --transport http solus https://<host>/mcp
claude mcp login solus
```
Other apps use their own connector screens with the same URL.

**UI on desktop, web, and mobile.**
- Settings → Connections gets **Use Solus in other apps**, with:
  - the MCP URL and a copy button;
  - the `claude mcp add` command;
  - the connected apps, with their level and a **Revoke** button.
- A **Make pairing code** button.
- The command palette opens the same page.
- Revoke deletes the grant on the host. The next call with its token gets `401`.

## 11. Lifecycle

| Event | Result |
|---|---|
| A run starts | The run launcher sets the session token's `ActiveRun`. |
| A turn ends | `ActiveRun` is cleared. Calls are refused until the next turn. |
| The session is released, stopped, or handed to another provider | The token is dropped. A handoff gets a new one. |
| The host restarts | Session tokens are lost, and restart recovery makes new ones. Client grants are in the database, so client tokens still work. |
| A turn is stopped | `abortSignal` cancels the calls in progress. |
| A grant is revoked | Its tokens are refused at once with `401`. |
| An org member is removed from the organization | Their grants are refused, because admission checks the account principal on each call. |

## 12. Changes by area

| Area | Files |
|---|---|
| Endpoint, tokens, caller, gate | new `packages/server/src/transport/mcp/`; `transport/http.ts` |
| Tool access | `execution/agents/tools/tool-access.ts` (`TOOL_ACCESS`), the per-run tool builders, `admission/workspace-tool-authority.ts` |
| Approval | the gate, `execution/sessions/input-requests.ts` |
| Harness configuration | `claude-backend.ts`, `claude-agent.ts`, `codex-backend.ts`, `codex-utils.ts`; delete `claude-tool-adapter.ts` and the tool code in `codex-tool-adapter.ts` |
| Run binding | `execution/sessions/run-launcher.ts`, `run-lifecycle.ts` (delete `credentialScopedAgentTools`) |
| Sessions and ids | the exposed session and pull request tools, `execution/orchestration/exchange*.ts`, `prompt-dispatch.ts` (`createSession`) |
| Client sign-in and admission | new `admission/mcp-grants.ts` (grant records, tokens), the OAuth routes and consent page, a door for client tokens in `admission/doors.ts`, reuse of `admission/pair-approvals.ts` |
| Cards from results | `artifact-tools.ts`, `work-tools.ts`, the Claude and Codex event normalizers, integration progress in `integrations/` |
| UI and contracts | Settings → Connections in `packages/workspace-ui` and `apps/mobile`; the calls that list and revoke grants and make a pairing code in `packages/contracts/src/rpc.ts` |
| Docs | this plan; a user page about other apps |

## 13. Phases

1. **Access foundation.** Done: `TOOL_ACCESS`, the check before each tool call of a run, and the gap fixes in §5.4 (`tests/unit/tool-access-table.test.ts`). Harness behavior changed only where §5.4 says.
2. **Endpoint and Claude.** Add `/mcp`, session tokens, `ActiveRun`, the gate, and approval. Move the cards to tool results (§9.1). Move Claude to HTTP. Delete the in-process server.
3. **Codex.** Move Codex to `mcp_servers` with `solus-direct`, and accept its approval elicitations for the Solus servers. Delete the dynamic tools.
4. **Outside apps.** Add OAuth on the host with approval in the app and by pairing code, client admission, `exposeToApps`, the `session_id` arguments, requester keys, `start_sessions` as the person, and the UI on all three clients.
5. **Account approval.** Add approval with a Solus account on linked hosts, for organization members.
6. **Docs.** Add the user page and update `docs/` where tool behavior changed.

## 14. Tests

- **Gate:**
  - A client caller cannot list or call a tool without `exposeToApps`.
  - A read grant is refused every `write` and `destructive` tool.
  - An organization member is refused a session or work that is not shared with them.
  - A request with no token gets `401`.
  - A request with an `Origin` header gets `403`.
- **Every tool:** a test goes through the toolbox. Each tool has `access`. Each exposed tool works with no session, or gives the "pass session_id" error.
- **Session token:** a call between turns is refused. Each call uses the actor of the current turn. A dropped token is refused.
- **Approval:** a destructive call waits for the card. `plan` refuses it. `full-access` runs it. The harness does not ask a second time.
- **Codex:** a `solus-direct` call shows as the same transcript row as a `solus` call.
- **Outside session:** `start_sessions` from a client caller runs as that person, with that person's integrations, not the host's.
- **Sign-in:** an approval in the app and a pairing code each give a token. A denied approval, an expired code, or a reused authorization code gives none. A wrong PKCE verifier is refused. A revoked grant gets `401` on its next call.
- **Cards:** `render_artifact` and `update_work` show their cards from the tool result, on Claude and on Codex.

## 15. Settled questions

1. **Call ids from the harness.** Not needed. Cards come from the tool result and progress from MCP progress notifications (§9.1). T3 Code reads no call id from `_meta`.
2. **Codex approval of Solus tools.** No config key. The Codex adapter accepts Codex's own approval elicitations for the Solus servers (§6).
3. **Hosts with no account.** They use the host's own OAuth with approval in the app or by pairing code (§10). Only cloud apps need a linked host, because they need a public `https` address.
