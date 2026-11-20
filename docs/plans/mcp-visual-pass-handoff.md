# MCP visual pass handoff

Branch `solus/mcp-ui-visual-polish`, from `main` at `5bb58455a`. Nothing was
pushed. No pull request was opened.

## Part 1: the merge of F2 and D

- `e605c02f1` merges `solus/mcp-resource-watches` (`aa68b80ab`, F2).
- `1bbb046d2` merges `solus/discover-running-local-mcp-servers` (`090995f57`,
  D).
- One conflict, in `docs/plans/mcp-first-class.md`: the status line and §1.
  Both sets of corrections are kept. F2's items stay 38 and 39; D's items are
  now 40 to 46, and `mcp-d-handoff.md` names the new numbers.
- `docs/integrations.md`, `boot-server.ts`, and `gateway.ts` merged
  automatically. Each result was read: the sections and the wiring of the two
  phases do not touch each other.
- `bun test tests/unit/integrations/` and the test files that the two branches
  added or changed: 414 pass, 2 fail. The 2 are `data-model-identity`, which
  fails on `main` with the same assertions.
- Type checks (`tsc --noEmit`): contracts 0, client-core 2, mobile 0, server
  134, workspace-ui 40, the same counts as `main`. The one diagnostic in a
  changed file (`boot-server.ts`, `AddressInfo`) is a line of `main` that the
  merge moved.

## Merge of `main` at `09f769306`

`2f340d6a3` merges `main` at `09f769306` ("chore: commit pending work on main
before the last MCP merge", about 140 files of other sessions' work in
progress). No `package.json` or lockfile changed, so no install ran.

- **Conflicts.** One: `packages/server/drizzle/sqlite/meta/_journal.json`.
  `main` folded all its migrations of both engines into one `0000_baseline`.
  The journal takes `main`'s version. F2's `0011_integration_resource_watches`
  (SQL and snapshot) was removed and generated again with `drizzle-kit
  generate --config drizzle.sqlite.config.ts --name
  integration_resource_watches`: it is now `0001_integration_resource_watches`,
  after the baseline, with the same SQL as F2's, and its snapshot's `prevId` is
  the baseline's id. `mcp-first-class.md` and `mcp-f2-handoff.md` name the new
  tag.
- **Merged automatically, read:** `host-api.ts`, `permissions.ts`,
  `rpc-planes.ts`, `rpc.ts` (`main`'s vault key methods and task reads, and
  this program's two resource watch methods, each once) and `boot-server.ts`
  (`main`'s vault handlers beside this program's wiring).
- **Migrations.** `drizzle-kit generate` makes no change and `drizzle-kit
  check` passes, for SQLite and for Postgres. Postgres has no migration of
  this program.
- **Running servers.** `main` changed the client stores of running servers
  (`client-core/running-servers/`, the workspace and mobile stores), not the
  host's registry. Phase D's host side (`RunningServerRegistry.observeScans`,
  `ServerDiscovery.listeningPorts`) is intact, and its clients (Settings → MCP
  and the mobile hooks, which hold the lease and read the list again on a
  change) type-check against the new stores. The registry, client, store,
  forward, HTTP, and stop tests pass, and so does `integrations/local-servers`.
  Not seen in a running app.
- **Type checks**, compared by message with `main` at `09f769306` (checked out
  in this worktree for the reading, then back): contracts 0, client-core 2,
  mobile 0, server 134, workspace-ui 40; no new message.
- **Tests:** `tests/unit/integrations/`, `rpc-planes`, `data-model-baseline`,
  `data-model-identity`, the six `running-servers-*` files,
  `server-discovery-startup`, and the tests that this program added or
  changed: 621 pass, 4 fail. None is from this program or from the merge:
  `data-model-identity` (2, also on `main`), `native-mobile-integrations` (one
  label, also on `main`), and an unhandled error (`rune_outside_svelte`)
  reported against `server-discovery-startup` when it runs in one process
  after the other files; that file alone passes (2 pass). Neither side of the
  merge changed it.
- **Not done:** the full suite, `svelte-check`, the lints, and the screenshots
  were not run again after this merge.

## Part 2: the visual pass

The maintainer asked: "improve the look of the added ui elements to match the
theme and vibe of our app. i don't like the border around the modals." During
the pass the maintainer also asked: "use a stop icon instead of the word
stop". The pass changes the look, not the behavior. No contract, RPC method,
store, or server code changed. `client-core` gained two small shared modules
of presentation (`mcp-tool-label.ts`, `tool-audio.ts`) and two fields of the
background row's view model (`BackgroundItemAction.stops`,
`BackgroundItem.stopLabel`).

