# MCP wave 5 handoff: eight branches and `main` on one branch

Branch: `solus/merge-mcp-branches-for-main`, from `solus/merge-mcp-wave-branches`
(`4908f45fc`, the wave 3 merge). It holds `main` at `b6b1b66e4` (merged in
`2c3be4fb9`; at the last step `main` had not moved, so the second merge was
empty). Nothing was pushed. No pull request was opened. The `main` branch and
the main checkout were not changed.

## Branches merged, in this order

| Phase | Branch | Head | Merge commit |
|---|---|---|---|
| B2 | `solus/stdio-mcp-settings-across-clients` | `f26f368b8` | `64251065a` |
| C1 | `solus/discover-configured-mcp-servers` | `9e8276de7` | `1891beecb` |
| C2 | `solus/skip-duplicate-provider-mcp-servers` | `7482a2e68` | `436a789a3` |
| E | `solus/edebf83b` | `6a756fd26` | `34629397d` |
| F1 | `solus/mcp-resource-lists-and-attach` | `6988d43fa` | `06de628a8` |
| G | `solus/mcp-task-background-work` | `c7784a4d5` | `a02b8e006` |
| H2 | `solus/mcp-app-picture-in-picture` | `8f9b73263` | `c8388b018` |
| OAuth | `solus/publish-mcp-oauth-metadata-document` | `abd53dda2` | `04763d48b` |
| `main` | `main` | `b6b1b66e4` | `2c3be4fb9` |

## Commits after the merges

- `4a4a5b855` the F1 types in the host API import; the C2 test stand-in; two
  a11y notes; the split of `gateway.ts`.
- `a20419ceb` the integrations store off the first screen again; the
  `ConversationTurn` test harness and the live card test (Part 2, item 1).
- `acd265735` why a process stopped (item 8); the host test that a command's
  values never reach the account (item 2).
- `2e0dff55c` the found list uses the CLI skip's address rule (item 6).
- `53a3a97d8` the values form after a found command is added (item 3).
- `eace87162` "Only in `<project>`" (item 4), migration `0010`.
- `b44f0c04a` the client-required mark follows the metadata document (item 7).
- `a5a14480f` the template attach with the argument form (item 5).
- `3811d7ea6` a chat has no project in Found on this host (found in Part 3).
- `420f0ee7e` the found server's add dialog above Settings (found in Part 3).
- `ab2a057c0` the argument form's Enter hint names its action (found in Part 3).
- `59ba1b7b0` the plan, `docs/integrations.md`, `mcp-integrations.md`.
- The commit that adds this file.

## Conflicts and how each was resolved

Among the eight branches:

- **Palette commands** (`apps/client/.../palette-commands.ts`,
  `desktop-palette.svelte.ts`, `settings-commands.ts`; B2 + C1). One function,
  `mcpCommands`, gives both entries: "Add an MCP server command" (B2) and "Find
  MCP servers on this host" (C1). C1's `foundServerCommands` is gone.
- **`mcp-page-request.svelte.ts`** (add/add, B2 + C1). One class with both
  fields: B2's `isAddCommandAsked` / `takeAddCommand()` and C1's `view`.
- **`SettingsTabMcp.svelte`** (B2 + C1). Both import sets (a duplicate
  `mcpPageRequest` import removed); B2's `addCommand` and C1's
  `confirmFound` / `foundDialogClosed` both kept.
- **Mobile `IntegrationsScreen.tsx`** (B2 + C1). B2's command section and
  installed rows with processes, then C1's found section.
- **`integration-handlers.ts`** (C1 moved `updateCommand` to
  `integration-create.ts`; C2 added `cliSkipLog.forget` to it). C1's move kept;
  C2's line moved into `integration-create.ts`.
- **`McpServerRow.svelte`** (B2 + C2). B2's command and process snippets and
  C2's `cliCopies` snippet, both.
- **Contracts** (`rpc.ts`, `rpc-planes.ts`, `permissions.ts`, `host-api.ts`;
  C1, E, F1, G). Every method of each branch kept, in branch order. A merge
  slip left F1's three types out of the `host-api.ts` import (three TS errors
  in every package); fixed in `4a4a5b855`.
- **`integration-tools.ts`** (C2, E, F1). E's `integrationsForRun` and F1's
  `runIntegrations` were the same function; one is kept, under E's name, and
  F1's list handler calls it. The toolbox keeps C2's `cliSkip` and F1's
  resource tools and its "facts of each server that listed in time".
- **`gateway.ts`** (E, F1, G). `listChanged` has E's `prompts` and F1's
  `resources` beside `tools`; G's `TaskAwareClient` and its extension in
  `capabilities`.
