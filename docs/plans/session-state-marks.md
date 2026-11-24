# Session state marks

Status: in progress. The host contract, the host behaviour, and the shared dot
mark table are done. The desktop and web UI (`packages/workspace-ui`) and the
mobile UI (`apps/mobile`) are next.

## Goal

Every surface that shows the live state of a session uses one vocabulary of
**state marks**. These surfaces are the sidebar rows, the conversation
breadcrumb, the session switcher, previews, workspace session cards, the
session lists of the task page, and the mobile thread rows. A state mark goes
in the one mark slot that a row has now.

There are three families:

1. **Letters.** A 3×3 dot grid draws a letter. The five core steps of a turn
   spell S·O·L·U·S, so a normal turn writes the product name.
2. **Patterns.** A 3×3 dot grid whose motion alone gives the meaning.
3. **Line glyphs.** Still outline icons. Three of them add one word.

Rule: dots move while the agent works. A still glyph means that a person must
act, or that the turn is done.

## Vocabulary

Use these names in code, docs, and conversation.

- **state mark** — what a row shows for the state of a session: a letter, a
  pattern, or a line glyph.
- **dot mark** — a letter or a pattern on the 3×3 dot grid.
- **line glyph** — a still outline icon (the `TaskStatusGlyph` family).
- **agent activity** — what the agent does now inside a running turn.
- **write motion** and **run motion** — the two motions of a letter.

"Agent activity" in this plan is not the iOS Live Activity card
(`live-activity-push.md`, `@solus/contracts/live-activity`). The type is
`AgentActivity` in `@solus/contracts/agent-activity`. Do not mix the two.

## The state map

| State | Family | Mark | Source of truth |
|---|---|---|---|
| Starting | letter | S, dense, run motion, the head runs backward | `status: 'connecting'` |
| Thinking | letter | O, write motion | agent activity `think` |
| Reading | letter | L, run motion | agent activity `read` |
| Editing | letter | U, write motion | agent activity `edit` |
| Running | letter | S, dense, run motion, the head runs forward | agent activity `run` |
| Searching | pattern | scan | agent activity `search` |
| Writing | pattern | type | agent activity `reply` |
| Working | pattern | sweep | agent activity `other`, and `running` with no known activity |
| Background | pattern | checker | `status: 'background'` |
| Offline | pattern | ripple, muted colour | the host of the row is not reachable (`Host.presence`) while the row shows a live state |
| Delegating | pattern | orbit | an agent waits on the agents it started (an agent card in `waiting_for_children`) |
| Input | line glyph + word | question bubble + "Input" | a question waits |
| Approval | line glyph + word | shield with exclamation + "Approval" | a permission request waits |
| Limited | line glyph + word + time | clock + "Limited" + the reset time when known | `status: 'rate_limited'` |
| Plan | line glyph | page | a plan waits |
| Failed | line glyph | crossed circle | failed or dead, and not read |
| Done | line glyph | circle with check | finished and not read; replaces the dashed `UnreadDot` ring |

The conversation’s agent cards and the Agents views in Threads and the
Project panel share the same state-mark rules. They read execution status and
live activity from the Sessions store. Agent status marks show only the icon
and keep the status name available to assistive technology. The runner saves delegation waits and
known rate-limit reset times with the execution. An exchange supplies the
reply and the controls for an agent’s request.

The marks of a running turn (Thinking, Reading, Editing, Running, Searching,
Writing, Working) keep the elapsed time beside them. Starting, Background, and
Offline show no time.

Precedence does not change. `resolveSidebarRowMark` returns one mark. A state
that wants a person is first, then unread output, then live work.

## Decision: three line glyphs carry a word

Input, Approval, and Limited show one word beside the glyph. This reverses the
rule "A mark, not a sentence" in the comment of `TaskStatusGlyph.svelte`. The
UI change updates that comment. The word is 12px, weight 600, in the colour of
its glyph. The full sentence stays in the tooltip and in `aria-label`
(`attentionLabel`), for example "rate limited, resets 4:10 PM". The word does
not replace it.

## Host contract

- `@solus/contracts/agent-activity` owns `AgentActivityKind`, `KIND_FOR_TOOL`,
  `agentActivityKind(toolName)`, `AgentActivity`, and `agentActivityOfTool(toolName)`.
  The transcript summary (`activity-summary.ts`) and the state marks use the
  same kinds. `activity-summary.ts` exports `agentActivityKind` and `AgentActivityKind`
  again, so its callers do not change.
- `AgentActivity = 'think' | 'search' | 'read' | 'edit' | 'run' | 'other' | 'reply'`.
  `ask` is not a agent activity: a question is the Input state.
