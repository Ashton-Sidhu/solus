# MCP C2 handoff: the CLI skip

Branch: `solus/skip-duplicate-provider-mcp-servers`, from
`solus/merge-mcp-wave-branches` (`4908f45fc`). Nothing was pushed. No pull
request was opened. C2 is §8.5 of `mcp-first-class.md`.

## Commits

- `feat(mcp): leave out the provider CLI copy of a server that Solus runs`:
  the rule, the decision, the log, both adapters, the contract field, tests.
- `feat(mcp): show in Settings which CLI copies a run left out`: the words in
  client-core, the desktop and web field, the mobile field.
- `docs(mcp): say which MCP servers are whose; hand off C2`: this file,
  `docs/solus-tools.md`, `docs/integrations.md`, and the two plan documents.

## The proof for the user scope

Method: the Claude Agent SDK `query()` of the worktree (SDK 0.3.322) with the
installed CLI (Claude Code 2.1.314), a prompt stream that never sends a
message, and `Query.mcpServerStatus()`. No model turn ran. The CLI had a
temporary `HOME` and `CLAUDE_CONFIG_DIR` in the session scratchpad and only
`PATH` from the environment, so no credential was present. The MCP servers
were the test fixture `tests/fixtures/fake-stdio-mcp-server.mjs` (legacy era),
each with `--starts <file>`, so each process start wrote a file. The run used
Solus's `settingSources: ['user', 'project']`. **Cost: none** (no model call,
no credential).

| Configured | Without flag settings | With the deny list in flag settings |
|---|---|---|
| user stdio (`~/.claude.json` `mcpServers`) | connected, started | absent, **not started** |
| project stdio (`.mcp.json`) | connected, started | absent, not started (`serverCommand`) |
| project stdio, denied by `disabledMcpjsonServers` only | connected, started | absent, not started |
| user HTTP `…/exact`, denied with the same URL | listed | absent |
| user HTTP `…/mcp/`, denied with `…/mcp` | listed | **still listed** |
| user HTTP `http://EXAMPLE.test/a`, denied with lower case | listed | absent |
| user HTTP `https://…:443/b`, denied without the port | listed | absent |
| user HTTP `https://example.test`, denied with `https://example.test/` | listed | absent |
| user HTTP `…/c?x=1`, denied with `…/c` | listed | still listed |
| arguments in another order | listed | still listed |
| local scope (`projects["<path>"].mcpServers`) | **not loaded** | — |

Result: the flag settings apply the deny list to the user scope and to the
project scope, and the CLI starts no process for a denied server. The
fallback `toggleMcpServer` is not needed. The local scope loads only with the
`local` setting source, which Solus does not pass.

Codex (0.167.0), also free: `codex app-server` with a temporary `CODEX_HOME`,
`initialize`, `config/read`, and `thread/start` with `ephemeral: true` and no
turn. `config/read` gives each server's `command`, `args`, `url`, `enabled`,
and `origins["mcp_servers.<name>.command" | ".url"].name.type` (`user` or
`project`). A thread with `{}` started the three stdio servers; a thread with
`mcp_servers.userAlpha.enabled = false` and `…projectGamma.enabled = false`
started only `userBeta`. `mcpServerStatus/list` lists all servers in both
cases (it ignores the thread config). `thread/resume` could not be tested: a
thread has no rollout before its first turn. The app-server process was
stopped by its own handle (`child.kill`).

## The rule for equal addresses

`sameServerAddress` in `packages/server/src/integrations/cli-skips.ts`:

- **URL:** equal after `comparableServerUrl`: parsed with `URL` (case of the
  scheme and the host folded, default port dropped), no fragment, no slash at
  the end of the path. The query counts. Only `http:` and `https:`.
- **Command:** the same program and the same arguments in the same order,
  exactly. `npx` and `/usr/local/bin/npx` differ.
