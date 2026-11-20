# MCP wave 3 handoff: the merge of A2, A3, B1, H1, and the A1 fix

Branch: `solus/merge-mcp-wave-branches`, from
`solus/merge-mcp-branches-and-build-a1-facts` (`5127e4f0e`). Nothing was
pushed. No pull request was opened. The next seven sessions start from this
branch: stdio in Settings (B2), found servers from configuration files (C1),
the provider CLI skip (C2), MCP prompts (E), MCP resources (F1), MCP tasks
(G), and the picture-in-picture display mode (H2).

## Branches merged

The task named two branches by worktree id. In this repository they are:

| Task name | Branch | Head |
|---|---|---|
| `solus/efc6fe60` (A2) | `solus/mcp-tool-progress-trace-context` | `a2a4ee578` |
| `solus/mcp-tool-result-content` (A3) | same | `811d54f15` |
| `solus/stdio-mcp-host-servers-and-saved-facts` (B1) | same | `d223ffaeb` |
| `solus/20ea57e1` (H1) | `solus/live-mcp-app-cards` | `b07f74a9e` |
| `solus/mcp-instructions-settings-visual-review` (A1 fix) | same | `17e91695a` |

## Commits

- `16f0e24b3` merge B1 (no conflict).
- `bcceb3e12` merge A2.
- `2c7b06f53` merge A3.
- `1f7ee0cd7` merge H1.
- `1123a865f` merge the A1 fix (no conflict).
- `dc42496d8` refactor: split `gateway.ts` and the mobile tool item.
- `8885c2f10` fix: `host.admin` at every start of a stdio command.
- `ffc00b026` fix: an event when new environment names remove values.
- `33f315f34` fix: the Codex call id, confirmed, and read once for the approval too.
- `48ecd3643` fix: a bordered app frame gets the full height.
- `1a84abe9a` fix: the permission title; focus Cancel, not the dialog.
- `b05c33c22` fix: the permission row wraps instead of being cut off.
- The commit that adds this file.

## Conflicts and how each was resolved

- **`gateway.ts`, B1 + A2.** Imports: both sets kept. Constructor: A2's
  `CallClock` stays the second argument (`SYSTEM_CALL_CLOCK` by default), and
  B1's options `{ clock?: GatewayClock, savedFacts? }` stay the third, with
  A2's `turnContextOf` field. B1's boot code and test passed `globalThis` as
  the call clock; `globalThis` has no `now()`, which A2's `CallLimits` calls,
  so both now pass `undefined` (the default clock). B1's "stopped while it
  ran" return kept in A2's `callAs`.
- **`gateway.ts`, A3.** `agentResultOf` replaces `mapCallResult` inside A2's
  `callAs`; the timeout returns of A2 (`ended = …`) kept; A3's
  `outputSchemaRefusal` added after them, also as `ended`, so the span status
  is right.
- **`integration-tools.ts`, B1 + A3.** B1's project-key imports kept; A3's
  removal of `agentToolImage`/`AgentToolResult` (they moved with
  `mapCallResult` to `result-content.ts`) kept.
- **`docs/integrations.md`, A2 + A3.** Both sections kept; A3's paragraph got
  the heading "Result content".
- **`docs/plans/mcp-first-class.md`.** The status line names P0, A1, A2, A3,
  B1, and H1. §1 kept every correction and renumbered them: 19 and 20 are
  A2's, 21 and 22 are A3's (they were 19 and 20 on the A3 branch; the
  cross-reference in §6 now says item 22), 23 is H1's (it was 19 on the H1
  branch). Item 20 now says that H1 keeps a Solus integration card running
  until its result, so the progress reopen rule applies only to a card that
  settled another way.
- **Mobile `transcript-model.ts`, A2 + A3.** The tool item keeps `progress`,
  `audio`, and `leftOut`. A2's move of the pending-request types to
  `pending-requests.ts` kept.
- **`contracts/src/types.ts`, A3 + H1.** `tool_call_update` keeps
  `toolAudio`, `toolLeftOut`, and `inputPartial`.
- **The desktop and web reducer (auto-merged).** A2 reopens a settled card on
  `tool_progress`; H1 no longer settles a Solus integration card at the end of
  its input. Both rules are kept. A2's test assumed the old settle; it now
  asserts the merged rule and checks the reopen path on another card.
- **`ToolGroupItem.svelte` (auto-merged).** A2's progress is in the header;
  A3's images, players, and notes are in the open step. The screenshots show
  them together.

## Files split