### Commits

| Commit | Group | What |
|---|---|---|
| `4352dc055` | 1, conversation: MCP App | card controls, approval dialog, rows under the card |
| `41f6be2de` | 2, conversation: tool row | MCP tool names (defect a), the Solus audio player, left-out notes; mobile tool label and player |
| `fd5b3945e` | 3, background work | the stop icon on MCP task and resource watch rows; mobile too |
| `428a68f95` | 4, input bar | the close icon of the prompt form |
| `30457bbe9` | 5 and 6, Settings → MCP | dialog surface, Found row buttons, command value, instructions; mobile disclosures |
| this commit and the one before | docs | `docs/integrations.md`, this file |

### What each new element now follows

**1. MCP App (`McpAppFrame.svelte`, `McpAppCard.svelte`, `McpAppLiveCard.svelte`)**

- Approval dialog (tool call, message, link, permissions) follows the other
  dialogs of the program and of the app (`McpFoundDialog`, `RenameSessionDialog`):
  `text-workspace-chrome`, a medium title, secondary detail text, `p-6`,
  `rounded-2xl`, the popover surface and shadow, small buttons. It had
  `text-base font-semibold`, `text-sm` detail, `p-5`, and default buttons. The
  arguments block had an outline; it is now `bg-muted` with no outline, as in
  `McpFoundDialog`.
