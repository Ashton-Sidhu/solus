# Insights: reading a turn, not just recording it

The turn page used to be a record: the spans, the attributes, the exchange.
This plan makes it a reading — what went wrong, what was slow, what it cost,
and what to do next — and adds the two surfaces a reading needs around it: a
session page and live turns.

Everything here is derived from what the host already recorded. Where a
number is an estimate it is labelled one; where the record cannot answer, the
surface says so instead of printing a zero.

## Vocabulary

- **finding** — one thing worth the reader's attention on a turn: the failing
  span with its error, a denied permission, a repeated call, a large wait, a
  cache written and never read, a full context, a top-tier model spent on a
  lookup. `lib/turn-analysis.ts#turnFindings`. Each finding points at the spans
  it is about; the first is where a click lands.
- **waiting on** — the turn's wall clock charged to whoever was being waited
  for: the model, the tools, the person, recorded provider waits, or Solus.
  Unrecorded time is a separate category with no known cause. A tool that
  sat behind a permission dialog charges the dialog to the person, not the
  tool. `waitingOn`.
- **baseline** — this turn against its own session's median and against every
  turn on the same model in the window. One neighbour is not a baseline
  (`BASELINE_MIN_SAMPLES`). A figure past twice its baseline is drawn as a
  warning. `turnBaselines`, `annotateStats`.
- **cache economics** — hit rate as reads over everything the model was given,
  and the dollars saved solved from the turn's own reported cost and the
  provider's list-price ratios — never a price table that goes stale.
  `cacheEconomics`.
- **estimated cost per kind** — the turn's reported cost spread over thinking
  and streaming by their share of that time. Tools carry no cost of their own:
  their results are input to the next model call. `estimatedKindCosts`.
- **coverage reading** — one cut of the turn's interval drawn as the bar above
  the waterfall: span kind, waiting on, or estimated cost. One bar shows one
  reading, chosen from a menu in the Trace header; a reading the turn cannot
  answer is not in the menu.
  `lib/coverage-readings.ts`.
- **context fill** — tokens the context held after this turn over the window
  it ran in, and the delta from the previous turn in the session. Recorded by
  the emitter as `contextUsedTokens` from the provider's last usage report of
  the turn. `contextGrowth`. Past `CONTEXT_FILL_WARNING` it is a finding.
- **repeated call** — the same tool asked the same thing more than once, with
  whitespace not a difference. `repeatedCalls`.