| File | Before | After | New modules and their owners |
|---|---|---|---|
| `packages/server/src/integrations/gateway.ts` | 653 at `f6ba8c919`, 1,021 after the merges | 815 | `upstream-session.ts`: the shape of an upstream session (`UpstreamSession`, `ActiveCall`, `ServerFacts`, `UpstreamTool`, `ToolArguments`, `AppToolResult`, `IntegrationAppCapture`, `ConnectionRequiredError`), `sessionKey`, `upstreamTransport` (was the gateway's `transportFor`), and the error helpers. `integration-call.ts`: the parts of one call that need no session: `callRequest` (with `traceparent`), `startCallSpan`, `callSpanStatus`, `splitAccount`, `accountLabel`, `elicitFromCall`, `TurnContextOf`. |
| `apps/mobile/src/features/conversation/lib/transcript-model.ts` | 996 at `f6ba8c919`, 1,002 after the merges | 976 | `tool-item.ts`: `ToolItem`, the tool row of the native feed. |

The gateway keeps the sessions, the server facts, the stdio lifecycle, and
`callAs`. It re-exports `UpstreamTool`, `ToolArguments`, and
`IntegrationAppCapture`, and `transcript-model.ts` re-exports `ToolItem`, so
no importer changed. All names the A2, A3, B1, and H1 handoffs give to later
phases are unchanged except `transportFor`, which is now `upstreamTransport`
(§7.3 of the plan says so). Files that were over 1,000 lines before this
program (`run-launcher.ts`, `codex-backend.ts`, `boot-server.ts`,
`types.ts`, and others) were not split. `ThreadFeed.tsx` stays at 1,000.

## The open items of the wave

1. **Stdio start without the admin rule (B1).** The exact paths:
   `mcpAppCallTool` → `IntegrationApps.callTool` → `gateway.callAppTool`;
   `mcpAppReadResource` and `mcpAppLiveRead` → `gateway.readAppResource`; an app
   of Solus → `AppIntegrationCalls.call` → `gateway.callAppTool`. All reached
   `openStdio` with the owner check alone. The rule is now in one place,
   `integrations/command-admission.ts`: `commandStartRefusal(integration,
   personKey, starter)` refuses the host's own work, another person, a request
   that names no person, and a person without `host.admin`
   (`mayRunCommands`). The gateway checks it in `openStdio`, which every start
   passes. Each start path names its starter (`CommandStarter = Principal |
   null`): `call(…, starter)` (the run's principal, through
   `upstreamToolToAgentTool`), `callAppTool(…, starter)`,
   `readAppResource(id, uri, starter, options)`, and `startProcess(id,
   starter, recheck)`. A read names none and starts nothing. An app's own
   schedule, webhook, or workflow has no principal, so it starts no command.
   The handlers use `mayRunCommands` for create and update.
   `integrationProcessStart` no longer checks in the handler; the gateway does.
   Tests: `stdio.test.ts` "who may start a command" (each path, and the RPC).
2. **No event for new environment names (B1).** `IntegrationConnections.
   removeAllFor` now sends `integration.connectionChanged` with
   `connection: null` for each removed row, as `disconnect` does. Desktop,
   web, and mobile already drop the connection on that event. Test:
   `stdio.test.ts` "new environment names".
3. **Codex call id (H1).** Confirmed in the Codex 0.167 source (tag
   `rust-v0.167.0`): core `request_dynamic_tool` (`core/src/tools/handlers/
   dynamic.rs`) sets the `DynamicToolCall` item's `id` to the model's
   `call_id`; the app server copies `item.id` into the request's `call_id`
   (`app-server/src/bespoke_event_handling.rs`, the `ItemStarted` arm); and
   history rebuilds the item with `id: payload.call_id`
   (`app-server-protocol/src/protocol/thread_history.rs`). The generated
   types (`DynamicToolCallParams.callId`, `ThreadItem` `dynamicToolCall.id`)
   do not state the relation; the source does. No mapping changed. The rule
   is now `codexDynamicCallId` in `codex-tool-adapter.ts`. The same code had a
   defect from before this program: the approval branch read
   `parentToolUseId`, declared only inside `respondWithResult`, so a Codex
   dynamic tool that asks for approval threw `ReferenceError` (TS2304 in the
   server check). It is fixed. Test: `codex-dynamic-call-id.test.ts` drives
   the backend with `item/tool/call` and the normalizer with `item/started`;
   it fails on the old code.
4. **Bordered app frame 2 px short.** Desktop and web (`McpAppFrame.svelte`,
   saved and live cards) and mobile (`ThreadMcpApp.tsx`, saved and live cards)
   all had it. `mcpAppFrameHeight` in `client-core/mcp-app-document.ts` adds
   both 1 px edges. Measured in the harness: the app reported 242 px, the box
   is 244 px, the frame is 242 px. Test: `mcp-app-host.test.ts`.
5. **The permission dialog.** Each permission is a verb and an object
   (`mcpAppPermissionAction`): "Allow X to write to the clipboard?", "to use
   the camera", "to use your location", "to use the microphone and write to
   the clipboard", "to use the camera, the microphone and your location, and
   write to the clipboard". The row under the app says "This app asks to …"
   with the same words, and now wraps (four permissions were cut off). The
   outline was a focus ring on the `<dialog>` element itself, not the design of
   a shared primitive: `confirm()` called `showModal()` before Svelte rendered
   the buttons, so the dialog had nothing to focus and took the focus; the base
   `outline-ring/50` color drew the ring. The dialog now opens after a `tick`,
   the first focus goes to Cancel (checked: `document.activeElement` is
   Cancel), and the dialog has `outline-none`. Mobile grants no app permission
   (its web view cannot hold a feature to one approved app), so it shows no
   request and no dialog: no text to change there. Test: `mcp-app-host.test.ts`.

## Tests and checks

- `bun test tests/unit/integrations/`: 267 pass, 0 fail, 19 files (264 after
  Part 1; 3 tests added in Part 2).
- Each test file the five branches added or changed, run alone: all pass
  except `transcript-images` (needs `node:sqlite`, which Bun 1.3.14 lacks; the
  same at the base, as A3 reported). New: `codex-dynamic-call-id` 2 pass.
  Changed here: `session-event-tool-progress` 5 pass, `mcp-app-host` 26 pass,
  `mcp-apps` 21 pass, `stdio` 19 pass.
- Also pass: `access-policy`, `rpc-planes`, `claude-event-normalizer`,
  `mcp-app-frame`, `claude-mcp-apps`, `runtime-instructions`,
  `app-connections`, `codex-question-ids`, `codex-permission-modes`.
- Failures that are also on `5127e4f0e`, the same assertion:
  `agent-tool-schema-size` (110,064 against 107,583), `native-mobile-integrations`
  (one label), `native-mobile-agent-profile` (one), `native-mobile-host-integration`,
  `server-module-boundaries` (the three `host/` imports), plus three that the
  task did not list and that fail the same way at the base:
  `connection-status-tool` (one OAuth client assertion), `agent-profile-store`
  (`localStorage` is not defined), and `solus-api-composition` (two HTTP
  routes). `codex-event-normalizer` cannot load (`node:sqlite`).
  `integrations-store` passes now: the A1 fix repaired it.
- Type checks (`bun run check`): server **129** (130 at the base; the one less
  is the TS2304 of `codex-backend.ts` that item 3 fixed; every other line is
  the same text), workspace-ui 39, client-core 2, contracts 0, mobile 0, the
  same as the base. A checkout of the base outside the repository reports 143
  for the server; the 13 more are `ws` declarations that resolve differently
  from that folder, as A1 found.
- `lint:surfaces` clean. `lint:layout` fails on `ProjectChip.svelte`,
  `RunOnPicker.svelte`, and `EditorVoiceControl.svelte`, which this program did
  not change (H1 reported the same three).

## Screenshots

From a temporary Vite harness outside the repository that mounts the real
`ToolGroupItem.svelte` and `McpAppFrame.svelte` from this branch, with a fake
media resolver (data URLs) and the H1 test app. 760 px wide, at 2×. Files in
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-c4547dbb/a0b4b67a-715d-4700-8a4c-13dc55758122/scratchpad/screenshots/`:

- `01-images-light.png`, `02-images-dark.png`: three images under the tool call.
- `03-audio-light.png`, `04-audio-dark.png`: two players.
- `05-left-out-light.png`, `06-left-out-dark.png`: one image and three notes.
- `07-progress-light.png`, `08-progress-dark.png`: the running row with progress.
- `09-progress-then-result-light.png`, `10-progress-then-result-dark.png`:
  the same row after its result, with two images.
- `11-approval-one-light.png`, `12-approval-one-dark.png`: one permission.
- `13-approval-several-web-light.png`, `14-approval-several-web-dark.png`:
  four permissions (the web client offers all four).
- `15-permission-row-several-dark.png`: the wrapped row under the app.
- `16-approval-several-desktop-light.png`: microphone and clipboard (the
  desktop offers these two).

Vite's watcher ignores paths under `.git/`, so a source change needs a
restart of the harness server. Every server was stopped by its own PID.

## Not done or not verified

- Mobile was not run: it needs a native build. Its changes (`tool-item.ts`,
  `ThreadMcpApp.tsx`) pass `check` and the unit tests only.
- Desktop (Electron) and the real web client were not run; only the harness.
  The progress → result screenshots are two states of the same fixture, not
  one live transition.
- No real provider turn ran. The Codex id rule is from the source, not from a
  live Codex turn.
- The permission focus ring on Cancel shows after a keyboard-like click from
  automation; with a mouse click Chrome shows no ring. Both put the focus on
  Cancel.
- Tests that call `gateway.call` on an HTTP integration still pass four
  arguments; `starter` matters only for a `stdio` integration, and no
  `tsconfig` checks `tests/`.
- B1's other notes stay open: no UI for stdio (B2), the limit of 16 has no
  test, Windows `.cmd` shims, a shared host with members, and a person who
  loses `host.admin` keeps their records and values.
