# Transcript cards

Every raised object in the conversation transcript uses one shell,
`TranscriptCard` (`packages/workspace-ui/src/components/conversation/`). A card is
one 40px line at full column width. It uses the same slots as `ActivityRow`, so
cards and activity rows line up down the turn. A body appears only when there is
something to read.

Source: the "Conversation Cards Spec" design project (turns 2b, 3a, 3b, 4a, 4b).

## Principles

1. **One line first.** Every card is usable at its 40px header line.
2. **Same column as the text.** Full column width, with the left edge flush to the
   prose. No centring and no percentage widths.
3. **Same slots as `ActivityRow`.** A 22px glyph slot, a title, a target, and a
   rail. All sans: mono is kept for code, such as file paths in a diff tree and ids.
4. **Use a lowercase type word when the card needs one.** It follows the title.
   A document card uses only its icon for the type. No uppercase kicker and no
   status chip. The glyph and any type word carry state.
5. **Raise only what blocks.** Passive cards use the quiet shell. Only a card that
   stops the turn until the user acts uses the attention shell.

## Anatomy

```
| pad-l | glyph 22 | gap | Title | type word | target | flex | rail | actions | pad-r |
```

| Slot | Rule |
|---|---|
| Glyph | 13px icon in the 22px slot, muted. `is-done` (sage), `is-failed` (destructive), `is-artifact` (primary). `.activity-spinner` while running. |
| Title | `--text-activity-label`, 500. Truncates first. |
| Type word | Lowercase, muted, never truncates. A failure reason goes here. |
| Target | Optional path, branch, or file. Sans, `--text-tool-step`. |
| Rail | Counts and time only, never prose. Sans with tabular figures, `--text-transcript-meta`, 70%. |
| Actions | 24px targets (32px on touch), 8px from the card edge. Icons 14px. At most one primary and one ghost button, plus a split icon or ⋯. |

Body layouts (`bodyLayout`):

- `prose` — indented by `--tx-card-body-indent` so text aligns with the title.
- `media` — full-bleed under a 0.5px rule, capped at 150px.
- `rows` — grouped rows (`TranscriptCardRow`) under a rule inset 12px.


## Actions

`TranscriptCardAction` renders every button on a card line and every row in its
⋯ menu. It stops the click so that the card does not open too.

- `primary` — 6% fill. Open, Report, Read, Done.
- `filled` — primary orange, only when the card waits on the user. Review, Connect, Sign in.
- `ghost` — no fill. Pause, Annotate, Stop, Not now.
- `icon` — 24px square. Split and dismiss.
- `item` — a row in the ⋯ menu.

If the card has a ⋯ menu, select **Open in split view** there. If the card has
no menu, the split icon stays visible. Cmd-click or Ctrl-click on a card also
opens it in split view. On cards with a split action, a quiet Open uses an icon
(↗, labelled by `actionLabel`). A filled action keeps its word. The ⋯ menu can
also hold publish, task link, copy id, provenance, stop, and change.
Cards with a visible prose or rows body place actions in a wrapping footer at the
bottom-right. Header-only cards and media cards keep actions at the right edge of
the card line, so an action never floats alone under a picture. Disclosure controls and the ⋯
menu stay in the header, so a footer never holds ⋯ alone. This applies to rate limits, setup recovery, connections, and output cards.

The host applies Queue to held user prompts when the setting changes or a client
rejoins. The decision card disappears only after the host confirms a queued retry.

## States