- The Codex names come from `codexToolNameForItem`: `exec_command`, `Edit`
  (a file change), and `WebSearch`. The map has all three. Other Codex names
  (`ImageGeneration`, the collaboration tools such as `spawnAgent`, and MCP
  names such as `server.tool`) are `other`.
- The host event `session.activityChanged` is
  `{ sessionId: string; activity: AgentActivity | null; at: number }`. Its
  registry entry has owner `sessions`, category `delta`, and recovery `reload`.
  Its audience is the audience of `session.statusChanged`: the session is its
  resource. It is a separate topic, not a field of `session.statusChanged`. The
  activity changes many times in a turn, and the status consumers
  (notifications, badges, the status feed) must not run again for each change.
- `session.statusChanged` has a new field `awaitingApproval?: true`. The host
  sets it while the status is `awaiting_input` and the newest input that waits
  is a permission request. When it is absent, the input that waits is a
  question. A client shows Approval for `awaiting_input` with
  `awaitingApproval`, and Input for `awaiting_input` without it or for
  `hasPendingQuestion`. When the newest input changes between a permission and
  a question and the status does not change, the host sends the status again
  on the status feed only (the `session-question` channel). Nothing that a turn
  end does runs again.
- The activity is live only. No `SessionRecord` field. After a reconnect, a
  running row shows Working until the next activity event. The record status
  has no `awaiting_input`, so the record has no approval field either.

## Host behaviour

`packages/server/src/execution/sessions/session-activity.ts` (`SessionActivity`)
derives the agent activity. `SessionRuntime.activity` holds the one instance.
`ProviderEvents` gives it each backend event of a session, and
`SessionStatuses.queueTurnSettlement` gives it `turn_settled`. `boot-server.ts`
broadcasts its events as `session.activityChanged`.

- Only top-level events count. An event with `parentToolUseId` (a sub-agent)
  changes nothing.
- `thinking` with state `start` or `update` gives `think`. `tool_call` gives
  the kind of its `toolName`; a question tool gives nothing. `text_chunk`
  gives `reply`. `turn_settled` gives `null`.
- The host sends only a change, and at most one event for each session in
  250 ms (`ACTIVITY_WINDOW_MS`). When the window after the last send is closed,
  a change goes at once. When the window is open, the newest change goes at
  the end of the window. A change that is undone inside the window sends
  nothing.
- The send of `null` ends the turn for the tracker, and it forgets the
  session. The first activity of the next turn goes at once.
- The clock and the timer are injected, so the tests are deterministic.
- Claude, Codex, and Replay (`showcase`) emit these normalized events, so all
  three get the full set.

## Dot mark table

`@solus/client-core/dot-marks` holds pure data and pure functions. It has no
DOM, React, or Svelte. The Svelte `DotMatrix` and the React Native component
read it.

- `DotCell = [row, col]`. `DotKeyframe = { offset, scale, easing? }`. The
  `easing` runs from that keyframe to the next one; without it the segment is
  linear.
- `LETTER_PATHS` — the cells of S (dense, 7 dots), O, L, and U in pen order.
- `PATTERNS` — the curve (offset → scale), the duration, and the phase of each
  cell for sweep, scan, type, checker, ripple, and orbit.
- `writeMotionKeyframes(index, count)`, `runMotionKeyframes(index, count)`,
  and `patternKeyframes(curve, phase)` build the keyframes of one dot.
- `DOT_MARKS` — each dot mark by name (`starting`, `thinking`, `reading`,
  `editing`, `running`, `searching`, `writing`, `working`, `background`,
  `offline`, `delegating`): its family, its duration, its dots with their
  keyframes, and its still scale for reduced motion.
- `DOT_MARK_FOR_ACTIVITY` — the dot mark of each `AgentActivity`.
- `DOT_SIZE_PX = 3` and `DOT_GAP_PX = 2`: a 13px box, the box of the glyphs.

Cells are `[row, col]`, 0-based, row 0 at the top.

```
S (dense, 7 dots)    O (8 dots)      L (5 dots)      U (7 dots)
. # #                # # #           # . .           # . #
# # #                # . #           # . .           # . #
# # .                # # #           # # #           # # #

S: [0,2] [0,1] [1,0] [1,1] [1,2] [2,1] [2,0]
O: [0,1] [0,0] [1,0] [2,0] [2,1] [2,2] [1,2] [0,2]
L: [0,0] [1,0] [2,0] [2,1] [2,2]
U: [0,0] [1,0] [2,0] [2,1] [2,2] [1,2] [0,2]
```

Starting uses the S path in the reverse order. Its head starts at `[2,0]`.

### Write motion (O, U)

The cycle is 64 frames at 60 fps (`WRITE_MOTION_MS`). Dot `k` of `n` grows
from scale 0 to 1 over 6 frames at frame `k * 24/n`. It holds. It shrinks from
1 to 0 over 6 frames at frame `24 + 16 + k * 16/n`. The easing is
`cubic-bezier(.3,0,.2,1)`. The grid is empty for the last frames of each cycle.

