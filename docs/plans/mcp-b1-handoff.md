# MCP B1 handoff: stdio servers on the host

Branch: `solus/stdio-mcp-host-servers-and-saved-facts`, from
`solus/merge-mcp-branches-and-build-a1-facts` (`5127e4f0e`). Nothing was
pushed. No pull request was opened. B1 is §7.1 to §7.6 and §7.9 of
`mcp-first-class.md`. It builds no UI.

## The contract for B2, C1, and C2

### Types (`packages/contracts/src/integration-types.ts`)

- `integrationKindSchema`: `mcp | solus | stdio`.
- `integrationLaunchSchema` / `IntegrationLaunch`: `{ command, args, cwd? }`, strict.
- `Integration.launch?` (stdio only) and `Integration.projectKey?` (§8.4).
- `stdioServerAddressSchema`: `stdio:<16 hex>`. The host computes the address
  with `stdioServerAddress(launch)` in `server/src/integrations/stdio-process.ts`.
- `integrationAuthSchema` gains `{ kind: 'env', names }` (at least one name).
  `remoteIntegrationAuthSchema` / `RemoteIntegrationAuth` is `none | oauth |
  bearer`; the agent profile entry and the probe result use it.
- `integrationEnvNameSchema`, `integrationEnvNamesSchema` (unique, at most 64),
  `integrationEnvValueSchema` / `IntegrationEnvValue` (`{ name, value }`).
- `integrationCreateRequestSchema` is a union of
  `integrationUrlCreateRequestSchema` (`{ name, url, slug? }`) and
  `integrationCommandCreateRequestSchema` (`{ name, commandLine | launch,
  envNames = [], slug?, projectPath? }`). A client tells them apart with
  `'url' in request`.
- `integrationUpdateRequestSchema` gains `launch?` and `envNames?`.
- `integrationConnectStartResultSchema` gains `{ kind: 'env', integrationId,
  accountId?, names }`.
- `integrationConnectSubmitRequestSchema`: `value?` or `values?`, not both;
  `values` goes with `id`.
- `IntegrationFacts.process?: IntegrationProcessFacts` =
  `{ state: 'stopped' | 'running' | 'failed'; message?; stderrTail? }`. No PID.
- `integrationProcessStartRequestSchema`: `{ id, recheck? }`.
- `splitCommandLine(line)` in `contracts/src/integrations/command-line.ts`:
  `{ ok: true, launch: { command, args } } | { ok: false, reason }`. The
  dialog shows its result; the host uses the same function.

### RPC methods (`rpc.ts`, `rpc-planes.ts` plane `execution`, `host-api.ts`)

| Method | Access in `permissions.ts` | Handler rule |
|---|---|---|
| `integrationCreate` (command form) | `host.use` | `host.admin`; starts nothing |
| `integrationUpdate` with `launch` or `envNames` | `host.use` | `host.admin`, owner; drops the saved facts and stops the process; new names remove every person's values |
| `integrationProcessStart({ id, recheck? })` → `IntegrationFacts` | `host.use` | `host.admin`, owner, `stdio` only |
| `integrationProcessStop({ id })` → `{ stopped }` | `host.use` | owner, `stdio` only |
| `integrationConnectStart` | `host.use` | answers `kind: 'env'` for an `env` integration |
| `integrationConnectSubmit({ id, accountId?, values })` | `host.use` | one value for each name, no other |
| `integrationFacts`, `integrationTools` | `host.use` | for a `stdio` integration: the saved facts when no process runs; they start nothing |
| `integrationDisconnect` | `host.use` | for `env`: removes the person's values |
| `integrationRemove` | `host.use` | stops the process, removes the values, the saved facts, and the record |

The handler checks `host.admin` with
`permissionsAllow(permissionsFor(principal), 'host.admin')`. The refusal text
is "Only an administrator of this host can add or change a command." B2
shows it in place of the form.

### Events

`integration.changed` with `change: 'facts'` follows each start, stop, end,
and failed start of a process. `change: 'tools'` follows a new list that
differs from the saved one. `change: 'created' | 'updated' | 'removed'` as
for the other kinds.

### Tables and modules

- `integration.launch` (json) and `integration.project_key` (text), and the
  host table `integration_server_facts (integration_id, user_id, account_id,
  verdict, verdict_at, facts, stored_at)`. Migration:
  `packages/server/drizzle/sqlite/0002_stdio_integrations.sql`. There is no
  Postgres migration: these are host tables, which live in `solus.db` only.
- `integrations/stdio-process.ts`: the address, the transport, `StderrTail`,
  and `StdioProcessStates`.
- `integrations/server-facts-store.ts`: `ServerFactsStore` (`get`,
  `saveVerdict`, `saveFacts`, `dropVerdict`, `dropVerdicts`, `removeAllFor`).
- `integrations/integration-create.ts`: `createStdioIntegration`,
  `launchOfRequest`, `commandAuth`. C1's add from a file uses
  `createStdioIntegration` with `launch` and `projectPath`.
- `IntegrationGateway`: `startProcess`, `stopProcess`, `forget` (drops the
  saved facts too), the constructor option `{ clock?, savedFacts? }`.