| State | Shell |
|---|---|
| Resting | quiet |
| Hover (clickable) | `--solus-tx-quiet-shadow-hover`, no translate |
| Pressed | `scale(0.996)` |
| Focus-visible | 2px `--solus-tx-focus-ring` (neutral, never the accent), offset 2px |
| Open in the pane | `open`: the composer's focus ring (1px accent at 34%, 4px halo at 9%); a grouped row takes the 1px ring inset |
| Running | spinner; type word becomes a participle |
| Streaming | same height as the landed card, skeleton bars and a word count |
| Failed | `failed`: destructive 26% ring; reason in the type slot; Retry |
| Waiting on the user (agent) | `waiting`: chart-2 40% inset ring; body opens |
| Blocking interrupt | `variant="attention"`: neutral edge, stronger lift |
| Resolved interrupt | quiet, header only, check glyph, Done |
| Closed or superseded | `superseded`: 0.85 opacity, 1 on hover |

Attention applies to Connect, RateLimit, Permission, and blocking Question
cards.

### Connect card

When agents ask for external accounts or integration sign-ins
(`connection.connectNeeded`, `integration.connectNeeded`), the conversation
shows one group card for all of them (`ConnectCard`). The store
(`connectRequestStore`) keeps every open request for each conversation. A
repeated request for the same service replaces its row and does not add one.
The card uses the same surface as the agent conversation card: the transcript
card fill and radius, with the attention lift. It has an eyebrow with the count
("3 sign-ins needed", "1 of 3 connected") and one row for each service
(`ConnectRequestRow`). Each row shows a 24px round mark, the name, and a line
that tells why the service is needed. When the service is connected, a green
check badge shows on the corner of the mark and the line says "Connected". The action is on the right. When a
sign-in needs more steps (a running flow, a code, an OAuth client, a key),
those steps open under the row, indented to the name. The footer has Not now,
which cancels the waiting sign-ins, and Continue, which sends a prompt that
names each connected account. When all rows are connected, the card becomes
quiet. On mobile, the connect sheet shows one card for each integration.

### Pull request group card

When a final reply links two or more pull requests in a row, they share one
card (`ReplyPullRequestGroup`). It is a disclosure card with the quiet shell:
a muted pull request glyph, "3 pull requests", and the states as the target
("1 open · 1 draft · 1 merged"). It opens unfolded, and a click on its line
folds it; folded, the rail totals the files. Each row is the grouped form of
`PullRequestTurnCard`, a `TranscriptCardRow`: the state glyph in its tone, the
title, the lowercase state word, `owner/repo #N`, and the size. The row's
`trailing` slot holds its watch, a 24px icon button: a green eye while the
session watches it, a crossed eye while a watch can start, and an empty slot
for a merged or closed pull request, so the sizes line up. The rules of the
single card's watch footer apply (docs/plans/session-artifacts.md §9).

### Sign-in panel

The Claude and Codex sign-in card (`SeatConnectCard`) is the one card that does
not open as a 40px line. A person who is not a developer must sign in before
any turn can run, so the card is the provider's own panel: the provider's mark
in a 36px plate, "Sign in to Claude" with a plain subtitle, and two numbered
steps (`SignInSteps`). The first step opens the provider's page; the second
moves a short code across: Claude's page shows a code to paste back, and Codex
shows a code here to enter on its page. The current step carries a 1px
`--solus-accent` outline at 45% with no fill; a done step shows a check. It
keeps the attention lift and the transcript card radius, and once the seat
connects it collapses to the quiet resolved line, like every other interrupt.
The same steps show in Settings, host setup, onboarding, and the phone's
sign-in sheet, with their words in `@solus/client-core/sign-in-steps`. The
words avoid developer terms such as host, seat, and token; the pasted-token
fallback stays in Settings only.

The card also opens when a provider refuses a turn's login: a Codex 401, or a
Claude "Invalid API key", expired OAuth token, or `authentication_error`. The
normalizers mark that `error` event `kind: 'auth'`
(`execution/agents/auth-failure.ts`). The host expires the author's member seat,
so the next prompt asks to reconnect. The host login keeps no state, because
its CLI answers for it. The card says "Sign in to Codex again" and stays open
until a new login ends, even when the seat still reads as connected. On a Solus
Cloud host the panel opens the account's cloud connections. On every other host
it runs the provider's login there. The phone's sign-in sheet offers the same
choice. It does not start a sign-in until the person asks for one.