### Run motion (S, L)

The cycle is 42 frames (`RUN_MOTION_MS`). Every dot of the letter is always
visible at scale 0.5. A bright head runs along the path without a stop. Dot
`k` peaks at scale 1 at `k / n` of the cycle, then decays 1 → 0.8 → 0.62 → 0.5
at one step (`1 / n`) each, linear between keyframes. The rise to the peak
takes one frame, so the head reads as a jump and the dot ahead of the head
does not glow. The letter is never empty.

### Patterns

Each pattern is one curve and a phase for each dot. `patternKeyframes` turns
the curve by the phase, so all dots share one duration and one start time. A
dot with phase `p` is the curve `p` of a cycle later. The orbit curve has
different ends, so its jump stays: two keyframes share the offset of the
phase.

| Pattern | Curve (offset:scale) | Duration | Phase of dot `[r,c]` |
|---|---|---|---|
| sweep | 0:1, .18:0, .5:0, .68:1, 1:1 | 1.6 s | `c * 0.1` |
| scan | 0:0, .35:1, .72:0, 1:0 | 1.6 s | `r * 0.14` |
| type | 0:0, .12:1, .55:1, .67:0, 1:0 | 2.0 s | `(r*3 + c) * 0.045` |
| checker | 0:1, .5:.25, 1:1 | 2.4 s | `((r + c) % 2) * 0.5` |
| ripple | 0:0, .35:1, .72:0, 1:0 | 2.0 s | `hypot(r-1, c-1) * 0.14` |
| orbit | 0:1, .22:.45, .38:0, 1:0 | 1.2 s | perimeter index / 8, clockwise from `[0,0]`; the centre dot is off |

## Motion rules

- Animate only `transform: scale`. No JS frame loop and no interval timer.
- Build the keyframes once for each dot. Run them with the Web Animations API
  (`element.animate`) on web and desktop, and with Reanimated on mobile. Set
  the start of the animation to the timeline origin (`startTime = 0`), so all
  copies of a mark are in phase.
- **Hold for whole cycles.** When the mark changes, the current mark completes
  its cycle before the next mark starts. An activity that is shorter than the
  remainder of the cycle does not show. One timeout for each change is
  acceptable; a polling loop is not.
- Reduced motion: letters show all their dots at full size, still (`stillScale`
  1). Patterns show their dots at scale 0.75, still. Line glyphs are still
  already.

## Colour

Use the tokens that exist. Do not add colours.

- Letters and patterns of live work: the running colour that the surface uses
  now (`--solus-status-running-icon`, or the `text-chart-5` of the spinner).
- Offline: muted foreground.
- Input, Approval, Plan: `--primary`.
- Limited: `--warning`; its reset time in the muted foreground, regular weight.
- Failed: `--destructive`.
- Done: `--solus-status-complete`.

## Surfaces

Desktop and web share the Svelte components in `packages/workspace-ui`.
Mobile (`apps/mobile`) has its own React Native implementation. Every surface
shows the same states. The macOS menu-bar icon and the dock badge are out of
scope.

### Desktop and web

- `components/ui/DotMatrix.svelte` draws a dot mark; `components/ui/lib/dot-matrix.ts`
  holds its logic (`planDotMarkSwitch`: the switch at the end of a cycle).
  Its colour is `currentColor`.
- `AttentionState` has `starting` (status `connecting`) and `approval`; the
  `TaskStatus` values are `starting` and `approval`. The row mark
  (`resolveSidebarRowMark`) is a line glyph (`finished` is the Done check), a
  dot mark with the elapsed time of a datable running turn, or a shelf clock.
  The spinner and the dashed `UnreadDot` ring of finished work are gone;
  `UnreadDot` stays only as the icon of "Mark Unread".
- `SidebarSessionStatusFeed` holds the agent activity of every session, from
  `session.activityChanged`, for rows with and without an open tab. It
  forgets the activity when the status leaves `running`, and on a reset of
  the host connection. `SessionSidebarStore.liveFactsOf` gives each surface
  the activity and whether the host is offline.
- An open tab shows Approval when a permission request waits and no question
  waits: its two queues have no order.
- Offline uses the host's readiness (`reconnecting`, `unreachable`,
  `refused`, `gone`), not `Host.presence`, which knows only `present` and
  `gone`.
- No Merging mark: the client has no merge-in-progress state (a merge
  writes `merged` at once and takes it back on a refusal). The orbit
  pattern means Delegating instead.