- The card's controls (keep in view, full screen, close) were three outlined
  round buttons with 13 px icons. They are one floating toolbar: the popover
  surface with `--solus-menu-shadow` (the menus' shadow), no outline, and the
  ghost `icon-sm` buttons with 16 px icons that the picture-in-picture header
  uses.
- "Context shared with the agent": the block had an outline; it is now on the
  code tint (`--solus-code-tint`, the code block's fill) at the transcript meta
  size. The disclosure button has a visible focus ring.
- The rows under the card ("This app asks to …", "The … app is in
  picture-in-picture", "The … app was closed", "Try again", "Loading app…")
  use small ghost buttons in `text-workspace-chrome`, in place of default
  buttons and `text-sm`.
- The app's own frame keeps its border when the app asks for one
  (`prefersBorder`, MCP Apps), now with the tool border token and `rounded-xl`.

**2. Tool row (`ToolGroupItem.svelte`, `ToolAudioPlayer.svelte`, `lib/activity-summary.ts`)**

- MCP tool names follow the MCP task and app rows ("server · tool"); see
  defect (a).
- The audio player replaces the browser's `<audio controls>`. It follows the
  tool row's own parts: a ghost `icon-sm` play and pause button with filled
  16 px icons, the time in the rail's mono type, and a seek bar drawn as the
  tool progress bar (`h-1`, `bg-foreground/15`, fill `bg-foreground/80`), on a
  `bg-muted` strip. The seek bar is a `slider` with arrow (5 s), Page Up and
  Down (a tenth), Home, End, and Space; the pointer seeks and drags. No
  transition: the bar moves with each `timeupdate`, only while it plays.
  Logic is in `client-core/tool-audio.ts`, shared with mobile.
- The left-out notes and the audio label use `text-transcript-meta`, as the
  error line above them does, in place of `text-chrome-dense`.

**3. Background work (`BackgroundItemRow.svelte`)**

- The words Stop and Cancel are now `BackgroundWorkRow`'s own stop button: a
  ghost `xs` button, a filled square in a thin failure ring, last on the rail,
  with a 44 px target on touch (`pointer-coarse:tap-area`). Its name and
  tooltip say what it stops: "Stop watching <resource>", "Stop <tool>"; while
  it runs, "Stopping…" or "Cancelling…". Answer stays a word: it opens the
  question card, which no icon says. The rows already followed `ActivityRow`
  and `HostNoticeRow`; nothing else changed.
- Mobile (`ThreadMcpTasks.tsx`): the composer's stop control (`ControlPill`,
  `stop.fill`, `danger`) at its 44 pt size, with the same label.

**4. Input bar** — the argument form, the slash and `@` menus, and the
attached chip already follow the composer, the menus, and `AttachmentChips`.
Only the form's close icon changed, from 14 px to 16 px.

**5. Settings → MCP**

- `McpFoundDialog` and `McpConnectDialog` used `--solus-container-bg`, which in
  dark mode is the page colour, so the dialog edge was weak. They use
  `--solus-popover-bg`, the surface of the app's other dialogs, with the same
  shadow and no outline.
- The Found row's buttons dropped `border-border/70 shadow-xs`; they are now
  the Installed row's outline buttons.
- The command of an open command row is `text-chrome-dense` mono, as in the
  row's subtitle, and wraps at a space (`break-words`) in place of inside a
  word (`break-all`).
- "Instructions for the agent" shows the server's text in the secondary
  colour, as quoted data, in place of the primary colour.

**6. Mobile** (`apps/mobile/`)

- Tool rows name an MCP tool "server · tool" (`thread-work-log-presentation.ts`).
- The tool audio player: a 44 pt play and pause control (`play.fill`,
  `pause.fill`, added to `AppSymbol` as Tabler's filled player icons), the
  time, and an adjustable seek bar (tap to seek; increment and decrement for
  VoiceOver), on the `bg-subtle` strip.
- MCP task and resource watch rows: the stop control above.
- "Instructions for the agent" and "Standard error" are the app's disclosure
  rows (`ThreadArtifact`, `WorktreeSetupCard`): a 44 pt row with a chevron, in
  place of a "+" / "−" label with a small target.
- The MCP App view, progress, images, left-out notes, prompt and resource
  sheets, and the other integrations screens were read and not changed; the
  sheets are native page sheets with no outline.

### Dialogs of the rest of the app that have an outline border

None of these was changed (not part of this program). By their class lists, the
dialog surface has a border: `settings/SettingsDialog.svelte` (the Settings
dialog itself; `border border-border`, seen in dark mode in the screenshots),
`session/RenameSessionDialog.svelte`, `insights/SaveQueryDialog.svelte`,
`sharing/ShareDialog.svelte`, `servers/CopiedFilesDialog.svelte`,
`servers/AddServerModal.svelte`, `work/ImportDocDialog.svelte`,
`work/WorkHistoryDialog.svelte`, `pickers/LazyDialog.svelte`,
`document-modal/DocumentModalSkeleton.svelte`, `plan/PlanModalSkeleton.svelte`.
Only the Settings dialog was seen; the others are from a search of the source.
The app has no shared dialog primitive in `components/ui/`.

### Defects examined

- **(a) Raw tool name, two times.** Not caused by this program: the failure
  label (`prettyToolName(name) failed`) and `describeMcpTool` are from the first
  commit of the repository; this program only made MCP tool calls common.
  Fixed: `client-core/mcp-tool-label.ts` gives "linear · export_issues" for
  `mcp__solus__linear__export_issues` and `mcp__linear__export_issues`; the
  row's target is only the arguments, so nothing repeats. The label is the
  server's slug, not its display name ("linear", not "Linear"): the transcript
  row carries only the tool name, and a lookup in the integrations store would
  load data from a transcript row, which is a behavior change.
- **(b) Mobile "Instructions for the agent".** Fixed (see 6), and the same
  pattern on "Standard error".
- **(c) Picture-in-picture in the companion pane.** Examined by reading the
  code; not changed. The floating frame sits at
  `anchor(--solus-conversation_bottom) + --solus-composer-height + 3rem`. Only
  the primary column publishes `--solus-composer-height`. In the companion
  pane the composer is in normal flow under the conversation, so the variable
  falls back to 0 and the frame sits 3 rem above the companion composer, which
  is the right place. A browser without anchor positioning places it against
  the window instead (as H2 noted). Not seen in a real companion pane.
- **(d) Narrow widths.** Captured at a 356 px pane (conversation, tool row,
  background rows, prompt form) and a 760 px Settings window. Rows truncate
  and keep their controls; the permission row wraps its sentence. The command
  value no longer breaks inside a word.

### Visual problems that need a behavior change (not made)

- An MCP App that does not set `color-scheme` from the host theme gets an
  opaque light frame in dark mode (Chromium paints it). Fixing it from the host
  side changes how the app's document renders.
- MCP tool rows name the server by its slug; its display name needs a store
  lookup from the transcript row.
- The resource watch row has no time on its rail (the watch can last a day,
  by design in F2), so its stop button and the MCP task's stop button line up
  at the right edge but the MCP task row also shows its time before it.
- The `@` menu's footer says "0 files" when only MCP resources match.

### Screenshots

All in `/Users/sidhu/solus-screenshots/mcp/11-visual-pass/`, 2× scale, light
and dark. The side-by-side images are `compare-*.png`; the "before" images are
the earlier folders of `/Users/sidhu/solus-screenshots/mcp/`.

- `compare-1-app-{light,dark}.png`; `1-app-card`, `1-app-approval-arguments`,
  `1-app-approval-message`, `1-app-approval-permission`, `1-app-pip`,
  `1-app-narrow-356`.
- `compare-2-tool-row-{light,dark}.png`; `2-tool-row`,
  `2-tool-row-audio-playing`, `2-tool-row-narrow-356`.
- `compare-3-background-{light,dark}.png` (the stop icon, the maintainer's
  feedback); `3-background-rows`, `3-background-stop-focus`,
  `3-background-narrow-356`.
- `compare-4-input-{light,dark}.png`; `4-input-prompt-form`,
  `4-input-prompt-form-narrow-356`.
- `compare-5-settings-rows`, `compare-5-settings-found`,
  `compare-5-settings-dialogs` (each light and dark); `5-settings-*` for the
  installed rows, an open command, a failed command with standard error, a
  server that is not running, the CLI copy, the instructions, Found on this
  host, the add dialogs of a found command and of a running local server, the
  add command dialog, and the 760 px window.

How they were made: groups 1 to 4 from a temporary Vite page that mounted the
real components (`McpAppFrame`, `ToolGroupItem`, `BackgroundItemRow` fed by
the real `mcpTaskItem` and `resourceWatchItem`, `PromptArgumentForm`) with a
small test app in the frame; group 5 from the web demo of `apps/client` with
temporary demo data added by a wrapper entry (no repository file changed).
Both ran in the ignored `.tmp/vp/` of this worktree, served by Vite on
127.0.0.1:5291 and captured with system Chrome through Playwright. The server
was stopped by its PID and `.tmp/vp/` was deleted. Note: Vite does not watch
a worktree whose path has `/.git/`, so a running server keeps stale code
after an edit; restart it.

### Checks

- Focused tests: `activity-summary`, `tool-audio` (new), `mcp-task-row`,
  `resource-watch-row`, `native-mobile-thread-feed`, `native-mobile-integrations`,
  `mcp-app-frame`, `mcp-app-host`, `mcp-app-live`, `mcp-app-pip`,
  `tool-row-copy`, `integrations-store`, `integrations-store-commands`,
  `host-resource-watch`, `claude-mcp-apps`, `question-history`: 249 pass,
  1 fail. The fail is `native-mobile-integrations` ("a sign-in through Solus
  Cloud > the labels"), which fails on `main`; its file was not changed.
- Type checks, compared by message with the merge commit: contracts 0,
  client-core 2, mobile 0, server 134, workspace-ui 40; no new message.
- `svelte-check` (workspace-ui): 312 errors and 18 warnings, as on `main`;
  none in a changed file.
- `lint:surfaces`: clean. `lint:layout`: 4 failures, all in files this pass
  did not change (`ProjectChip`, `RunningServers`, `RunOnPicker`,
  `EditorVoiceControl`), from `main`.
- `startup-import-graph`: no file that this pass changed or added is in the
  first-screen graph, so it adds 0 bytes. The test reads web 4,872,619 and
  desktop 4,988,045 at the head; its budget already fails on `main`.

### Not seen

- **Mobile was not run.** It needs a development build with this branch's
  JavaScript, and a host with MCP data. Its changes pass `tsc` and the unit
  tests only. No mobile screenshot.
- Desktop (Electron) and the real web client were not run; only the harness
  and the web demo.
- Not captured: the MCP App in full screen, the live app card during a call,
  the closed-app row, the slash and `@` menus, the attached chip, the values
  form, the view of a person without `host.admin`, and the browser tooltip of
  the stop button (a native `title`, as on `BackgroundWorkRow`).