- **result** — the section that answers "can I trust what this turn changed,
  or must I check it myself?". It has three parts:
  - **verdict** — one sentence from the order of edits and checks
    (`lib/turn-verification.ts`, `turnVerification`). *Failing*: a check's
    last run failed. *Stale*: code changed after the last passing check; the
    files are named. Docs (`.md`, `.mdx`, `.txt`) do not count. *Verified*: a
    check passed after the final code edit. *Hidden*: checks ran, but each
    was piped (`| tail`) or chained (`;`, `||`), so its exit status is
    another command's; a span keeps no output, so this is never called a
    pass. *Unchecked*: files changed and no check ran.
  - **checks** — one row per check command (test, type check, lint), with
    how its last run ended and how many runs there were. The `cd` before the
    command and the pipe after it are removed. Claude reports a non-zero exit
    as an errored call with no code; Codex gives the code. Codex commands are
    `exec_command` with the raw string, often in `/bin/zsh -lc '…'`, and
    Codex edits are `Edit` with a `changes` list; both are read. A shell
    command that failed and never succeeded later is listed under **Failed
    and not run again**; `grep`, `rg`, `test`, and similar probes are not.
  - **changes** — where the turn's git change went, drawn with the diff heat
    map (`DiffHeatMap`, at the Insights chrome size). Its line is the only
    place the totals are printed.
  - **diffs** — one diff card per changed file, closed until opened: the
    review guide's card with the shared `DiffFileCardHeader` (caret,
    `DiffFileTypeBadge`, muted folder and emphasized name) and `+N −M`. An open
    card renders the file's patch with `Diff.svelte`, loaded on first open. The
    patch is cut per file with `splitPatchByFile` (the review guide's). A cell
    on the map opens the same card and scrolls to it. Open cards belong to one
    turn. Above the cards are the diff panel's own controls,
    `DiffLayoutToggle` (unified or split) and `DiffTokenToggle` (token
    highlighting). Both read `diffViewPreferences`
    (`lib/diff-view-preferences.svelte.ts`), the one stored choice the diff
    panel also uses. Below 640px of width the layout control is hidden and the
    cards stack, as the diff panel does.
  - **reuse** — every line (the verdict, each check, each failure) is a
    `FindingRow`, the row `TurnFindings` draws, in the same type. Commands are read with
    `activityKind` and `parseToolInput` (conversation's tool parsing),
    `unwrapShellCommand` (`lib/changedFiles.ts`), and `withoutLeadingCd`
    (the waterfall's labels). Edited paths come from `toolPathsFromParsed`.
    The context is `IpcContextBuilder.forSessionRecord`; the map's file
    listing is `repoFileLoader`, shared with pull request review and the
    review surface; the patch is read with `parsePatchFileList`.
- **turn change** — the git snapshot the host writes when a turn ends, found
  by its **trace id**. `TurnSnapshot.traceId` is written by `snapshotTurn`
  from `AgentRunSessionState.turnTraceId`, which the session runtime passes
  to the Claude and Codex backends. The snapshot index is not the join: it
  counts snapshots, and a turn that skips its snapshot does not advance it.
  The store (`loadTurnChange`) calls `listTurnSnapshots`, then `diff` with
  `{ kind: 'turn', index }`. Its context names only the Solus session id;
  the git handlers take the provider thread and the checkout from the
  session's lineage (`withSessionCheckout` in `worktree-handlers.ts`). The
  access policy already checks that id. After a provider handoff, only the
  active lineage member's turns are reachable. A turn with no snapshot (not a
  git project, or recorded before snapshots named their trace) says so and
  draws no map. A
  running turn has no snapshot yet; the host's `metrics.turnsChanged` for
  the trace clears the cached answer.
- **heat map tone** — the hue of a changed cell: added (sage,
  `--solus-art-3`), removed (`--solus-stop-bg`), or rewritten (the accent),
  at three quarters of the changed lines (`heatTone` in `diff/lib/heat-map.ts`).
  The tint's strength is still the heat. The same colours print `+N` and
  `−N`, and the legend names the three hues. This applies everywhere the map
  is used: pull request review, the review surface, and Insights.
- **thoughts** — each recorded thought is read on its thinking span in the
  waterfall, not in a card of its own. The row label is `thinking · <first
  line>`, and the span detail shows the full thought as markdown. The waterfall
  already shows each thought beside the step that follows it. Claude runs with reasoning request `showThinkingSummaries: true` through the
  Agent SDK. Codex retains `summary: auto`. Neither changes reasoning effort.
  Summary length and availability depend on the provider; stored text is not
  shortened, and past turns cannot gain text the provider did not send.
- **model choice hint** — a rule, not a model call: a top-tier model, only
  read-only tools, no subagent, a short answer. It never switches anything.
  `modelChoiceHint`. A cheaper tier is assumed at `CHEAPER_TIER_COST_RATIO`.
- **subagent rollup** — what an agent run holds: nested spans, tool calls,
  active time, failures. The provider reports tokens per turn, so a run has no
  cost of its own. `subagentRollup`. The waterfall already nests a run's spans
  under it; the lane's badge now says what is inside.
- **errors first** — a failed turn nobody deep-linked into opens on the span
  that failed, preferring the tool that was refused over the stream that
  failed after it. `firstFailingSpanId`.
- **turn flag** — a person's mark on a turn: `good`, `bad_answer`,
  `too_slow`, or `expensive`, with a note. One per turn; a second replaces the
  first and keeps its creation time. Durable in solus.db beside the saved
  queries (`turn_flags`), host-local like the spans it points at. RPC:
  `metricsListTurnFlags`, `metricsSetTurnFlag`, `metricsClearTurnFlag`.
  Each kind has a glyph and a colour: thumbs up in green, thumbs down in
  red, snail in amber, dollar in plum. The turn
  header shows one chip; its popover sets the kind, holds the note, and
  clears the mark. Rows show the glyph, and the note is in the hover text.
- **turn status glyph** — a turn's state is an icon, never a dot: running
  (dashed circle), stopped, failed (`lib/turn-status.ts`). The rail and the
  turn header use the same glyphs.
- **session page** — one session's turns on one axis: a bar per turn, spend
  climbing over it, the context after each turn under it. Route
  `insights/session/<sessionId>`, in the same panel a turn opens in.
  `lib/session-page.ts`, `SessionDetailPanel.svelte`.
- **live turn** — a turn whose root has not ended. The tracer writes a turn's
  root open the moment it starts (`writeOpenSpan`, `onStart` in
  `tracer.ts`); the finished span replaces the row. The panel re-reads a live
  trace every two seconds until the root closes, then once more. Only a turn
  is written open: every other span is short and would double the writes.
  The open row carries the prompt, session, backend, and project from the
  start. When setup completes, `updateOpenTurn` rewrites it with the model and
  the task; a later `session_init` or reroute that changes the model rewrites
  it again. The list marks a row with no end as Running. The first open of
  `metrics.db` in a process closes every open turn row as interrupted, at the
  end of its last child: those rows belong to a host that stopped mid-turn.
  The Session column reads task title, then the session's name, then its id. Each write of a turn row, open and
  finished, is announced after it commits as `metrics.turnsChanged`
  (`onTurnRowWritten` in `span-table.ts`). While the page is open, the store
  re-reads Solus's own paged listing on it, debounced, with no loading state.
  SQL the user wrote is never re-run unasked. The panel keeps its poll: an
  event per child span would be traffic to every client for one open panel.

## The turn page, in order

1. Title and identity, the mark, and the ways out: open session, open task,
   share, and a menu with the session page, the prompt into the composer
   (`pendingInput` on the revealed session), and JSON export. Share is the
   app's `ShareButton` on the session the turn belongs to; there is no share
   kind for a single turn. The console query is on the session's own menus.
2. The stat row: one card of tiles — duration, cost, tokens, cache,
   context. Tool calls are not a tile: the count says little on its own, the
   trace header states it, and a denied permission is a finding. Each tile judges its figure (`TurnStat.verdict`): an icon
   in a round badge, green for good, grey for typical, the warning or failure
   colour for bad. Arrows up and down mean above or below the median, a dash
   typical, a check a cache hit, a triangle a warning, a crossed circle a
   failure. The verdict word is the icon's
   tooltip and accessible name, not printed.
   Duration, cost, and tokens are judged against the session median (or the
   model's): 2× or more is bad, 0.67× or less is good. The cache is good at an
   80% hit rate and bad under 50% on a large input. The context is bad at 80%
   full. A meter under
   the figure (`TurnStat.meter`) shows it against its reference: the median
   tick on a 0–3× scale, the hit rate, or the fill with the 80% line. Only the
   badge and the meter carry the verdict colour; the tile, the figure, and the
   line under it stay neutral. With no baseline, the figure is stated and not judged. The
   line under the meter says what the figure is made of or its ratio to the
   median; the full comparison is the tooltip.
3. The result, at full width: the verdict; the change map (**Changes**)
   beside the **Checks** (stacked below `@3xl`); then the **Diffs**. Absent when the turn changed nothing, ran
   no check, and had no failure.
4. Findings, then the trace (one coverage bar, set to Span kind, Waiting on,
   or Est. cost from the header menu, then the waterfall), then the exchange.
5. The rail: the session, the tool ranking, the attributes.

## Type on the turn page

Four roles, on the three Insights type tokens. Nothing else sets a size.

| Role | Token | Used for |
|---|---|---|
| Figure | `text-insights-summary-heading`, medium | The stat row values |
| Heading | `text-insights-summary`, medium | Every card title, in sentence case |
| Body | `text-insights-summary` | Rows a reader reads: session turns, tools, files, findings, thoughts |
| Meta | `text-insights-chrome` | Labels, figures in rows, legends, menus, axes, the waterfall, notes |

Text is `text-foreground` or `text-muted-foreground`, or a status colour
(failure, warning, passed). No uppercase labels, no opacity on text, and no
sizes outside the tokens. A sub-group label (Changes, Checks, a group of
attributes) is Meta in medium weight. Monospace is for recorded code only:
a span's payload and an attribute recorded as code.

## Export and sharing

`traceExportJson` is the spans, the gaps, the log events, and the readings
above as one document; `downloadText` saves it through the browser on every
client. Sharing goes through the session's share dialog.

## Not done, on purpose

- Lines added and removed: not recorded on any span.
- Per-message tokens: providers report per turn, so per-span cost stays an
  estimate by time share.
- Flags as SQL: they live in solus.db, not metrics.db, so a query cannot join
  them yet. They filter the listing's chips and travel in the export.
- A listing from SQL the user wrote does not follow live turns; Solus's own
  listing does.

### Unrecorded time and web calls

Unrecorded time is trace coverage, not a provider-delay finding. The trace cannot establish its cause. The Waiting on reading separates this remainder from recorded rate limits and compaction.

Codex web calls can start with an empty query. Completion supplies the query, action, and results; the normalizer updates the input and output before closing the call. Old web calls without a query or action target are excluded from repeat findings. Their missing input cannot establish repetition.