- A row shows what a session it started waits on the person for, at any
  depth: Approval for a permission, Plan for a plan, and Input for a
  question. The started session needs no row or tab here. Its host reads the
  open exchanges of the session (`SessionOrchestrator.delegatedRequestOf`) and
  sets `SessionExecution.delegatedRequest`; `delegatedAttention` gives the
  row its mark. The request outranks Delegating and every mark of work. A
  request of the session itself outranks it. An independent session has its
  own row, so its request stays there.

### Agent rows (desktop and web)

The agent row (`AgentLinkRow`) of a sub-agent and of a session that a session
started shows a state mark before its elapsed time, with the grammar of the
sidebar (`AgentStateMark`, `conversation/lib/agent-link.ts`). The avatar shows
only the provider. The project panel's Agents card and the session overview
(`rail-agents.ts`, `AgentRow`) read the same `AgentStateMark`, so one agent has
one mark everywhere.

- A running sub-agent shows the dot mark of its step now, from the last row of
  its nested transcript only: a tool in flight gives the mark of its activity,
  streamed text gives Writing, and a settled step gives Thinking (the host
  drops a sub-agent's thinking). With no nested transcript, the heartbeat's
  `lastToolName` gives the mark; with nothing known, Working. Done and Failed
  show their glyph.
- A started session: dispatched or queued is Starting; replying is the dot
  mark of its agent activity (`SessionSidebarStore.activityOf`, keyed by its
  host and session id), else Working; waiting on its own agents is
  Delegating; waiting on a person is Approval for a permission, Plan for a
  plan, and Input otherwise; rate limited is Limited with its reset time;
  failed is Failed; lost in a restart is Offline; replied is Done; closed
  shows no mark.
- The time shows beside the marks of work and of a settled agent. Starting,
  Offline, Input, Approval, and Limited show no time.
- Background work (`BackgroundWorkRow`) shows Running in place of its spinner,
  and a running MCP task or resource watch (`BackgroundItemRow`) shows Working.
- Group headers keep their text, and their stacked avatars show no mark.

### Mobile

- The thread rows (`ThreadListV2Row`, on the home list and the tablet
  sidebar) show the state marks. `resolveThreadListV2DotMark` picks the dot
  mark of a working or waiting row; the other states keep their line glyph.
  Failed and Done show the glyph only. Mobile shows a plan to approve as
  Approval, so it has no Plan glyph.
- `ThreadListState` keeps the agent activity and `awaitingApproval` of each
  thread from the host events.
- A row whose started session waits on the person (`delegatedRequest`) shows
  Input, whatever the request is: a mobile row has one mark for a request. Offline comes from the host's readiness
  (`away`).
- `DotMatrix` runs one native-driver `Animated.loop` for each mark, not
  Reanimated: the app turns off Reanimated's commit pausing, and a perpetual
  Reanimated animation starves React's commits. Each copy reads its phase
  from `performance.now()`, so all copies are in phase.
- Limited shows no reset time on mobile: a session record has no rate limit
  information, so a row does not know it.
- The thread screen has no state mark slot, so it does not show the agent
  activity.
- The agent cards of a conversation (`src/solus/ConversationCard.tsx`) show a
  state mark beside the title, with the same grammar as the rows. The tables
  and the rules are in `src/features/threads/state-marks.ts`; the rows use the
  same tables.
  - A provider sub-agent: while it runs, the dot mark of its newest step. Its
    own transcript (`TranscriptModel.activity`) keeps the activity by the
    host's rules. A history page has no activity, so the newest running row
    tells it. A background sub-agent whose rows do not come to the client
    reports its last tool (`background_task_progress`, `lastToolName`).
    Nothing known gives Working. Done and Failed show the glyph.
  - A session that this session started: dispatched or queued gives Starting;
    replying gives that session's agent activity from the thread list state,
    or Working; waiting for its own agents gives Delegating; waiting on a
    person gives Approval or Input; a rate limit gives Limited; failed gives
    Failed; lost gives Offline; replied or interrupted gives Done. Mobile has
    no closed state for a card.
  - Any other tool card: its own kind while it runs (a command is Running, an
    MCP call is Working), Failed when it failed, and no mark when it is done.
- The Agents sheet uses the same dot marks and line glyphs as the agent cards.
  Its rows show Starting or Working from the agent status. The row gives the
  elapsed time in its own column. Done and Failed use the shared glyphs.

## Tests

- `tests/unit/session-live-activity.test.ts` — the transitions of a turn,
  sub-agent events, question tools, the 250 ms window with an injected clock,
  the clear on `turn_settled`, the tool-name map for Claude and Codex, and the
  `awaitingApproval` field.
- `tests/unit/dot-marks.test.ts` — the paths stay in the grid and use each cell
  once, keyframe offsets stay ordered and in range, a still mark stays visible,
  and a phase shift preserves a jump at the end of a curve.