- **Environment:** not part of the address (it holds the person's values).

## What each provider does

The toolbox (`integrationToolbox`) returns `cliSkip: RunCliSkip`: the servers
of each integration that adds at least one tool to this run, and `report`.
`run-launcher.ts` passes it on `AgentRunRequest.cliSkip`.

- **Claude Code** (`claude/claude-cli-skip.ts`, `claudeRunSkip`):
  `deniedMcpServers` in the run's flag settings, `serverCommand` for a
  command, `serverUrl` with and without the slash for a URL. A URL with `*` is
  not denied. A bare run (it has `strictMcpConfig`) does nothing. It reports
  one entry for each server, with no name.
- **Codex** (`codex/codex-cli-skip.ts`, `readCodexSkipConfig`): `config/read`
  on the run's client (only when there is a server), then
  `mcp_servers.<name>.enabled = false` for each configured server with an equal
  address that is not turned off already, in `thread/start`, `thread/resume`,
  and `thread/fork`. It reports the name and the layer of each. A bare run
  does nothing (it turns off every server already). A failed read leaves every
  copy loaded and reports nothing.
- **Cost at run start:** Claude: none (a few objects). Codex: one
  `config/read` request on the client the run uses anyway, and only when the
  run has a server to leave out. No process starts.
- **Reverse:** the skip is made again at each run. Remove the integration, or
  turn off all its tools, and the next run gives the CLI its copy back. No
  provider file is written.

## The visible state

`CliSkipLog` (in memory, one per host) keeps the last report of each provider
for each (person, integration). `integrationFacts` adds `cliSkips`
(`IntegrationCliSkip { provider, serverName?, scope? }`) when there is one. A
change sends `integration.changed` with `change: 'facts'`; the open rows read
the facts again. `integrationUpdate` and `integrationRemove` drop the entries.

| Client | Where | Follows |
|---|---|---|
| Desktop and web | The open row of the server in Settings → MCP, field **CLI copy** under Tools (`McpCliSkipNote.svelte`) | The row's own `field()` (as Account, Tools): label in `text-workspace-chrome` secondary; lines in `text-workspace-chrome text-foreground` (as "Connected as …"); the note in `text-chrome-dense` tertiary (as the row's address line) |
| Mobile | The open row in `IntegrationsScreen.tsx`, under the tools (`CliCopyNote`) | "Instructions for the agent": the label `text-sm text-foreground`, the lines `text-sm text-foreground-muted`, and `SettingsNote` for the note (as "Only its owner can change this server.") |

The words are in `client-core/mcp-cli-skips.ts`, so the three clients say the
same: "Claude Code does not load its own copy at this address.", "Codex does
not load “linear” from ~/.codex/config.toml.", and the note "Only in runs that
Solus starts, so the agent sees each tool once. Remove this server to give the
copy back." No dialog was added or changed.

States: absent until a run reports (also after a host restart); stale reads
follow the `facts` event; the row has no action of its own.

## Screenshots

The web demo of `apps/client`, served from this worktree by Vite with a
temporary wrapper config in the scratchpad (root `apps/client`, base `/`, the
`.git` deny rule relaxed, because the worktree path is under `.git/`), and a
temporary fact for Linear in the demo handler. The edit was removed; nothing
temporary is committed. The server was stopped by its PID. Files:

- `/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-76eb8d83/72530bcb-9007-40d5-8510-013ba993883d/scratchpad/screenshots/01-cli-copy-web-light.png`
- `/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-76eb8d83/72530bcb-9007-40d5-8510-013ba993883d/scratchpad/screenshots/02-cli-copy-web-dark.png`
- `/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-76eb8d83/72530bcb-9007-40d5-8510-013ba993883d/scratchpad/screenshots/03-cli-copy-web-narrow-dark.png` (430 px: the field stacks and wraps)

## Contradictions between the plan and the code

Each is now in the plan (§1 items 24 to 27, §8.5 "As built", §2, §15, §19).

1. §8.5 says to send `disabledMcpjsonServers` with the names from `.mcp.json`.
   Not needed: the deny list by command or URL leaves out a project server too.
