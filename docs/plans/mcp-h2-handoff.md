# MCP H2 handoff: picture-in-picture for an MCP App

Branch: `solus/mcp-app-picture-in-picture`, from `solus/merge-mcp-wave-branches`
(`4908f45fc`). Nothing was pushed. No pull request was opened.

## Commits

- `30d05dddf` `feat(mcp-apps): keep an MCP App in view with picture-in-picture`:
  H2 (§14.2 of `mcp-first-class.md`), the live card mount fix, the approval
  dialog without a border, the docs.
- The commit that adds this file.

## What each client has and advertises

| | Desktop and web (shared Svelte) | Mobile |
|---|---|---|
| `availableDisplayModes` | `inline`, `fullscreen`, and `pip` while the conversation is 480 px or wider | `inline`, `fullscreen`, and `pip` once the app is saved (a live card before its result: no `pip`) |
| What `pip` is | the same `<dialog>`, `position: fixed`, 384 × 256 app area under a 36 px title bar, in a lower corner of the conversation, 3rem above the input bar | a new frame of the saved app, docked above the composer, full width, 200 pt; title bar only while the keyboard is open |
| Frame reload on a mode change | none (same element; tested) | inline ↔ docked is a new frame, as full screen already was (the plan's decision) |
| Person's control | **Keep in view** beside the full-screen control | **Keep in view** beside the full-screen control |
| `pip` title bar | move to the other corner, Return to card, Full screen, Close; Escape returns to the card | Return to card, Full screen, Close |
| Card's place while in `pip` | "The <app> app is in picture-in-picture" and **Return to card** | the same text and button, in the closed-card line |
| One frame per conversation | `ConversationViewState.mcpAppPip` | `ConversationStore.mcpAppPip` |
| Hidden conversation | hidden with the pool's `display: none`; the virtualizer keeps the card's turn | the dock belongs to the thread screen |

The shared rules are in `client-core`: `mcpAppAvailableDisplayModes`,
`mcpAppGrantedDisplayMode` (grant only a mode the client offers now and the
app declared; an app with no declared list keeps `inline` and `fullscreen`
and gets no `pip`), `mcpAppOffersDisplayMode` (the person's controls follow
the same list), `MCP_APP_PIP_SIZE`, `MCP_APP_PIP_MIN_CONVERSATION_WIDTH`,
`MCP_APP_DOCKED_HEIGHT`. The bridge answers `ui/request-display-mode` with
the mode that results and sends `host-context-changed` on each change.

Providers: no difference. Claude and Codex both reach the same card.

## The move: two corners

The frame moves between the two lower corners of its conversation (one
button in its title bar, kept in `ConversationViewState.mcpAppPipSide`). A
free move needs pointer capture, a keyboard way to do the same, clamping on
each pane resize, and a saved place. Two corners let the person uncover what
they read, and CSS keeps the frame inside its pane when the pane changes
size, with no code. The top corners are left out: the band and the find bar
are there. Mobile has no move (full width).

## Contradictions between the plan and the code

All are corrected in `mcp-first-class.md` (§1 items 24 to 27, §14.2, §20).

1. **The H1 live card never mounted in a turn on desktop and web.** H1 put it
   in the tool-group branch of `TranscriptItem.svelte`; a turn renders tool
   groups with `ToolGroupItem` in `ConversationTurn.svelte`, so the branch was
   never reached (the H1 harness used a stand-in row). The card now mounts in
   `ConversationTurn.svelte` while the turn is live. A finished turn folds its
   tools, so the saved card then shows the app in a new frame, as on mobile.
2. **`container-type` is not the containing block of a fixed element in
   Chromium 152 (Electron 44).** `packages/workspace-ui/CLAUDE.md` says it is.
   Measured in the harness: the pane computed `contain: none`, and the fixed
   frame left the pane for the window. The frame now places itself with CSS
   anchor positioning against the conversation (`anchor-name` and
   `anchor-scope: --solus-conversation` on the conversation root), which is
   right whichever element is the containing block. I did not change
   `packages/workspace-ui/CLAUDE.md` (outside this phase); a maintainer should
   correct its note.
3. **"The card's menu gains Keep in view"**: the card has no menu, only round
   controls. The control is beside full screen.
4. **§20 left out moving the frame; the H2 brief asks for a move.** Built as
   two corners.

## New elements and what they follow

| New element | Follows |
|---|---|
| The `pip` frame surface (radius, fill, shadow) | the approval dialog after this change and the popover surfaces: `rounded-2xl`, `bg-(--solus-popover-bg)`, `shadow-(--solus-popover-shadow)`, no border |
| `pip` title bar text | the full-screen title row of the same frame (`text-workspace-chrome font-medium`) |
| `pip` title bar buttons | the dialog close button of `McpConnectDialog` (`Button variant="ghost" size="icon-sm"`, 16 px icons, `text-muted-foreground`) |
| **Keep in view** control | the existing full-screen control beside it (round outline `Button size="icon"`, 13 px icon) |
| The card's line while in `pip` | the "The <app> app was closed" line of `McpAppCard.svelte` (`min-h-11`, `text-workspace-chrome text-muted-foreground`, ghost **Return to card**) |
| Approval dialog (border removed) | the other dialogs (`SaveQueryDialog`, `McpConnectDialog`): popover fill and shadow, `modal-backdrop` |
| Mobile docked frame | `PendingApprovalCard`, the other card above the composer (`rounded-[20px] border border-border bg-card-alt`, `mx-4 mb-3`) |
| Mobile title bar buttons | the full-screen modal's close button (`size-11`, 16 pt symbol, `accent-icon-muted`); the pip symbols follow `BrowserPreviewRouteScreen` (`pip.enter`, `pip.exit`, Android `visibility`) |
| Mobile card line in `pip` | the closed-card line of `McpAppCard` (same height and border) |

## Screenshots and recording

From a Vite harness outside the repository that mounts the real
`McpAppFrame.svelte` and `ConversationViewState` in a stand-in pane and
conversation (the transcript text, the tool row, and the input bar are
stand-ins, not `ConversationView`). The pane has the `pane` container and the
conversation has the anchor, as in the app. The test app shows its load time,
so a reload shows. Files in
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-633ce405/c2a4379f-8244-4274-a7ac-6165e87fb44e/scratchpad/screenshots/`:

- `01-card-control-light.png`, `02-card-control-dark.png`: the card with
  **Keep in view** beside full screen.
- `03-pip-over-conversation-light.png`, `04-pip-over-conversation-dark.png`:
  the frame in `pip` over the conversation, the input bar clear and focused,
  and the card's line with **Return to card** in the transcript.
- `05-pip-moved-left-dark.png`: after the move, in the lower-left corner.
- `06-pip-narrow-pane-500px-light.png`: `pip` in a 500 px pane.
- `07-narrow-pane-356px-back-inline-no-control-light.png`: the same pane
  narrowed to 356 px while in `pip`: the frame is back in its card, with the
  same load time, and **Keep in view** is gone.
- `08-returned-to-inline-light.png`: after **Return to card**.
- `09-approval-dialog-no-border-light.png`,
  `10-approval-dialog-no-border-dark.png`: the approval dialog without a
  border; it keeps its edge in dark mode.
- `11-pip-to-fullscreen-light.png`: full screen from `pip`.
- `12-inline-pip-fullscreen-back.mp4`: inline → `pip` → full screen → Escape
  → `pip` → Return to card; the load time never changes.

The harness server was started from this worktree and stopped by its PID.

## Tests and checks

- New `tests/unit/mcp-app-pip.test.ts` (2 tests, jsdom, the real component
  and view state): the frame keeps its element in each mode and stays inside
  its conversation; it is not modal; the focus returns to the input bar; a
  second app sends the first back and it hears `inline`; the app's request
  gets the mode that results; Escape on the title bar returns it; a 356 px
  conversation sends it back and refuses the mode; one frame per conversation;
  a live card's key moves to its activity; the virtualizer keeps the turn.
- `mcp-app-host.test.ts` (7 new tests): the grant rule, the narrow width, a
  mobile live card does not offer `pip`, declared modes, the answer.
  `mcp-app-frame.test.ts`: the conversation width, the `pip` context.
- Pass: `mcp-app-host` 34, `mcp-app-live` 18, `mcp-app-frame` 8,
  `mcp-app-pip` 2, `claude-mcp-apps` 16, `conversation-pool`,
  `conversation-turns`, `conversation-turn-identity`,
  `conversation-view-loader`, `transcript-geometry`, `transcript-turns`,
  `transcript-inner-anchor`, `native-mobile-conversation-cards`,
  `native-mobile-thread-feed`, `native-mobile-boundaries`,
  `native-mobile-keyboard-state`.
- Fail, and the same at the base or not in this area:
  `native-mobile-integrations` (the known label), `transcript-virtualization`
  (cannot load: `../../lib/mount-timing`, then `./lib/user-burst`, then the
  fixture turns have no `body`; not in the known list),
  `native-mobile-conversation` (2: `sessionSuggestions` and
  `typeSafeKeyStatus` calls; not in the known list),
  `native-mobile-compiler-coverage` (its baseline is stale for many files; the
  line "McpAppWebView no longer compiles (Immutability)" is the same with the
  base file, so it came with H1; not in the known list; the new
  `ThreadMcpPipDock`, `DockedMcpApp`, and `McpAppCardLine` compile. I did not
  run `--update`, because it would record other sessions' files).
- Type checks (`bun run check`), base → after: server 129 → 129, workspace-ui
  39 → 39, client-core 2 → 2, contracts 0 → 0, mobile 0 → 0 (same text).
  `svelte-check` on workspace-ui: 311 errors, the H1 count; none in a line
  this work changed.
- `oxlint` on the changed files: only findings that the base has
  (`ThreadDetailScreen` complexity 60, `transcript-virtualizer` `refresh` 22
  and one assertion comment). `lint:layout`: the three known files
  (`ProjectChip`, `RunOnPicker`, `EditorVoiceControl`). `lint:surfaces`:
  clean.

## Not done or not verified

- **Mobile was not run**: it needs a native build. Its code passes `check`;
  the dock, the fold under the keyboard, and the feed line are not seen on a
  device. The unit tests cover the shared rule that a mobile live card does not
  offer `pip`.
- Desktop (Electron) and the real web client were not run; only the harness.
  The real `ConversationView`, composer, session action row, and decision
  cards were not in the harness. The z-order of decision cards over the frame
  (7 over 6) and the 3rem gap over the action row are from reading the code.
- A conversation in the companion pane: `--solus-composer-height` is
  published by the leading column; whether the companion conversation has
  its own value was not checked, so the frame there may sit lower than the
  composer's edge.
- `anchor-scope` keeps each visible conversation's anchor to its own frame
  (a split view). A browser without anchor positioning places the frame at
  the lower corner of its containing block instead.
- A real app that does not set `color-scheme` from the host theme shows an
  opaque light backdrop in dark mode (Chromium paints it). This is the app's
  duty and not new; the harness app sets it.
- No real provider turn ran, so the live card's new mount in
  `ConversationTurn` is verified by reading and type checks only.