- `IntegrationConnections`: `submitEnvironment`, `environmentFor`.
- `Vault`: `saveEnvironment`, `readEnvironment`, `removeEnvironment` (this
  host's store only).
- `integrationToolbox(actor, projectPath?)`: a project integration joins only
  the runs whose working directory has its key; a `stdio` integration joins
  only the runs of a person with `host.admin`.

C2 matches a CLI server to a Solus integration by address: a `stdio`
integration's `launch` gives `[command, ...args]` for `serverCommand`.

## The process lifecycle

| State | How it is reached | What happens next |
|---|---|---|
| `stopped` (no record) | Never started, or a change of the record | The next use starts it |
| `running` | A start that gave an MCP answer | Calls use it |
| `stopped` | Idle 10 minutes, **Stop**, host stop (`gateway.close()`), or eviction by the limit of 16: no message (B2 found that only an end by itself has one) | The next use starts it |
| `stopped` + message | An end by itself ("`<name>` stopped by itself.", with the standard error tail) | The next use starts it |
| `failed` + message | Three ends within 10 seconds of a start in 5 minutes (a failed start counts), or a command `spawn` cannot find or run | Only `integrationProcessStart` or a change of the record starts it |

A call in flight when the process ends answers "`<name>` stopped while it
ran `<tool>`." A start with no MCP answer in 30 seconds is "`<name>` did not
answer as an MCP server within 30 seconds." An end before the answer is
"`<name>` ended before it answered as an MCP server." After a crash of the
host, each child reads end-of-file and stops by itself; Solus never looks for
old processes. The gateway stops only the child the SDK transport started,
through `client.close()`. Logs: `integration_process_started` and
`integration_process_stopped` (integration id, person, PID, the size of
standard error), `integration_process_start_failed`,
`integration_process_evicted`.

## The environment rule

The child gets the SDK's default set (`HOME`, `LOGNAME`, `PATH`, `SHELL`,
`TERM`, `USER` on macOS and Linux), `PATH` replaced with the login shell's
(`getCliPath()`), and the person's values. Nothing else of the server's
environment. The values are read from the vault at each start. They are in
no record, log, RPC answer, or agent process. The standard error tail can
hold a value the server printed; only the owner gets it, in
`IntegrationFacts.process.stderrTail`. No command line or argument is logged.

## Contradictions between the plan and the code

The plan document now records each one.

1. The brief asked for a Postgres migration. `integration` is a host table,
   which is in `solus.db` only, so only SQLite has a migration.
2. §7.3 says `PATH` in `process.env` is the login shell's. It is not; the
   gateway passes `getCliPath()`.
3. §7.3 says the lint rule covers the call. It guarded `execution/agents/`
   only. B1 adds `integrations/stdio-process.ts` (not all of `integrations/`,
   because `mcp-apps.ts`, which H1 owns, has a `cwd` field that is not a spawn).
4. §7.5 names the column `person_key`. The data-model test allows `user_id`
   only. B1 also adds `verdict_at`.
5. §7.6 names Start again and Test again but no method. B1 adds
   `integrationProcessStart`.
6. §7.3 counts a Settings read as a start. B1 starts only on use or on
   `integrationProcessStart`.
7. §8.4 says `run-launcher.ts` gives the project key. The toolbox takes the
   path, so `run-launcher.ts` (over 1,000 lines) gains no import.
8. §7.4 refuses `$(`; B1 also refuses `${` and `$NAME`.

## Checks

- `bun test tests/unit/integrations/`: 232 pass, 0 fail (17 files; the new
  `stdio.test.ts` has 16 tests and was run three times).
- Server `check`: 130 diagnostics before and after, the same set.
  Contracts 0 and 0. Mobile 0 and 0. Workspace UI 39 and 39. Client core 2 and 2.
- Data-model, agent profile, vault, RPC plane, and runtime instruction tests pass.
- Failures that are also on the base commit: `agent-tool-schema-size`
  (110,064 bytes, unchanged), one label in `native-mobile-integrations`, one in
  `native-mobile-agent-profile`, `integrations-store` "a tools change reloads",
  `native-mobile-host-integration`, and `server-module-boundaries` (files in `host/`).
- Targeted `oxlint`: no new finding. `callAs` complexity is 24 (23 before),
  for the one line of the stopped text.

## Not done or not verified

- No UI (B2). Desktop, web, and mobile show a plain message for a
  `kind: 'env'` start result until B2.
- Not exercised: the Electron main process, the standalone server, a shared
  host with members, a remote host, Windows (`.cmd` shims, §7.3).
- The limit of 16 has no test: it needs 17 processes.
- An MCP App call (`callAppTool`) starts a command without the `host.admin`
  check that runs gate; only the owner reaches it.
- A person who loses `host.admin` keeps their records and values; their runs
  stop getting the tools.
- New environment names remove every person's values without a
  `connectionChanged` event; clients see it at the next connection read.
- `gateway.ts` is 962 lines (722 before). A2, A3, and H1 also add to it; the
  merge can pass 1,000 lines and then needs a split.