2. §8.5 names `Query.mcpServerStatus()` as the way to see the result. A denied
   server is absent from it, not `disabled`, so Solus cannot read back which
   Claude copy it left out.
3. Claude's local scope (`projects["<path>"].mcpServers`) never loads in a
   Solus run (`settingSources` has no `local`). **For C1:** a found server from
   that key is not in Solus runs at all.
4. Codex `mcpServerStatus/list` ignores the thread config.
5. §2 named "the two provider backends" as the owner; the decision is in
   `integrations/cli-skips.ts` and the backends only apply it.
6. `mcp-integrations.md` §8 planned a note from the init event; the init event
   does not name a denied server. That section now points to §8.5.

## What C1 needs to know at the merge

- C2 does not read any config file. The Claude skip needs no name. The Codex
  skip reads names from `config/read` at run start.
- A found server (C1) in state `added` has, by §8.2, an integration with the
  same address. C1's `added` test and C2's `sameServerAddress` must agree:
  use `sameServerAddress` (or `comparableServerUrl`) for the URL match, or C1
  shows `added` for a server that C2 does not leave out (a URL with another
  slash, for example). `stdioServerAddress` (B1) hashes the exact command and
  arguments, which agrees with C2 for commands.
- The Claude line has no file. C1's found server knows the files; at the merge
  the row could name them from `FoundServer.foundIn`.

## Tests and checks

- `bun test tests/unit/integrations/`: **284 pass, 0 fail** (20 files). New:
  `cli-skip.test.ts` (17 tests): the near cases of the rule, the Claude deny
  list and flag settings (kept with the other flag settings; a bare run denies
  nothing), the Codex config (a server Solus does not run, a look-alike, a copy
  with another environment, a copy turned off already, the scope), the read
  only when needed, a failed read, the project scope, every tool off, the log
  and its event, removal, and the words. Changed: one assertion of
  `gateway.test.ts` compared the whole toolbox answer.
- `native-mobile-integrations`: 48 pass, 1 fail, the label assertion that
  fails on the base too.
- Also pass alone: `claude-executable` (12), `runtime-instructions`,
  `codex-dynamic-call-id`, `codex-permission-modes`. `runtime-instructions`
  and `claude-executable` fail 4 tests when run in one process: both mock
  `cli-env` and the SDK. This change does not touch either test.
- Type checks (`tsc` of each package), before → after: server **129 → 129**
  (only line numbers moved), workspace-ui 39 → 39, client-core 2 → 2,
  contracts 0 → 0, mobile 0 → 0. `svelte-check` reports nothing in
  `McpServerRow.svelte` or `McpCliSkipNote.svelte`.
- `oxlint` on the changed files: no new finding in a new file. The complexity
  of `ClaudeAgent.run`, already over the limit, is 32 (31 before), for the one
  `if` that adds the deny list. `codex-backend.ts` `run` and the Claude
  generator are unchanged.
- `bun run lint:surfaces` clean. `bun run lint:layout`: the same three files
  as the base (`ProjectChip`, `RunOnPicker`, `EditorVoiceControl`).

## Not done or not verified

- **Mobile was not run** (it needs a native build). Its change passes `tsc`;
  the words are tested in `cli-skip.test.ts`.
- Desktop (Electron) was not run; the web demo shows the same Svelte row.
- No real provider turn ran. The Claude proof is the status of a query with no
  turn; the Codex proof is `thread/start` with no turn.
- `thread/resume` of a Codex thread that the app-server still holds was not
  tested. If Codex ignores the new config there, a change of the integration
  applies to that thread only after the app-server unloads it.
- A Claude copy written with a URL that differs in a way the CLI does not fold
  (for example `%7E` against `~`) is not denied, though `sameServerAddress`
  calls it equal. The Claude line in Settings is then wrong for that server.
- An update through the agent profile pull (`profile-integrations.ts`) does not
  drop the log entry; the next run corrects it.
- The skip covers runs that Solus starts. The CLI in a terminal is not changed.
