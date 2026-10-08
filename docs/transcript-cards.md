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
4. **Name the type once.** A lowercase type word after the title (`plan`, `doc`,
   `diagram`). No uppercase kicker and no status chip. The glyph and the type word
   carry state.
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
| Actions | 24px targets (32px on touch), 8px from the card edge. Icons 14px. At most one primary and one ghost button, plus split and ⋯. |

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

The split icon is always visible, never hover-only. Cmd-click on a card does the
same. Beside the split icon, a quiet Open is an icon too (↗, labelled by `actionLabel`),
so the line reads ⋯, split, ↗ as one row of icons. A filled action keeps its word. The ⋯ menu holds publish, task link, copy id, provenance, stop, and change.
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
| Focus-visible | 2px `--solus-accent-border-medium`, offset 2px |
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

`AttentionCard` and `InterruptCard` use the same `TranscriptCard` shell.
Permission and question bodies stay open, with their decision controls in the
wrapping footer. Their header uses a glyph, a lowercase type word, and a time
rail. Message-mode questions use the quiet shell because they do not stop a turn.

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
host refuses the prompt again and the card comes back. When a run fails or
dies, a setup card that did not fail leaves at once, because no setup continues
after the run ends. A failed setup card stays for its recovery actions.

### Agent rows

Sub-agents and the sessions another agent starts follow T3 Code's subagent
link: one row (`AgentLinkRow`) on the transcript card's surface (its fill,
radius, and quiet ring). The row has a 24px round provider avatar with a
status dot, the title
(12px, 500), a detail line (11px, muted), the elapsed time (10px, mono), and a
chevron when there is something to open. The row takes a 4% wash on hover.
The avatar uses `ProviderMark` (transparent), as T3 Code does: one quiet tile
for every provider, and the mark carries the identity. Claude is in its brand
colour and Codex is in the text colour. The tile fill is opaque: 2% foreground
on the card in light mode and 3% white on the card in dark mode.

- **Dot.** Blue (`--chart-5`) for every in-flight state, sage (`--chart-3`)
  when done, destructive when failed, and muted when stopped or closed.
- **Status word.** `Running`, `Queued`, `Starting`, `Waiting`, `Completed`,
  `Failed`, or `Stopped`. It is the detail line when there is no detail.
  When there is a detail and the agent is not done, the word also shows
  after the title, at 10px.
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

A session row keeps its split and ⋯ controls before the time. They show on
hover or focus, and always on touch. Cmd-click opens the session beside this
conversation. When the other agent waits on a person here (a request or a
plan decision), the decision shows under the row, indented to the title.

A finished tool-group row that says "Thought for …" also shows the first line
of the latest thought, as plain text in the foreground colour, and truncates it
to one line. Claude sends the text of its thinking blocks; Codex sends its
reasoning summary, or the raw reasoning when there is no summary. When the
provider sends no readable text (redacted, omitted, or encrypted reasoning), the
row shows only the label. A live "Thinking" row does not show a thought, because
the text arrives only when the thought ends.

The full text of each thought is kept, and the user can read it. The thought
is kept on the message that comes after it:

- **Before a tool call.** An open tool group shows a "Thought" step above that
  tool's step. The step shows the first line. A click opens the full thought as
  markdown.
- **Before prose.** The thought goes into the tool group above the prose, as a
  "Thought" step after the last tool call. When no tool call comes between the
  prose blocks, a collapsed "Thought" row shows above the prose, with the first
  line as its target. When the turn ends, this row folds behind the turn row
  with the tool calls, and the answer stays on screen.

Everything between two prose blocks is one activity row: the tool calls and
the thoughts around them. An empty assistant message does not close the row.
Only prose, a card (a question, a sub-agent, an agent conversation, a document,
and the other result cards), browser snapshots, or a notice closes it.

Browser snapshots are not cards. They render inline as the pictures
themselves, so the reader can read a capture without opening it. The frame
takes the whole column at the capture's own shape, up to 36rem tall. Several
captures show one frame at that size, with thumbnails under it; the arrows,
← →, or a thumbnail change the frame. One line under the pictures carries the
count, address, console errors, time, and Annotate and Open
(`BrowserSnapshots.svelte`).

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

## Not in scope

- The agent conversation switchboard was deleted before this change, so its
  rows in the design are not built.
- A mixed "turn outputs" group for 3+ cards of different types is an open
  question in the design and is not built.


Successful `update_work` calls add a work card for documents, slides, and diagrams.
The card shows the version saved by that call (`v1`, `v2`, and so on).
The title stays unchanged. Open loads the current saved work. The card is
restored from the successful tool receipt after a reload on every client and for
both providers. Failed and unfinished saves do not add a completed card. Repeated
writes to one work in a turn keep one card with the latest update. HTML artifacts
keep their inline revision preview.