- **The input bar** (E, F1): `autocomplete.svelte.ts`, `PromptEditor.svelte`,
  `InputBar.svelte`, `composer-commands.svelte.ts`. E's `onMcpPrompt` and F1's
  `onResource` both; `@` warms the resources, `/` warms the prompts.
- **Mobile composer** (E, F1): `ComposerAttachmentButton.tsx` has "MCP
  Prompt…" and "MCP Resource…"; `conversation-controller.ts` has E's
  `askToConnect` and F1's `attachResource`; `ThreadComposer.tsx` both sheets.
- **`docs/integrations.md`, `docs/plans/mcp-first-class.md`.** Every section
  and correction kept. §1 items were numbered again: C2 24–27, G 28 (was 24),
  H2 29–32 (were 24–27); H2's cross-reference "§1, item 25" is now item 30.

With `main` (none of `main`'s changes was dropped or weakened):

- **Mobile `conversation-store.ts`**: H2's `setMcpAppPip` and `main`'s frame
  batching (`cancelItemFrame`, `notifyItems`), both.
- **Mobile `ThreadComposer.tsx`**: `main` rebuilt the composer row. `main`'s
  structure is kept whole; E's and F1's two props are on its one
  `ComposerAttachmentButton`.
- **Mobile `thread-work-log.tsx`**: `main`'s `toolRowView` with its `body`
  and `ToolCallDetail`; A3's audio and left-out notes added to `canExpand`.
- **`permissions.ts`**: `main`'s `sessionRepositoryBundle` and
  `sessionPrepare`; G's `mcpTaskList`, `mcpTaskCancel`, `mcpTaskAnswer`.
- **`host-tables.ts`**: `main`'s `sessionStorage`, `sessionStorageTurns`;
  B1's `integrationServerFacts`, G's `mcpTask`.
- **`boot-server.ts`**: `main`'s `withHostScope` import; C2's
  `getCodexAppServerClient`.
- **`claude-session-helpers.ts`**: A3's `toolResultMedia`; `main`'s
  `ThreadFile`.
- **`codex-backend.ts`**: `main`'s thread `config` with
  `RUNNING_SERVER_SESSION_ENV`, and C2's `cliSkipConfig` spread after it, for
  start, bare start, and fork.
- **`session-runtime.ts`**: `main`'s `sessionArchive` and `sessionSync`; G's
  `mcpTaskHolds`. G had put the doc comment of `useOrchestration` on
  `useMcpTaskHolds`; it is back on its method.
- **`run-launcher.ts`**: `main`'s portable-session path note, then H1's app
  model context, which must stay last ("so an app's new state leaves the rest
  of the prompt as it was").
- **`McpConnectDialog.svelte`**: `main`'s `z-[10001]` (Settings is in the
  app's dialog band now) with B2's removed border.
- **Places where I chose:** none between `main` and the program. Two defects
  of the program came from `main`'s changes and were fixed on the program's
  side: C1's add dialog kept `z-50` under `main`'s Settings band (`420f0ee7e`),
  and C1 read a chat's placeholder folder as a project after `main` added
  project-less chats (`3811d7ea6`).

## Migration order (host SQLite)

`main` has `0000`–`0007` (`0002_task_assignees` … `0007_session_cloud_push`).
This program's are after them:

| Tag | From | `when` |
|---|---|---|
| `0008_stdio_integrations` | B1 (was `0002`) | 1795148330105 |
| `0009_mcp_tasks` | G (was `0003`) | 1795188768845 |
| `0010_integration_project_name` | wave 5, item 4 | 1795193726569 |

The SQL of `0008` and `0009` is unchanged. Their snapshots were made again on
`main`'s `0007` snapshot (B1's tables and columns, then G's table) with a new
`id`/`prevId` chain; `0010` came from `drizzle-kit generate`. `drizzle-kit
generate` reports no schema change for SQLite and for Postgres, and
`drizzle-kit check` is clean. Postgres has no change. A development database
that applied the old `0002_stdio_integrations` or `0003_mcp_tasks` tags of the
program branches is not one `main` knows; every such database is disposable.

## Files split

| File | Base `4908f45fc` | After the merges | Now | What moved |
|---|---|---|---|---|
| `packages/server/src/integrations/gateway.ts` | 815 | 1,050 | 985 | The tool and prompt pages to `upstream-lists.ts` (beside F1's `resource-lists.ts`), with `serverCapabilitiesOf`; one `listOn()` holds the sign-in retry both lists had. G's `McpTaskCalls`, `HeldMcpTask`, `ServerStoppedError` to `mcp-task-requests.ts`. |

Other files over 1,000 lines that the branches changed were over it at `main`
or at the base and were not split: `contracts/types.ts`, `boot-server.ts`,
`codex-backend.ts`, `host-api.ts`, `run-launcher.ts` (1,009 at `main`),
mobile `conversation-controller.ts` (1,535 at `main`).

## Part 2

1. **Live app card.** H2 had fixed it: the card mounts in
   `ConversationTurn.svelte` while the turn is live. No test rendered the turn.
   `conversation-turn-identity.test.ts` now mounts the real `ConversationTurn`
   markup and checks that a live turn shows the live card of a Solus
   integration tool (and not of `Bash`), and that the end folds it; it fails
   when the card's block is taken out. The same harness stubs the imports G
   and H2 added, which had broken its first test. Mobile builds the live row in
   `thread-feed-presentation.ts`, and `native-mobile-conversation-cards` covers
   it.
2. **Values stay on the host.** Both client guards were there (desktop
   `cloudFor`, mobile `connectsThroughCloud`, each with a test). The host keeps
   the values in its own secret store only (`Vault.saveEnvironment`), the
   reconcile skips a `stdio` integration, and the agent profile leaves it out.
   New test (`stdio.test.ts`): a person signed in to Solus saves values, the
   reconcile runs, nothing is uploaded; it fails without the reconcile guard.
3. **Found server to values.** The host's add answer has `needsValues` when the
   person has no values for the command. Desktop and web then show Installed,
   open the new row, and start its values flow (B2's form, focus in the first
   field); mobile opens the same panel in the row. Test: `found-servers.test.ts`.
   Screenshot 07.
4. **Project label.** The record keeps `projectName` (migration `0010`) beside
   `projectKey`, a hash. The row says "Only in `<project>`" on desktop, web,
   and mobile, from `projectOnlyLabel`. Test: `found-servers.test.ts`.
   Screenshots 01, 02.
5. **Template attach.** A template whose variables are all `{name}` or
   `{+name}` is a row of the `@` menu after the resources; E's form opens in the
   composer with one required field per variable, the button and the Enter hint
   say Attach, and the chip reads the one resource. On mobile the resource sheet
   lists the templates and asks for the values in the sheet. Shared:
   `templateArgumentFields` (client-core), `resourceAttachRequest` (contracts).
   Tests: `mcp-resource-menu`, `native-mobile-resource-attachments`.
   Screenshots 09, 11.
6. **The skip and the found servers.** C2 asked C1 to use `sameServerAddress`
   for the `added` state; it does now (test). C2's local-scope note was
   confirmed again with the Agent SDK `query()` (SDK 0.3.322, Claude Code
   2.1.314), a temporary `HOME` and `CLAUDE_CONFIG_DIR`, only `PATH`, a prompt
   stream that never sends, and the stdio fixture with a start file. No model
   turn, no credential:

   | `settingSources` | Deny list | Local server | Started |
   |---|---|---|---|
   | `user`, `project` (Solus) | no | absent | no |
   | `user`, `project`, `local` | no | connected | yes |
   | `user`, `project`, `local` | yes | absent | no |

   So no Solus run loads the local scope, and the skip would cover it too. The
   project path must be the real path (`/private/var/…` on macOS) or the CLI
   does not match the key. Not done: naming the Claude copy's files from
   `FoundServer.foundIn` (C2 said "could"); the Claude line still names the
   address.
7. **Stale OAuth mark.** A mark made while the document is unconfirmed carries
   `awaitsClientDocument`. A list of the person's servers reads the document
   (its own cache limits the reads) and, once confirmed, sets the record back
   to `metadata-document` and sends `integration.changed`. A refusal while the
   document is confirmed is a mark that stays. Tests: `admin-client.test.ts`.
8. **Stopped has a reason.** B2 told Not started from Stopped by the saved
   verdict. The host now keeps `stopReason` (`idle`, `stop`, `limit`) in the
   process facts, and the shared row rule says it ("It stopped after 10
   minutes without use."). Tests: `stdio.test.ts`, `command-server.test.ts`.
   Screenshot 02.

## Tests and checks

- `bun test tests/unit/integrations/ tests/unit/conversation-turn-identity.test.ts
  tests/unit/startup-import-graph.test.ts`: 375 pass, 2 fail (the two budget
  cases, below, which fail on `main`).
- Every test file of `tests/unit/` (1,743), each in its own process, on this
  branch and on `main` (`b6b1b66e4`, checked out detached in this worktree,
  then back), six at a time:

  | | Files | Pass | Fail | Time-out |
  |---|---|---|---|---|
  | `main` | 1,721 | 1,584 | 136 | 1 |
  | This branch | 1,743 | 1,605 | 137 | 1 |

  The 22 more files are the program's tests. Every file that fails here fails
  on `main` too, except `device-feature`, which passes alone (three runs) and
  failed only under the load of the parallel run; `main` passes it in its run.
  `session-runtime-rate-limit-park` had one more failing case in the parallel
  run; alone it fails the same two cases as on `main`. No test file fails
  because of the program. The failures of `main` that a program file shows
  are the same assertions: `native-mobile-integrations` (one label),
  `data-model-identity` (`session_repositories.owner_user_id`, a column of
  `main`), `access-policy` (`sessionRepositoryBundleChunk`, a method of
  `main`), `startup-import-graph` (the budget, below).
- Type checks (`tsc --noEmit`), `main` → this branch: server 135 → 134 (the one
  less is `parentToolUseId` in `codex-backend.ts`, fixed in wave 3), workspace-ui
  40 → 40, client-core 2 → 2, contracts 0 → 0, mobile 0 → 0, `apps/client`
  78 → 78. Diagnostic messages compared by file: none new. `svelte-check` on
  workspace-ui: 312 errors and 18 warnings on both. `apps/site`: 2 errors, both
  in `vite.config.ts` (two copies of Vite), as CIMD found at the base; it was
  not run on `main` because `svelte-kit sync` writes files. `main`'s counts came
  from the main checkout, which had nine changed files of another session;
  none of them showed in the comparison.
- `lint:surfaces` clean. `lint:layout`: `RunningServers.svelte` (`main`),
  `RunOnPicker.svelte`, `EditorVoiceControl.svelte`; none changed here.
- `drizzle-kit generate` (SQLite, Postgres): no change. `drizzle-kit check`:
  clean.
- First screen (`startup-import-graph`): the budget fails on `main` too (web
  4,825,339 bytes, desktop 4,940,765, against 4,620,000 and 4,700,000). This
  branch: web 4,888,681 (+63 KB), desktop 5,004,107 (+63 KB). After the merge
  the integrations store was in both first screens, which `main` forbids; F1's
  resource store now loads it on the first `@`, B2's values label has its own
  module, and the template rule loads on use.

## Screenshots

`/Users/sidhu/solus-screenshots/mcp/10-merged/`, each as `light-` and `dark-`
(22 files), 2× scale. From the web demo of `apps/client`, served by Vite from
this worktree with a temporary config (root `apps/client`, the `.git/` deny
rule relaxed) and temporary demo data in `handlers/integrations.ts` (a command,
a project server, a CLI skip, found servers, resources, templates). The demo
file was copied back from a backup, the temporary config was removed, nothing
temporary was committed, and the server was stopped by its PID. The demo
seeds a light theme; the dark captures set the classes `applyTheme(true)` sets.

- `01-installed-rows`: Installed, with "Only in rate-limiter" on a command and
  on a URL server, and a command's state.
- `02-command-row-open`: the open command row: Command, Process "Stopped / It
  stopped after 10 minutes without use", Values; below it a found command that
  needs values ("Enter values").
- `03-cli-copy`: GitHub open on the field CLI copy.
- `04-instructions`: Context7 open on "Instructions for the agent".
- `05-found`: Found on this host: a project command, a URL in two files, one
  Added, one not supported, and a file that was not read.
- `06-found-add-dialog`: the add dialog of a found command, above Settings,
  with no outline border.
- `07-values-after-add`: after Add: Installed, the new row open on the values
  form with the focus in its field.
- `08-add-command-dialog`: B2's add command dialog, no outline border.
- `09-at-menu`: `@r`: the MCP resources band with two resources and two
  templates.
- `10-attached`: the chip of an attached resource.
- `11-template-form`: the argument form of `runbooks://incidents/{id}` in the
  composer, with Attach.

## Not done or not verified

- **Mobile was not run**: it needs a native build. Its changes (found → values,
  project label, template sheet) pass `tsc` and the unit tests only.
- Desktop (Electron) was not run; the web demo shows the same Svelte. The demo
  host is a fake: no real command started, no real server read.
- The MCP App approval dialog (H1/H2) was not captured here: the demo has no
  app frame. H2 captured it without a border
  (`/Users/sidhu/solus-screenshots/mcp/09-picture-in-picture/`); this merge
  changed nothing in it.
- No real provider turn ran. The local-scope proof used no turn.
- The Claude CLI-copy line does not name the files from the found servers.
- The `@` menu's template rows and the composer form have no component test
  (the controller needs the workspace; `unified-autocomplete` cannot load in
  this install, as F1 found).
- The open items of each handoff stay open: §3 rule 7 (input outside a turn),
  F2, prompt argument completion, Windows `.cmd` shims, a shared host with
  members, a person who loses `host.admin`, G's restart record of a session
  waiting in `background`, and H2's companion-pane composer height.
- `main`'s own failing tests (`data-model-identity`: `session_repositories.
  owner_user_id`; `access-policy`: `sessionRepositoryBundleChunk`; and the
  others in the table above) were not fixed here.