History keeps the refusal. A Codex failed turn with a refused-login error,
or a Claude `authentication_failed` row, has the mark `loginRefused` on the
history row. When that row ends the newest page, the card opens again on open,
restore, or reload. A later turn after the row, or an older page, does not open it.

`AttentionCard` uses the `TranscriptCard` shell. `InterruptCard` (permission,
question, and secret requests) is its own glass shell: the card background, the
attention lift, and no header line, inner rule, or footer rule. It uses the
geometry of the agent conversation card: the 12px card radius, 24px pills
(32px on touch) with a 6px radius and 12px type, and option rows in the type of
an agent row (a 12px label and an 11px description).
One eyebrow line in meta type says who asks ("Claude asks", "Claude asks for
permission", "Alice's turn asks to run a shell command") with the count and the
clock at its right. The body's lead line is the question, or what the agent wants
to do with a chip naming the worktree. No text on the card is bold. Options are
soft rows with a hairline between them, inset to the text column as in Settings; the selected row takes the accent tint, an inset
ring, and a check. The own-words field is one more row in the options' type: a pen
in the radio column, 12px words on a soft fill, and no hairline until it has focus.
The question ends in one row, as a permission does: Back as text at the left,
"Let Claude decide" as text, and Send or Next as the filled pill.
A secret request uses the same bar for its field, with Show and Save securely inside it; Decline is a text link under it. A focused bar darkens its hairline to `--solus-tx-focus-ring`; no field on a card takes the accent ring. A permission ends in
one row: Deny as text, broader grants as quiet pills, the narrowest grant as the
filled pill, and the scope of the pill under the pointer or focus written at the
left of the row (`permissionScope`). The command is the only boxed thing, a
terminal line with Copy on hover; Details in the eyebrow folds the request id,
tool, cwd, and time. Key hints exist for focus and show only while the pointer
or focus is on the card. Message-mode questions use the quiet lift because they
do not stop a turn.

Codex may emit a message-mode question while its turn continues. Its question
card remains open when that turn ends and after the client reconnects. An
answer steers a running turn or starts another turn; Dismiss closes the question
without sending a message. A blocking provider callback still holds its turn
until answered.

The host owns whether a request can still be answered. When a run exits, stops,
or dies with a blocking permission or question open, the host tells the
provider no. It then sends `permission_resolved` with `expired: 'run_ended'`
for each request. The card stays, but its footer shows the reason ("No longer
answerable — the run ended.") in place of its answer controls. A card with an
expiry does not keep the session in "awaiting" in the sidebar. It leaves when
the next turn starts. This applies to Claude and Codex, on desktop, web, and
mobile.

- On reconnect, the host sends the client its list of open requests
  (`pending_input_sync`). A card that the client kept from before, and that was
  answered or closed meanwhile, leaves. When no run is alive, the client marks
  each blocking card `run_ended`.
- An answer to a request that the host does not hold now fails with the code
  `REQUEST_NOT_ANSWERABLE`. The client shows a toast, and the card shows
  `closed` ("No longer answerable — it was answered elsewhere or closed.").
- A message-mode question is saved on the host and never expires with its run.

The cards at the tail of the transcript answer the previous send: a done or
failed setup card (worktree, host, or pull request checkout), and the Connect,
Seat, turn refusal, and finished sign-in cards of that conversation. When the
person sends a new prompt, these cards leave (`clearSettledCards`). Two kinds
of card stay because their work is still in progress: an active setup card and
a sign-in that waits on the browser. If the new prompt still needs a card, the
host refuses the prompt again and the card comes back. When the run starts, a
setup card that the host reported on settles to "Worktree ready" and stays. It
is folded to one line in the turn its send started, after the prompt. It opens
by itself when a step has a warning. The card that the client shows at Send,
which the host did not confirm, leaves. When a run fails or dies, a setup card
that did not fail leaves at once, because no setup continues after the run
ends. A failed setup card stays for its recovery actions.

### Agent rows

Sub-agents and the sessions another agent starts follow T3 Code's subagent
link: one row (`AgentLinkRow`) on the transcript card's surface (its fill,
radius, and quiet ring). The row has a 24px round provider avatar, the title
(12px, 500), a detail line (11px, muted), the state mark and the elapsed time
(10px, mono), and a chevron when there is something to open. The row takes a 4% wash on hover.
The avatar uses `ProviderMark` (transparent), as T3 Code does: one quiet tile
for every provider, and the mark carries the identity. Claude is in its brand
colour and Codex is in the text colour. The tile fill is opaque: 2% foreground
on the card in light mode and 3% white on the card in dark mode.

- **State mark.** The sidebar's state marks (`docs/plans/session-state-marks.md`,
  "Agent rows"), before the elapsed time. Dots move while the agent works and
  keep the time beside them; Input, Approval, and Limited show a glyph and a
  word, and no time; Done and Failed show the glyph and the time.
