# Adding a provider

This guide tells you how to add an agent provider to Solus. A provider is the runtime and adapter through which Solus runs an agent, such as Claude Code, Codex, or Antigravity.

The guide comes from the work that added Antigravity (`docs/plans/antigravity-provider.md`). Use that plan and its code as the worked example. Every file that this guide names has an Antigravity entry that you can copy.

## 1. Before you write code

Do these steps first. They decide most of the work.

1. **Find the protocol of the agent.**
   - If the agent speaks ACP (Agent Client Protocol, JSON-RPC over stdio), use the generic ACP backend (`execution/agents/acp/acp-backend.ts`). You write one small agent definition. This is the short path.
   - If the agent has its own protocol, write a backend that implements `AgentBackend` (`execution/agents/agent-backend.ts`). Use the Codex backend (an app server over JSON-RPC) or the Claude backend (an SDK) as the model. This is the long path.
2. **Look for a reference implementation.** T3 Code (`pingdotgg/t3code`) supports many providers. A port of its rules saves time, because it shows the protocol facts that the documentation of the agent leaves out. T3 Code is MIT. Keep its notice in each file that ports its logic (see `acp/antigravity-auth.ts`).
3. **Write a plan** in `docs/plans/<provider>-provider.md`. Lock the vocabulary and the decisions in it. Copy the sections of `docs/plans/antigravity-provider.md`.
4. **Make a decision for each capability** in the table in §2. "Unsupported" is a valid decision. An accidental gap is not.
5. **Find out how the agent signs in, and where it keeps its files.** Seats (one sign-in for each person on a host) need a profile folder that the agent reads. An agent that keeps its sign-in in one OS keyring entry for all profiles needs a workaround (Antigravity: `SSH_CONNECTION`, see `antigravityEnvironment`).

## 2. The capability lists

Solus decides what a provider can do from a few lists. Add the provider to each list that applies. Do not make a new copy of a list.

| List | File | Add the provider when |
|---|---|---|
| `AGENT_IDS`, `AGENT_LABELS`, `AGENT_BIN` | `contracts/src/types.ts` | Always. `AGENT_BIN` is the command name. |
| `SESSION_AGENT_IDS` | `contracts/src/types.ts` | It can run a whole session with nobody watching: automations and worker sessions. |
| `SOLUS_TOOL_AGENT_IDS` | `contracts/src/types.ts` | It can call Solus tools (§6). Text generation and reviews need this, because they read the answer from a Solus capture tool. |
| `seatProviderSchema` | `contracts/src/seats.ts` | It has seats (§4). |
| `AGENT_PROFILE_ENTRIES`, `PROFILE_PROVIDERS` | `contracts/src/agent-profile.ts` | A person's agent profile (skills, files) can reach it. |
| `DEFAULT_TEXT_GENERATION_MODELS` | `contracts/src/settings.ts` | It can write titles and commit text. The key order is the fallback order. |
| `SKILLS_CLI_AGENTS` | `server/src/skills/skills-cli.ts` | The `skills` CLI can install skills for it. Find its agent name with `npx skills --help`. |
| Model profiles | `contracts/src/model-profiles.json`, and the profile schema in `types.ts` | Always. The copy on `main` is the published list: hosts download it each day (`updates/model-profiles-service.ts`). |

These copies of a list exist. Update them too, or replace them with a list above:

- `contracts/src/webhooks.ts` (`agentProvider`)
- `contracts/src/provider-model-settings.ts`
- `apps/mobile/solus-core/features/conversation/lib/run-settings.ts` (`PROVIDERS`)
- `apps/mobile/solus-core/features/settings/lib/agent-profile-entries.ts`

To find a missed list, search for a string such as `'claude-code', 'codex'` in `packages/` and `apps/mobile/solus-core/`.

## 3. The backend

### 3.1 An ACP agent

Write one file, `execution/agents/acp/<provider>.ts`, that exports an `AcpAgent` (`acp-agent.ts`). Copy `acp/antigravity.ts`. The interface has these parts:

