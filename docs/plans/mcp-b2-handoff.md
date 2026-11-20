# MCP B2 handoff: stdio servers in Settings

Branch: `solus/stdio-mcp-settings-across-clients`, from
`solus/merge-mcp-wave-branches` (`4908f45fc`). Nothing was pushed. No pull
request was opened. B2 is §7.7 of `mcp-first-class.md`, on the B1 contract
(`mcp-b1-handoff.md`).

## Commits

- `ef247f05e` feat(mcp): add, change, and start stdio MCP servers in Settings.
- `218892e19` fix(mcp): say once why a command cannot change, and keep the
  values line whole (found in the screenshots).
- The commit that adds this file and the docs.

## What was built

### Shared (`packages/contracts`)

- `integrations/command-server.ts`: one rule for every client.
  `commandProcessStatus` gives the state, its label, its tone, the host's
  message, the standard error tail, the actions (main first, each with
  `isEnabled`), and `blockedReason`. `checkCommandDraft` checks the add and
  edit form with `splitCommandLine` and `parseEnvNames`; `commandLineText`
  writes a launch back as one line that splits to the same launch;
  `suggestedCommandName`; `commandValuesText`; `commandHostNote`;
  `COMMAND_ADMIN_ONLY` (the host's refusal text).
- `IntegrationProcessFacts.startFailure?: 'not-installed' | 'not-runnable'`,
  set by `StdioProcessStates.startFailed` (`server/src/integrations/stdio-process.ts`)
  when `spawn` could not start the program. Without it, a command that is not
  installed and one that crashed three times were the same `failed` state.

| State | Label | Actions |
|---|---|---|
| facts not read | Checking… | none |
| start from this client runs | Starting… | Cancel (stops the process) |
| `running` | Running | Stop, Test again |
| `stopped`, no message, no verdict | Not started | Start and test |
| `stopped`, no message, verdict saved | Stopped | Start and test, Test again |
| `stopped` + message | Stopped by itself | Start again, Test again |
| `failed` | Failed | Start again |
| `failed`, `not-installed` | Not installed | Start again |
| `failed`, `not-runnable` | Cannot run | Start again |

Without `host.admin`, every action but Stop and Cancel is off and
`blockedReason` is "Only an administrator of this host can add or change a
command." A command with names and no saved values has its starts off with
"Enter the environment values first."

### Desktop and web (`packages/workspace-ui/src/components/settings/`)

- `integrations.store.svelte.ts`: the flow `values` (names only),
  `submitValues` (the values go to the host in one call and stay in no flow,
  error, or state), `loadFacts`, `startProcess`, `stopProcess`,
  `processStarts`, `processErrors`. The facts of each command load with the
  list and again on `integration.changed` (`facts`, `tools`, `updated`), so a
  second client is never stale. `cloudFor` answers null for an `env`
  integration: the values never go to Solus Cloud. `create` and `update`
  take the full request types.
- `lib/mcp-command.svelte.ts` (`McpCommandForm`): the add and edit form; it
  sends nothing and shows the refusal for a person without `host.admin`.
  `takeValues` hands the values over once and clears them.
- `lib/mcp-connect.svelte.ts`: `ConnectRequest.isCommand`, the step
  `command`, `startCommand` (save, values, start, then tools),
  `cancelCommandStart`; a dialog that closes before the end removes the
  command it added, which stops the process.
- `McpConnectDialog.svelte`: the command step; the refusal in place of the
  form; the process state and error under the form. Its border is gone
  (maintainer's feedback): it separates by `modal-backdrop` and
  `--solus-popover-shadow`.
- `McpServerRow.svelte`: the command line in place of the address, the
  process label, **Enter values** in place of Connect, the fields Command
  (with Edit), Process, and Values, "Edit command" in the menu, and the
  remove text of a command.
- New: `McpCommandFields.svelte`, `McpCommandProcess.svelte`,
  `McpCommandValues.svelte`, `lib/mcp-page-request.svelte.ts`.
- `IntegrationConnectForm.svelte`: the values form and the values status, for
  the row and the conversation's connect card.
- `McpServerIcon.svelte`: a terminal for a command (no logo request for a
  `stdio:` address).
- `SettingsTabMcp.svelte`: **Add command** beside Installed; the palette
  request; the search also matches the program.
- Palette: "Add an MCP server command" (`lib/settings-commands.ts`
  `mcpCommands`, on desktop and web).

### Mobile (`apps/mobile/src/features/settings/`)

- `integrations.ts`: the flow step `values`, `connectStarted` for `env`,
  `connectsThroughCloud` false for `env`, "Needs values" and "Values saved",
  `installedRowLine`, `serverAddressLine`.
- `use-integrations.ts`: `addCommand`, `editCommand`, and `submitValues` in
  `useIntegrationConnect`.
- `use-command-processes.ts` (new): the facts of each command, read with the
  list, on reconnect, and on `integration.changed`; start, stop, `statusOf`.
- `components/CommandServerForm.tsx`, `CommandServerDetails.tsx`,
  `CommandProcessPanel.tsx`, `CommandValueFields.tsx` (new);
  `IntegrationConnectPanel.tsx` gains the values step (the conversation sheet
  too); `IntegrationsScreen.tsx` gains the Command section and the command row.
- Difference of interaction: on mobile the form closes when the record is
  made, and the row shows the start (and its failure). The add is not taken
  back when the start fails; Remove is on the row. Desktop and web take it
  back when the dialog closes before the end.

### Elements and the existing element each follows

| New element | Follows |
|---|---|
| Add command (desktop, web) | "Add skill" in `SettingsTabSkills.svelte` (section action, outline `sm`, `Plus`) |
| Command form fields | the API key form of `McpConnectDialog.svelte` (label `text-workspace-chrome font-medium`, `Input` `h-8`) |
| Argument chips under the line | the tool access badge in the dialog's done table (`rounded-md bg-muted px-1.5 py-0.5`) |
| Process field | the Account field of `McpServerRow.svelte` (`IntegrationConnectForm`: status left, outline then ghost buttons right) |
| Standard error disclosure | "Instructions for the agent" in `McpServerRow.svelte` |
| Values fields | the API key field (`Input type="password"`) |
| Command icon | the letter fallback of `McpServerIcon.svelte` |
| Mobile form | `IntegrationOAuthClientPanel.tsx` (`Field`, `Button`, dense notes) |
| Mobile Add command, Edit command | `SettingsActionRow` (Rename, Remove) |
| Mobile process panel | `IntegrationConnectPanel.tsx` |

## Contradictions between the plan and the code

The plan and the B1 handoff now record each one.

1. §7.7 puts the choice **Command** "beside the URL field" of the dialog. The
   dialog has no URL field. **Add command** beside Installed opens it.
2. §7.7 names the OS user in the dialog. No client reads it
   (`ConnectionsServerInfo` has none). The dialog says "as the user that
   runs Solus there".
3. The B1 handoff gave `stopped` a message after an idle close, Stop, or a
   host stop. The code gives a message only for an end by itself. The client
   tells Not started from Stopped by the saved verdict (`era`).
4. §7.7's refusal text was "can add a command"; the host says "can add or
   change a command". The client shows the host's text.
5. A command that is not installed could not be told from one that crashed.
   B2 adds `startFailure`.

## Tests and checks

- New: `tests/unit/integrations/command-server.test.ts` (9: each state's
  label and actions, Cancel, the standard error, the admin rule, values
  first, the line round trip, the form check) and
  `tests/unit/integrations-store-commands.test.ts` (9: values never in the
  store after a save or a refusal, values stay off Solus Cloud, the form keeps
  no value, no add or edit or dialog start without `host.admin`, Start and
  test then Cancel removes, a failed start, a change on another client
  reaches this one). It runs the two rune classes compiled with
  `SvelteRunes`; Bun reads the temporary folder once, so both modules compile
  before the first import.
- Changed: `stdio.test.ts` (a command that is not installed has
  `startFailure: 'not-installed'`), `native-mobile-integrations.test.ts`
  (3 tests for the command on the phone).
- `bun test tests/unit/integrations/ tests/unit/integrations-store*.test.ts
  tests/unit/integration-labels.test.ts tests/unit/native-mobile-integrations.test.ts`:
  378 pass, 1 fail (the known `native-mobile-integrations` label, unchanged).
- Type checks, before and after, the same lines: server 129 and 129,
  workspace-ui 39 and 39, client-core 2 and 2, contracts 0 and 0, mobile 0
  and 0. `svelte-check` on workspace-ui: no diagnostic in a file B2 changed.
- `oxlint` on every changed file: clean. `lint:surfaces`: clean.
  `lint:layout`: only the three known failures (`ProjectChip`,
  `RunOnPicker`, `EditorVoiceControl`).

## Screenshots

From a temporary Vite harness in the ignored `.tmp/b2-harness/` of the
worktree (not committed): the web demo of `apps/client` with its in-page
host, plus seven commands in each state; `?member` serves a person without
`host.admin`. 1280 px wide, at 2×. The server ran from this worktree and was
stopped by its own PID. Files in
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-dde339e6/54203787-41b0-40c5-a4cd-5fbeb65bb475/scratchpad/shots/`,
each as `light-` and `dark-`:

- `01-rows-each-state.png`: the list with a command in each state.
- `02-running.png` … `07-not-installed.png`: the open row in each state
  (Running, Stopped with saved values, Not started, Stopped by itself with
  standard error, Failed, Not installed).
- `08-values-form.png`: the values form of a command with two names.
- `09-add-empty.png`, `10-add-error.png` (a pipe), `11-add-filled-with-values.png`,
  `12-add-names-error.png`, `13-add-starting.png`: the add dialog.
- `14-member-row.png`, `15-member-add.png`: a person without `host.admin`.

## Not done or not verified

- Mobile was not run: it needs a native build. Its code passes `check`,
  `oxlint`, and the unit tests of `integrations.ts` only; the hooks and
  screens have no test.
- Desktop (Electron) and the real web client were not run; only the
  harness, with a fake host. No real command was started from the UI.
- In the harness the tool list of a not-installed command shows tools,
  because the fake host answers them; a real host gives none.
- The command palette entry was not exercised in the harness.
- C1's found servers and its add are not built here, by design.
- Open from B1: Windows `.cmd` shims, the limit of 16, a shared host with
  members, and a person who loses `host.admin`.