- **Status word.** `Running`, `Queued`, `Starting`, `Waiting`, `Completed`,
  `Failed`, or `Stopped`. It is the detail line when there is no detail, and
  the row's `aria-label` says it.
- **Detail.** For a sub-agent: the step in flight and its target while it runs,
  the first line of its answer when it returns, or the reason it failed. For
  a session: the first line of the reply, or why it ended (`Never started`,
  `Stopped replying`, `Reply lost in a restart`, `Closed its session`).
  Markdown is reduced to plain text.
- **Hover.** The native tooltip names the sub-agent's model and effort, or the
  session's provenance.

A lone sub-agent is one row. All sub-agents that one turn launches share one
group at the position of the first launch. Tool calls and prose between two
launches do not start a second group. A new turn starts a new group. The
group is a header button: up to three overlapping avatars without dots (then
`+N`), the label `3 subagents` (12px, 600), a status line (`2 working · 1 done
· 1 failed`, blue while any agent runs, destructive when one failed), the
elapsed time, and a chevron. It is folded until the reader opens it. A folded,
settled header is at 55% opacity. The header and the rows share one card;
open, the rows show under a hairline.

A session row shows ⋯ before the time on hover or focus, and always on touch.
Select **Open in split view** from the menu, or Cmd-click or Ctrl-click the row
to open the session beside this conversation. When the other agent waits on a
person here (a request or a plan decision), the decision shows under the row,
indented to the title.

Consecutive thoughts and commands share an activity group. While work runs,
the collapsed group previews the latest thought above its status. It shows the
opening bold heading or the first sentence, wrapped to at most four lines.
Open the group to see the steps in order. A collapsed thought takes one line.
Select it to read the full text.
Codex streams summary and content parts. Solus uses the project's configured
Codex reasoning summary, with an automatic summary as the default. Claude
streams summarized thinking blocks. Later text updates the same row, even
when a tool has already started. A block with no readable text adds no row.
Older live events without a block ID can still attach a thought to the next
tool call or reply.

Agent reply images, generated images, and browser captures appear in a compact
image gallery below the final reply. Open the tool details to see images
returned by a tool, including device screenshots. Each gallery preview shows a thumbnail, a file
name or label, and the format. Image embeds in assistant replies render as file
chips at their authored positions. A chip opens the file; the gallery below the reply provides image
previews. Videos keep their existing presentation. Prompt attachments stay with the prompt.

The gallery fills the conversation column on desktop, web, and mobile.
Desktop and web use the shared carousel with previous and next controls instead
of an overflow strip. Mobile shows a selected preview with previous and next
controls, and uses the existing native file gallery for full-size viewing.
Browser captures share their full-size capture gallery and retain page opening
and annotation. Console error messages are not shown on previews or in the
capture gallery. The gallery stays below the reply in either fold state.
Images load through host-signed URLs. Reply image parsing is cached per message.

