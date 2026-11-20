# MCP H1 handoff: the live app card

Branch: `solus/20ea57e1`, from `solus/merge-mcp-branches-and-build-a1-facts`
(`5127e4f0e`). Nothing was pushed. No pull request was opened.

## Commits

- `036b904ae` `feat(mcp): show the live MCP App card while its tool call runs`:
  H1 (§14.1 of `mcp-first-class.md`) and the correction of the approval
  dialog.
- The commit that adds this file.

## What each client has

| | Desktop and web (shared Svelte) | Mobile |
|---|---|---|
| Where the card mounts | `McpAppLiveCard.svelte`, below each tool group in `TranscriptItem.svelte` | an `mcp-app` feed row after the work row of an active turn; `ThreadMcpLiveApp.tsx` |
| Saved card hand-over | `McpAppCard.svelte` stays empty while a live card holds its call and hands it the activity | the same, in `ThreadMcpApp.tsx` (`SavedMcpApp`) |
| Frame | `McpAppFrame.svelte` (`call`, `savedCall` props) | `McpAppWebView.tsx` (moved out of `ThreadMcpApp.tsx`), `call` and `savedCall` props |
| Hidden conversation | `conversationIsVisible()` | `useIsFocused()` |
| Approval dialog | arguments indented in the monospace block; a sentence in the normal font; shared `Button` | system alert (no monospace block; no defect) |

The shared parts are in client-core, so the clients cannot differ:
`healPartialJson`, the live mode of the bridge (`followCall`, `toolResult`),
`McpAppLiveCards` (host answers and the hand-over), and `mcpAppLiveCall`
(one rule from a transcript row to the call).

## What each provider supports

| | Claude | Codex |
|---|---|---|
| Live card | yes | yes |
| `tool-input-partial` | yes (the normalizer streams the input, 10 a second, up to 64 KiB) | no: the input arrives whole; the card gets `tool-input` when the call starts |
| `tool-input`, `tool-result` | yes | yes |
| `tool-cancelled` | `stopped`, `failed` | `stopped`, `failed` |
| Server of Claude's own, call in a subagent | no live card (as the plan says) | n/a |

`denied` and `timeout` are in the contract, but a client's transcript does
not tell them from another error, so the clients send `failed`.

## Contradictions between the plan and the code

All are corrected in `mcp-first-class.md` (§1 item 19 and §14.1).

1. Claude's normalizer did not send the input as `tool_call_update`. It kept
   each `input_json_delta` and sent the input whole. H1 adds a bounded
   stream for Solus integration tools only (`claude-partial-input.ts`).
2. Desktop and web marked a Claude integration tool's row done at the end of
   its input stream, long before the result; mobile already waited. The row
   now stays running until its result, or the live card would end early.
3. "In place of the plain tool row": the plain row is inside the activity
   row of the tool group. The card mounts below the activity row, where the
   saved card shows later; the row stays, as beside a saved card.
4. `{ html, csp, title }` is not enough for the frame: the answer
   (`McpAppLiveDocument`) also has `permissions` and `prefersBorder`.
5. `ui/update-model-context` must also wait for the result, because it names
   a saved app, as `tools/call` and `resources/read` do.
6. The client keeps each answer per session and tool name, not per tool name:
   the owner check depends on the session.
7. The call's own tool-use id is `context.parentToolUseId()` in both tool
   adapters.

## Screenshots and recording

Rendered with the real `McpAppFrame.svelte` and the shared bridge in a Vite
harness outside the repository, with a fake host API and a test app. The
tool row above the card is a stand-in, not `ToolGroupItem`. Files are in
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-20ea57e1/57bd708d-6440-470b-85f8-f901249c75e6/scratchpad/screenshots/`:

- `01-live-partial-light.png`, `02-live-partial-dark.png`: during the call; the
  healed partial input shows `ea` as the third region.
- `03-result-light.png`, `04-result-dark.png`: after the result, same frame.
- `05-cancelled-light.png`, `06-cancelled-dark.png`: after Stop; the card is
  gone and the tool row stays.
- `07-approval-arguments-light.png`, `08-approval-arguments-dark.png`: a write
  tool's arguments, indented, in the monospace block.
- `09-approval-permission-light.png`, `10-approval-permission-dark.png`: the
  permission request in the dialog's normal font.
- `11-live-card-call.mp4`: one call from partial input to result.

## Tests and checks

- Focused suite (`mcp-app-host`, `mcp-app-frame`, `claude-mcp-apps`,
  `integrations/`, `mcp-app-live`, `claude-partial-input`,
  `session-setup-replay`, `native-mobile-conversation-cards`,
  `native-mobile-integrations`, `claude-event-normalizer`, `access-policy`,
  `rpc-planes`): 409 pass, 1 fail (the known label assertion of
  `native-mobile-integrations`).
- `session-event-file-target.test.ts`: 2 pass alone. It fails in the same run
  as `mcp-app-frame.test.ts`, which leaves a fake `window`; its existing
  test fails the same way.
- `solus-api-composition.test.ts` has one failure about HTTP routes
  (`/apps/service/v1/*`, `/pair/serve`), not related to this work; not
  checked at the base.
- `check` diagnostics, base and after, the same text: server 130, client-core
  2, workspace-ui 39, contracts 0, mobile 0. `svelte-check` on workspace-ui:
  311 errors, none in a changed file (no base count was taken).
- `oxlint` on changed files: only findings that the base has.
  `lint:layout` fails on three files this work did not touch;
  `lint:surfaces` is clean. `ThreadFeed.tsx` stays at 1,000 lines.

## For H2 (`pip`)

- The live card and the saved card share `McpAppFrame.svelte` and
  `McpAppWebView.tsx`. A frame that moves to `pip` must keep the hand-over:
  while a live card holds a call (`McpAppLiveCards.hold`), the saved card of
  the call renders nothing.
- `ConversationViewState` keys a live card's closed state, height, and
  permissions by tool-use id, and a saved card's by activity id. A live card
  copies its height and permissions to the activity id when it takes the
  saved app. `pipActivityId` will need the same rule.
- On mobile a finished turn folds its tools, so at turn end the saved card
  starts a new frame. A docked `pip` frame must not depend on the live row.
- `McpAppDisplayMode` and the bridge's `displayModeSchema` accept only
  `inline` and `fullscreen` today.

## Not done or not verified

- Mobile was not run: it needs a native build. Its code passes `check` and the
  presentation test only.
- Desktop (Electron) and the real web client were not run; only the harness.
  No real provider turn was run, so the Claude partial stream and the Codex
  path are verified by unit tests only.
- Codex: the capture names the call by the `callId` of `item/tool/call`, and
  the transcript row by the item id. H1 takes them as one id; a real Codex
  run has not confirmed it. If they differ, the live card ends as `failed`
  after 15 seconds and the saved card starts a new frame.
- The 15-second wait after a call is measured from the result on the client.
- A frame with `prefersBorder` is 2 px shorter than the height the app
  reports, because the dialog border takes them. This existed before H1; it
  is not fixed.
- The commit holds H1 and the approval dialog fix together; they share the
  bridge's `confirm` change.