| Member | What it does |
|---|---|
| `launch(request)` | The command, its arguments, its environment, and the connection key. Two runs with the same key share one process. Set `tempRoot` when the agent unpacks large files at each start. |
| `sessionMeta` | The `_meta` of `session/new`, for an agent that takes Solus's instructions there. |
| `nameTool` | Maps the agent's tool titles to Solus cards (`Edit`, `Agent`, `mcp__solus__<tool>`). Return null to keep the generic rule. |
| `isSignInRequired(error)` | Which error means "sign in again". |
| `isQuestion(toolCallId)` | A permission request that is really a question for the person. |
| `steersWithPrompt` | Whether a `session/prompt` sent during a turn joins that turn. |
| `listCommands` | The agent's skills for the slash menu. |
| `signInMessage`, `mcpServerName` | The text for a missing sign-in, and the name of the Solus MCP server. |
| `stepsTool?`, `isClientRead?`, `watchTurnOutcome?` | Optional rules for the agent's checklist, its file reads, and errors that it reports as answers. |
| `planTool?`, `childCalls?`, `startsDaemon?`, `hasThread?` | Optional rules for the plan file it writes in plan mode, the calls of its subagents, work it keeps running after a prompt, and whether a profile holds a session (else the thread continues there by handoff). Give `launch` a `place` (the profile) for the last. |

Then register the backend in `execution/agents/backend-registry.ts`:

```ts
['<provider>', new AcpBackend({ agent: <provider>Agent, historyDirectory: join(solusDir(), 'acp-history') })],
```

The generic backend already does these things for every ACP agent:

- Turns, prose, thinking, tool cards, and tool output (an update replaces the output, as ACP says).
- Permissions from the permission mode (`acp-permissions.ts`), questions, and forms (`elicitation/create`).
- Steering, Stop, and resume.
- Kept history (`agents/kept-history.ts`), so history shows after a restart, and session search.
- Token usage from each `session/prompt` answer.
- The agent's commands (`available_commands_update`) and the models it offers, kept in `<data>/acp-history/.<agent>-report.json`.
- Solus tools over `/mcp` (§6).

Read the agent's real output before you trust a rule. Agents differ from the ACP schema. For example, agy reports a failed API call as an answer with `end_turn`, and a checklist as a tool call.

### 3.2 An agent with its own protocol

Implement `AgentBackend` and extend `BaseAgentBackend`. Map the agent's events to `NormalizedEvent` (`contracts/src/types.ts`). Then:

- Emit `session_init` first, then the turn's events, then `task_complete` or an error, then `exit`.
- Give `loadSession`, `loadSessionPage`, and `loadSessionFirstTurn` the history as `SessionLoadMessage` rows. If you cannot read the agent's own history files, keep the rows with `KeptHistory`.
- Call `indexSessionMessages` after each turn, so session search finds the session.
- Report a rate limit as a `rate_limit` event, so the run waits for the reset.

## 4. Install, sign-in, and seats

- **Managed install:** write a software adapter in `server/src/updates/` (copy `antigravity-software-adapter.ts`), and add it to `update-status-service.ts`. Check the download with its published digest.
- **Host setup:** add the setup step in `transport/handlers/setup-handlers.ts` (`SETUP_AGENTS`), `SetupAgent` and the `install-<command>` step in `types.ts`, the host capability flag (`agents.<command>`), and the onboarding row in `workspace-ui/.../servers/lib/host-onboarding.ts`.
- **Seats:** add the provider's folders and files to the tables in `execution/seats/seat-manager.ts` (`SEAT_FOLDERS`, `LOGIN_FILES`, `CREDENTIAL_FILES`). Add the sign-in flow in `seat-login.ts` and `seat-connect.ts`. Add the `/login` command in `contracts/src/agent-auth.ts`.
- **Sign-in UI:** add the provider to `seats/SeatConnectPanel.svelte`, `seats/lib/seat-copy.ts`, and `client-core/src/sign-in-steps.ts`. Give it its own form only when it has more than one sign-in method (`seats/AntigravitySignIn.svelte`).

## 5. Models and prices

- Add the models to `model-profiles.json`. Mark one model `isDefault`.
- An ACP agent's own model list joins the picker by itself (§3.1).
- Insights prices tokens from LiteLLM's price list (`docs/model-prices.md`). A provider that reports no cost gets its cost from that list, by the model maker's own API name. Add the provider to `applyTaskCompleteAttrs` (`execution/observability/session-emitter-support.ts`) when it reports tokens but no cost.

## 6. Solus tools