An open thought scrolls inside a box of limited height. Its markdown renders
only while it is open. Its open state belongs to the conversation, so it stays
open when the transcript recycles the row. A thought between two prose blocks
starts a new prose block, so a live turn and a reloaded turn look the same.
The transcript does not keep the thoughts of sub-agents.

The trace keeps each thought too. The `thought` attribute on its `thinking`
span holds the full text, with no cap. A sub-agent's thinking span also holds
the text when the provider sends it. The insights span detail shows it as a "Thought" block, and the text goes
with the span to OTLP when trace export is on.

### Context compaction

When the provider compacts the context, the transcript shows a divider at that
point: "Context compacted". The divider also shows the trigger (automatic or on
request) and the token counts before and after, when the provider reports them.
Claude reports all three. Codex reports only that a compaction occurred.

In a Codex session, use `/compact` to compact the context without sending a
message to the model. Desktop, web, and mobile use the same command. Send a
first message before you use it. If a turn is active, wait for it to finish.
Stop interrupts the compaction. An interrupted compaction adds no divider.

The live `context_compaction` start event draws the divider at once, with the
label "Compacting context". The label shimmers while the compaction runs. The
shimmer stops when the divider is off screen, and it does not move when the
device asks for reduced motion. The stop event changes the same divider to the
result. A failed compaction removes the divider. If the turn ends before the
compaction stops, the divider is removed too. After a reload, the history read
draws the finished divider from the provider transcript: Claude's
`compact_boundary` system line, or Codex's `contextCompaction` item.

Desktop, web, and native mobile show the same divider and the same words
(`@solus/contracts/context-compaction`). The read-only session record shows the
finished divider.

## Tokens

`workspace.css` declares `--solus-tx-quiet-*`, `--solus-tx-attention-shadow`,
`--solus-tx-divider`, and the `--tx-card-*` geometry. In dark mode the quiet shell drops its lift
because the fill does the lifting.

## Tool outputs

A tool call can give the person visible outputs. One rule says where each one
shows, for every tool: Solus tools, the built-in tools of Claude and Codex, MCP
tools, and resource reads.

1. Open a tool call to see the images it returned.
2. The turn gallery shows images in the agent's replies, generated images, and
   browser captures.
3. Desktop and web show chips below folded rows for audio clips and left-out
   notes. Each audio chip shows the server name and format, such as
   `elevenlabs MP3`. A chip opens the tool details and moves focus there.
   A running call adds no chips.

When a read tool successfully opens a raster image from the workspace, a
preview appears below its tool group on desktop, web, and mobile. Expand
the turn to see the group. Select the preview to open the file at full size.
The preview loads the current file from the session's host.

The rule is in code at one place, `packages/client-core/src/tool-outputs.ts`
(`TOOL_OUTPUT_PLACES`), shared by desktop, web, and mobile. A new output field
on a tool call's message must get a place there: the type check and
`tests/unit/tool-outputs.test.ts` fail until it has one.

| Output | Place | Why |
| --- | --- | --- |
| Images (`toolImages`): MCP image blocks, a `Read` of a picture, device screenshots, resource reads | Open tool details | Rule 1 |
| Browser capture (`browser_snapshot`) | Gallery, as its capture card | Rule 2 |
| Artifact preview screenshot (`render_artifact`) | Neither | The agent's own check; the artifact card shows the page |
| Audio (`toolAudio`) | Strip on desktop and web, tool details on all clients | Rule 3 |
| "Left out" notes (`toolLeftOut`) | Strip on desktop and web, tool details on all clients | Rule 3 |
| Progress (`toolProgress`) | Neither | The running row's label and bar show it, and a live turn does not fold |
| Error head (`errorHead`) | Neither | A failed row and a failed turn say so on their own line; the head is diagnosis |
| The call's input (code in the open line) | Neither | It is the call, not an output |
| Text result of the call | Neither | It does not reach the client |
| Saved MCP App card, HTML artifact, work card, automation card, plan, review guide, browser recording, agent conversation card | Neither | Own cards that stay visible in a folded turn |
| Live MCP App card | Neither | A live turn does not fold; the saved card takes its place |
| MCP task rows, resource watch rows | Neither | Shown after the last turn |
| Linked pull requests and files, changed files | Neither | Chips and the changes summary at the turn's end |
| Sub-agent card, answered question, secret receipt | Neither | Steps of the work: the turn row counts them |

On desktop and web, more than one tool line of a group can be open at a time,
as on mobile. The open lines are part of the conversation's view state, so they
stay open after a tab switch.

## Not in scope

- The agent conversation switchboard was deleted before this change, so its
  rows in the design are not built.
- A mixed "turn outputs" group for 3+ cards of different types is an open
  question in the design and is not built.


Successful `update_work` calls add a work card for documents and slides.
The card shows the version saved by that call (`v1`, `v2`, and so on).
The title stays unchanged. Open loads the current saved work. The card is
restored from the successful tool receipt after a reload on every client and for
both providers. Failed and unfinished saves do not add a completed card. Repeated
writes to one work in a turn keep one card with the latest update. HTML artifacts
keep their inline revision preview.

Image and video file chips open the media modal on desktop, web, and mobile.
This includes Markdown links, image embeds shown as chips, and file path chips.
Host files and stored assets load through host-signed URLs. Other file types keep
their existing file preview route. Escape or the close button closes the desktop
and web modal and returns focus to the chip.

The full image gallery card opens its preview, including the filename, file type,
and padding. Each card has one keyboard and accessibility target.

### T3 conversation cards

Review feedback can appear as file-and-code cards inside a user message. MCP
Apps appear as sandboxed interactive documents with close/reopen and full-screen
actions. The app of a Solus integration tool shows while its call runs, below
the call's activity row, and keeps its frame when the call ends; a stopped or
failed call removes it and leaves the tool row. In the approval dialog of an
app, tool arguments show as code and every other detail as text. Provider subagent rows can open recorded child activity, including a separate Codex
history read through the parent tool. These surfaces follow the T3 reference
with Solus colors; they are deliberate exceptions to the general transcript
card shell. See [the capability and protocol rules](plans/conversation-card-parity.md).

On desktop and web, the host's worktree setup uses the setup card shell, the
same as a pull request checkout or a continue-in-worktree card. It adds Work
locally and Cancel while the host makes the worktree. When setup fails, it
shows the last eight output lines in the terminal panel (`ui/terminal-output`).
The phone keeps the T3 stage rows and Details sheet, with the same actions.

A step can be pending, active, done, skipped, warning, or failed. A skipped step
had no work to do, for example no submodules. A warning step shows an amber
marker and its detail line, and setup continues. Skipped and warning steps count
as finished in the step count. The steps of the host's card carry the host's
start and end times, and the card shows the durations from them. A card that the
client makes (a pull request checkout, a continue-in-worktree, a conflict
resolution) has no host times; it shows the times that the client saw. The steps
and their meaning are in [worktree names](worktree-names.md#start-point).

## Copy tool rows

On desktop and web, use **Copy tool row** beside the activity header to copy
its tool calls, or expand the row and use **Copy tool call** beside one call.
The copy includes the tool name, status, full available input, and error head.
Ordinary tool output is not sent to the client and is not included.
Historical inputs load on demand; a failed load reports an error instead of
copying an incomplete summary. Formatting runs only on click, with no new
streaming derivations or history prefetch. The shared copy button shows a check
for 1.5 seconds after a successful copy; its reset timer starts only on copy.

On mobile, long-press a tool row to copy its full detail.