The host serves each run's Solus tools on its `/mcp` endpoint (`execution/agents/tools/agent-tool-endpoint.ts`, `bindRunTools`). A provider gets them as an MCP server over HTTP.

- The generic ACP backend does this already. It binds each run's tools with the Solus session id as the key, because ACP gives MCP servers only at `session/new` or a resume.
- A backend of its own calls `bindRunTools` for each run and gives the agent the URL and the `Authorization` header (see the Codex and Claude backends).
- Map the agent's title for a Solus tool to `mcp__solus__<tool>` in its tool namer, so the call shows the same card as in a Claude session.
- When the provider can call Solus tools, add it to `SOLUS_TOOL_AGENT_IDS` (§2).
- Run `tests/unit/agent-tool-schema-size.test.ts`. A new value in a provider enum makes the tool list larger. Raise `tests/unit/agent-context-budget.json` on purpose only.

## 7. Clients

Every client must show the provider. Desktop and web share the Svelte workspace UI. Mobile is its own app.

- **Marks and labels:** `ui/ProviderMark.svelte`, `servers/ProviderLogo.svelte`, `pickers/SessionChip.svelte`, `insights/lib/provider.ts`, and `lib/agentAvailability.ts`.
- **Subagents:** `conversation/lib/subagent-group.ts` (`subagentBackend`) maps a subagent's type to the provider.
- **Slash menu:** an agent's reported commands come through `PluginCommandsResult.builtin` (`editor/autocomplete.svelte.ts`).
- **Insights:** add a column to the volume query in `server/src/data/insights/turn-page.ts`, the field in `MetricsTurnVolumeBucket` (`contracts/src/observability-types.ts`), the band in `insights/VolumeChart.svelte` and `insights/lib/volume.ts`, and a colour in `workspace.css`. The cloud console has the same query in `solus-cloud/src/lib/server/observability.ts`.
- **Mobile:** the T3 frontend in `apps/mobile/` often knows the provider already. Add the provider to the Solus lists in `apps/mobile/solus-core/` (§2). Follow `apps/mobile/AGENTS.md` before you change mobile logic.

## 8. Docs and tests

- Write the user doc, `docs/<provider>.md`: setup, sign-in, what works in a session, and the limits. Copy `docs/antigravity.md`.
- Keep the plan current: update it when a decision changes.
- Test at the lowest layer:
  - Protocol rules (`<provider>-agent.test.ts`): tool names, questions, the sign-in error, the steering rule.
  - The backend with a fake agent (`tests/unit/acp-backend.test.ts`).
  - Sign-in and seats (`antigravity-seats.test.ts`).
- Run `bun run api:generate` when a contract that the API describes changes, then `bun run api:check`.
- Use a temporary `SOLUS_DATA_DIR` for every test. Never use the live data folder.

## 9. Traps we met

- **An update outside a turn is dropped.** The ACP backend reads updates only while a turn runs. An agent that reports work after its prompt answers (agy's background commands) needs more design (`docs/plans/antigravity-provider.md` §9).
- **An agent that starts slowly.** agy unpacks about 1 GB at each start. Do not start the agent only to read a fact (its commands, its models). Keep the fact from the last session, and give each process its own temp folder.
- **An error as an answer.** agy reports a failed API call as an answer. Read the agent's own session log to find the real result (`acp/antigravity-turn-outcome.ts`).
- **A picker that offers what a setting refuses.** A picker that lists every backend can offer a provider that the setting's schema does not take. Build the picker from the same list as the schema.
- **Tests that depend on a provider count.** Some tests assert the list of providers or the size of the tool list. Run the related tests, not only your new ones.

## 10. Checklist

Before you call the provider done, state for each line whether it applies:

- [ ] The provider id is in every list of §2 that applies, and in no new copy.
- [ ] The backend runs a turn, stops, resumes, and keeps history after a restart.
- [ ] Permissions follow the permission mode. Questions show as question cards.
- [ ] Install, setup, sign-in, sign-out, and seats work. A failed sign-in shows `/login`.
- [ ] The model picker shows the models. Insights shows the turns, tokens, and cost.
- [ ] Solus tools reach the agent, or the plan records why not.
- [ ] Desktop, web, and mobile show the provider's mark, label, and models.
- [ ] Session search finds the provider's sessions.
- [ ] The user doc and the plan are current.
- [ ] Focused tests cover each rule, and the related tests pass.
