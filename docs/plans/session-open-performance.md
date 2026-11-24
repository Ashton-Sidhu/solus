# Session open performance

Status: steps 1–7 implemented, and the turn image gallery mounts its carousel
only when a turn has an image. Clean A/B on 2026-10-15: the same tree built
twice, with and without steps 1–7 (rounds A and B). The server goal is met;
the client goal is not.

The tables below keep the results of rounds A–G. The raw JSON reports were
removed from the working tree; they remain in Git history. The benchmark
scripts, recorded baselines, and goal limits remain in `tests/benchmarks/`.

| Median, ms | 1× A → B | 4× A → B |
|---|---|---|
| History request sent | 70–72 → 19–20 | 252–276 → 68–75 |
| Painted, typical / heavy / huge | 133 / 169 / 166 → 103 / 135 / 146 | 558 / 575 / 564 → 552 / 627 / 650 |
| Painted, agentic | 204 → 165 | 703 → 656 |
| Painted, fence / tool artifacts | 192 / 179 → 116 / 117 | 736 / 784 → 622 / 558 |
| Frame loaded, tool artifacts | 226 → 274 | 1052 → 1280 |
| Longest task, artifacts at 4× | | 375 / 333 → 195 / 192 |
| Tool artifact page | 779 → 44 KB | |

Open problems found by the A/B:

- At 4× CPU the heavy and huge sessions paint 50–85 ms later. The reads
  removed in step 5 were the first layout reads of the frame; the layout
  still happens, now forced by `ConversationMinimap.recompute`,
  `OuterScrollbar.updateThumb`, and floating-ui. Style plus layout time did not
  fall. These readers need the same treatment: read in one phase after the
  transcript paints, or take sizes from `ResizeObserver` entries.
- At 1× CPU a 66–76 ms long task appears on plain sessions. The page now
  arrives before the tab exists, so its conversion and the first mount run in
  one task. Yield between tab creation and the transcript apply.
- A tool artifact frame loads later: its HTML is one more read when the row
  mounts. Read the HTML of the newest revision of each artifact right after
  the transcript paints, not when the frame mounts.

Round C tried the three fixes above:

- The minimap and the outer scrollbar now read layout in their frame. Style
  plus layout at 4× fell on heavy and huge (536 / 597 → 517 / 513 ms).
- A yield between the tab and the transcript removed every long task at 1×
  (longest 66–76 → 0–55 ms) but painted later: 1× typical 103 → 126 ms, 4×
  +40–76 ms on every session. The browser rendered the empty tab in between.
  Removed.
- Reading the newest render of every artifact after the transcript applied
  made the frame on screen wait behind the others (1× 274 → 297 ms). Now only
  the single newest render reads early, in one read when its version is the
  work's current one.
- The tooltip that opens after a click is not the clicked row's. The list
  reorders, and another row lands under the resting pointer. Row tooltips now
  stay shut after a click until the pointer moves more than 4 px.

Round D measures the corrections. Median, A → D:

| | 1× painted | 4× painted | 4× settled | 4× blocking |
|---|---|---|---|---|
| typical | 133 → 101 | 558 → 493 | 1464 → 957 | 486 → 442 |
| heavy | 169 → 122 | 575 → 543 | 1492 → 1177 | 617 → 579 |
| huge | 166 → 112 | 564 → 537 | 1375 → 1103 | 605 → 560 |
| agentic | 204 → 140 | 703 → 567 | 1467 → 1132 | 705 → 601 |
| fence artifacts | 192 → 111 | 736 → 535 | 1441 → 1094 | 665 → 474 |
| tool artifacts | 179 → 103 | 784 → 505 | 1483 → 1213 | 706 → 471 |

Style plus layout at 4× fell 6–26% (for example fence artifacts 639 → 472 ms).
No tooltip opened after any of the 36 opens. Still open: a tool artifact frame
loads later than in A (1× 226 → 266 ms, 4× 1052 → 1211 ms), a 60–72 ms long
task remains at 1× on most sessions, and no fixture meets the goal limits
(paint ≤ 300 ms at 4×).

Builds A–D compiled Svelte in dev mode: the agent shell inherits
`NODE_ENV=development`, and Vite treats a build as production only when
`NODE_ENV` is unset or `production`. `scripts/build-parallel.sh` now sets
`NODE_ENV=production`, and `session-open.ts` refuses a dev-mode build. Round D
built for production, median:

| | 1× painted | 4× painted |
|---|---|---|
| typical / heavy / huge | 90 / 100 / 98 | 473 / 525 / 524 |
| agentic | 137 | 514 |
| fence / tool artifacts | 96 / 93 | 500 / 480 |

The 1× paint goal (≤ 100 ms) holds for five of six sessions. At 4× the main
thread is the bottleneck; the host answers in 10–40 ms. One heavy open at 4×
(660 ms to paint):

| Work before paint | ms at 4× |
|---|---|
| Composer focus during the open: cursor anchor (`coordsAtPos`, forced layout) and CodeMirror focus | ~100 |
| Svelte mount of the new tab and composer, not yet split by component | ~150 |
| Transcript mount, of which markdown token components ~54 | ~110 |
| Virtualizer row measure (`refresh`), the transcript's first layout | ~48 |
| Composer shape animation measure | ~20–36 |
| Click to history request (two frames, then `getSessionInfos`) | ~75 |

Next, in order: defer the composer focus and its cursor anchor until after the
transcript paints; render settled markdown to HTML once; split the tab mount by
component; request history from the row's own facts at pointer down. Reaching
300 ms at 4× likely also needs the tab and composer to stay mounted across
opens instead of mounting again.

Round E (production build) adds: the composer
reads the caret's box only while its menu is open and focuses once per frame;
finished replies write plain blocks as HTML; the history request leaves at
pointer down from the row's own facts; opt-in mount timing
(`lib/mount-timing.ts`, localStorage `solus.mount-timing`). Median, round D
production → round E:

| | 1× painted | 4× painted | 4× history request |
|---|---|---|---|
| typical / heavy / huge | 90 / 100 / 98 → 82 / 85 / 85 | 473 / 525 / 524 → 349 / 364 / 366 | 74–86 → 7–8 |
| agentic | 137 → 94 | 514 → 385 | 77 → 8 |
| fence / tool artifacts | 96 / 93 → 87 / 85 | 500 / 480 → 383 / 365 | 74–75 → 7–8 |

Each open reads its page once. At 1× every session paints within 100 ms, and
typical, heavy, and huge meet every 1× limit. At 4× the page now arrives
before the tab exists, so the tab and the transcript mount in one task: paint
is 349–385 ms, and the longest task grew to 257–284 ms. Still open: paint ≤ 300
ms and tasks ≤ 100 ms at 4×, tool artifact frames (1186 ms at 4×), and the
agentic page size (338 KB).

Round F adds: a view that opens at the end
chooses the first page's rows at the end and scrolls there in its first render
(the top rows used to mount, then the jump to the end mounted the rest: all 10
turns of `heavy`, now 2), and `setKeys` ranges from the last read instead of
reading layout before the DOM update. The virtualizer's own `ResizeObserver`
stays: it is how heights that change after mount, and the reader's anchor,
are kept. Median, round E → round F at 4×:

| | painted | longest task | blocking | settled |
|---|---|---|---|---|
| typical | 349 → 279 | 257 → 221 | 449 → 343 | 895 → 740 |
| heavy / huge | 364 / 366 → 305 / 304 | 268 / 266 → 243 / 242 | 546 / 546 → 374 / 360 | 1000 / 1017 → 769 / 786 |
| agentic | 385 → 323 | 277 → 250 | 569 → 389 | 1046 → 807 |
| fence / tool artifacts | 383 / 365 → 274 / 270 | 284 / 273 → 212 / 209 | 487 / 558 → 310 / 346 | 1072 / 1187 → 784 / 885 |

Fence artifact frames load at 463 ms (goal met), tool artifact frames at 885
ms. At 1× paint did not change (78–102 ms). Each open folds the composer once:
three fold reads, 3 ms at 1× and 14 ms at 4×, so it is not worth a change now.
Still open at 4×: the longest task (209–250 ms, goal 100) and blocking time
(310–389 ms, goal 150), paint for heavy, huge, and agentic (304–323 ms), tool
artifact frames, and the agentic page size.

Round G keeps the newest render's HTML in the
history page, and measures the page as the socket sends it: deflated
(`perMessageDeflate`, over 1 KB). The agentic page is 338 KB of JSON and 41 KB
on the wire, and parses in under a millisecond, so smaller tool rows would save
almost nothing; the goal now limits the wire size (≤ 50 KB), which every
fixture meets. The fixture's artifact HTML repeats more than a compiled bundle,
so a real page with a large newest render deflates less. Tool artifact frames
load at 138 ms (1×) and 496 ms (4×), both within the goal. At 4× every session
but agentic (315 ms) paints within 300 ms.

Still open: the longest task (191–240 ms at 4×, 53–60 ms at 1×), blocking time
at 4× (302–371 ms), and agentic paint (112 ms at 1×, 315 ms at 4×). Reusing a
mounted conversation view would save its own mount (7 ms at 1×, 33 ms at 4×),
but the view binds its tab's state when it mounts, so reuse would rebuild it
anyway.

Not done from the plan: one metadata read instead of `getSessionInfos` plus
`describeSession`, the sidebar row tooltip that opens under the pointer, and
the composer's shape animation reads. Mobile keeps inline artifact HTML: only
the desktop and web clients set `deferArtifactHtml`.

Baseline recorded 2026-10-15.

Not done from the plan: one metadata read instead of `getSessionInfos` plus
`describeSession` (the history read now runs beside them, so they are off the
critical path locally), the sidebar row tooltip that opens under the pointer,
and the composer's shape animation reads. Mobile keeps inline artifact HTML:
only the desktop and web clients set `deferArtifactHtml`.

This plan measures a cold session open, with and without HTML artifacts. It
finds where the time goes and sets a goal. Then it gives the fixes in order.

## Vocabulary

- **Cold open**: the user selects a session in the sidebar, and this client has
  not loaded that session. The host is running and its file cache is warm.
- **Content painted**: the first frame that shows transcript content.
- **Settled**: the workspace stops changing for 800 ms after content paints.
- **Frames loaded**: every artifact frame on screen fired `load`.
- **Busy loop**: the host event loop also does other work, as it does while
  agents stream. The benchmark models it with 3 ms of work every 2 ms.

## How to measure

| Command | What it measures |
|---|---|
| `bun tests/benchmarks/session-open.ts [--runs 7] [--trace] [--cpu-throttle 4] [--label name]` | Click to paint in headless Chromium against the built `dist/` server |
| `bun tests/benchmarks/session-open-server.ts [--busy]` | The server read path, one phase at a time, from source |

Both use the fixtures in `tests/benchmarks/session-open-fixtures.ts`. The
fixtures copy the shape of real sessions on a developer machine: about five
prompts a session, 15–75 tool calls a prompt, a structured `toolUseResult`
beside each result, and signed thinking blocks with empty text. The largest
first page in real use had 1,515 messages; the `agentic` fixture has 1,530.

The end-to-end benchmark uses a temporary `HOME`, `SOLUS_DATA_DIR`, and dev
log. It pairs through the pair URL that the server prints. It does not build,
and it does not touch live data. `--cpu-throttle 4` slows the renderer the way
a laptop that is busy with agents, builds, and other tabs does. Both scripts
compare the result with `tests/benchmarks/session-open-goal.json` and print
each limit that the run misses.

Recorded baselines: `tests/benchmarks/session-open-baseline.json` (1× CPU, 7
runs) and `session-open-baseline-cpu4.json` (4× CPU, 5 runs).

## Baseline

Medians in milliseconds after the click. `KB` is the history page on the wire.

| Fixture | File | KB | 1× request | 1× painted | 1× frames | 4× request | 4× painted | 4× frames | 4× longest task | 4× blocking |
|---|---|---|---|---|---|---|---|---|---|---|
| typical | 0.6 MB | 42 | 69 | 128 | | 247 | 530 | | 226 | 459 |
| heavy | 2.9 MB | 168 | 69 | 153 | | 241 | 534 | | 219 | 541 |
| huge | 29 MB | 148 | 69 | 150 | | 246 | 545 | | 225 | 564 |
| agentic | 6.1 MB | 338 | 68 | 174 | | 253 | 625 | | 229 | 604 |
| fence artifacts | 0.8 MB | 191 | 69 | 158 | 190 | 253 | 694 | 908 | 330 | 609 |
| tool artifacts | 1.4 MB | 779 | 68 | 169 | 214 | 241 | 763 | 1000 | 319 | 666 |

At 4× CPU the workspace settles 1.3–1.5 s after the click.

The real app agrees. Its `dev.log` (read only) has 188 history page reads:
p50 59 ms, p90 380 ms, maximum 1.5 s, on the server alone. Codex pages average
223 ms. Claude pages average 116 ms. The fixtures read the same pages in
7–45 ms on an idle host.

## Where the time goes

### 1. The history request starts late

The client sends `loadSessionPage` 68 ms after the click at 1×, and 240–250 ms
at 4×. This is 45% of the time to paint. Before the request:

1. `SessionSidebar.activateTask` waits two animation frames.
2. `getSessionInfos` and then `describeSession` run one after the other. The
   server reads the same session metadata for both.
3. `resumeSession` creates the tab, reveals it, and mounts the skeleton.

Only then does `loadSessionTranscript` send the request. The server resolves the
lineage itself, so the request needs only the session id, provider, and project
path. The sidebar row has all three at the click. On a remote host each of the
two metadata calls adds one more round trip before the transcript.

### 2. Forced layout during the first render

At 4× CPU, the renderer main thread spends this time between the click and the
settled state:

| Kind | typical | tool artifacts |
|---|---|---|
| Script | 559 ms | 592 ms |
| Style recalculation | 343 ms | 506 ms |
| Layout | 99 ms | 188 ms |
| Module evaluation | 62 ms | 61 ms |

Most of the style and layout time is forced. Script reads a layout value after
a DOM write, so the browser must recalculate style and layout at once. The
sampled profile shows these reads as the hottest "functions":

| Read (4× CPU) | Self time | Source |
|---|---|---|
| `getBoundingClientRect` | 110–119 ms | virtualizer `refresh` (`transcript-virtualizer.svelte.ts:209`) and others |
| `getComputedStyle` walk up the tree | 28–116 ms | `scrollContainerOf` (`lib/scroll-container.ts`), called by every `SandboxFrame` |
| `getPropertyValue` × 60 | 107 ms (fence artifacts) | `buildSandboxThemeCss` (`lib/artifactSandbox.ts`), called for every frame `srcdoc` |
| `scrollHeight`/`clientHeight` | 36–79 ms | `OuterScrollbar.updateThumb` |
| `offsetTop` | 49–51 ms | transcript measurement |
| floating-ui overflow ancestors | 39–66 ms | `@floating-ui/utils` in `page-chrome`; probably the sidebar row tooltip under the pointer (to confirm) |
| `focus()` | 30 ms | `requestInputFocus` during the open |
| `scrollHeight - scrollTop` | 27–28 ms | `ConversationMinimap.recompute` |
| `scrollTop` animation | 23 ms | `response-scroll.ts` scroll to bottom |

Each read runs in a different effect or frame callback, after a different
write. So the browser recalculates style for the full document many times
instead of once.

### 3. Code highlighting runs inside the open

Shiki's WASM regex engine takes 130–140 ms at 4× (about 35 ms at 1×) between
the click and the settled state. Code first paints as plain text, which is
correct. But the highlight pass then runs as long tasks on the main thread
while the reader starts to scroll.

### 4. Artifacts add work before the frame shows

Artifacts add 165–235 ms to content paint at 4× and 30–40 ms at 1×. The frame
then loads 210–240 ms after the content paints.

- Every `SandboxFrame` builds its `srcdoc` when it mounts, also while it waits
  for the viewport. Each build reads about 60 theme variables from
  `getComputedStyle(document.documentElement)`, and each mount walks up the
  tree with `getComputedStyle` to find its scroller.
- `render_artifact` HTML is in the history page: 742 KB of the 779 KB page in
  the `tool artifacts` fixture. A compiled visual-artifacts bundle is
  100–300 KB, and every revision ships. The fence artifacts are part of the
  assistant text.
- The frame height cache key is an FNV hash over the full HTML. It runs at
  mount and again on each height report (10 ms at 4×).

The frames themselves are lazy, which is correct: only the frame on screen
loaded in every fixture.

### 5. The server reads in small sequential blocks

`loadClaudeHistoryPage` reads the transcript backwards in 64 KB blocks, and it
awaits each read. Real first pages are 2–12 MB of JSONL, so a page is up to
185 sequential reads. On an idle host this costs nothing (2–15 ms). On a busy
loop each await waits behind other work:

| Fixture | Idle read | Busy read, 64 KB blocks | Busy read, 512 KB | Busy read, 2 MB |
|---|---|---|---|---|
| typical | 2 ms | 43–46 ms | 18 ms | 14 ms |
| heavy | 8 ms | 158–163 ms | 35 ms | 22 ms |
| agentic | 15 ms | 317–332 ms | 65 ms | 36 ms |

Parsing, projection, tool-input deferral, and serialization together take at
most 4 ms. The block size explains the real 116–500 ms server pages. Event
loop stalls explain the slowest reads: the 8 real reads that overlap a stall
average 820 ms.

Two more server costs are outside the benchmark:

- A Codex page calls `thread/items/list` once per turn, one after the other:
  at least 10 app-server round trips.
- `loadSessionToolInputs` reads and projects the whole transcript each time
  the user opens a tool row.

### 6. Smaller costs

- `formatRailTime` (`hover-rail.ts`) calls `toLocaleTimeString` for each row.
  It builds a new `Intl` formatter each time: 12–21 ms at 4×.
- About 60 ms of module evaluation at 4× is the first open after a page load.
  A running app pays it once, so it is not a target.


## Capture a real cold open

History and mount profiling are temporarily always enabled while we measure
cold opens. No environment variable or local-storage switch is required.
Load the updated server and client code before capturing. History limits and
read order are unchanged. Server timings cover desktop, web, and mobile.

The server writes two structured events:

- `codex_history_page_profile`: reader selection/startup, turn summaries
  (including a resume fallback), item loading/conversion, child-agent checks,
  and saved answers. It includes item request count and total request time,
  turn/message counts, total duration, and the failed stage on error.
- `session_history_response_profile`: history plus projection, activity,
  response preparation, and response size. This covers all providers. Size
  measurement serializes the response once more, for this temporary profiling; its
  cost is reported separately. These timings end before transport send.

Filter a development log with:

```sh
jq -c 'select(.sessionId == "01a18e28-aadb-7811-81f7-388fed5354d2" and (.msg == "codex_history_page_profile" or .msg == "session_history_response_profile"))' dev.log
```

Open the session once, then export the desktop or web client measures from
its developer console:

```js
JSON.stringify(performance.getEntriesByType('measure')
  .filter(entry => entry.name.startsWith('solus.open.') || entry.name.startsWith('solus.mount.'))
  .map(({ name, startTime, duration, detail }) => ({ name, startTime, duration, detail })), null, 2)
```

New `solus.open.*` measures name `describeSession`, `historyWait`,
`automationHydration`, `artifactHydration`, `materializeTranscript`,
`transcriptApplied`, and `transcriptPaint`. Session measures include the
session id. `transcriptApplied` also includes the tab id to match the paint
measure. `historyWait` is the remaining wait when a prefetched request is
consumed, not necessarily the whole network request. `transcriptApplied`
starts at session resume; `transcriptPaint` starts at the transcript component
mount. Use their start times as well as durations; do not add overlapping spans.
The existing `solus.boot.transcript.*` marks cover startup restoration.

Paint means two animation frames after visible rows mount, not confirmed GPU
presentation. Hidden or unmounted views do not report a paint. Native mobile
client rendering is not instrumented by these browser measures; its
server read is covered. No transcript content or tool arguments are logged
by these profile events.

Clear old performance measures before another capture. Restore opt-in
profiling after this investigation.

## Goal

The goal is in `tests/benchmarks/session-open-goal.json`. Every fixture must
meet every limit (median):

| Limit | 1× CPU | 4× CPU | Baseline at 4× |
|---|---|---|---|
| History request sent after click | ≤ 15 ms | ≤ 40 ms | 241–253 ms |
| Content painted | ≤ 100 ms | ≤ 300 ms | 530–763 ms |
| Artifact frames loaded | ≤ 150 ms | ≤ 500 ms | 908–1000 ms |
| Longest task | ≤ 50 ms | ≤ 100 ms | 219–330 ms |
| Total blocking time | 0 ms | ≤ 150 ms | 459–666 ms |
| History page on the wire | ≤ 250 KB | ≤ 250 KB | up to 779 KB |
| Server busy read, `heavy` / `agentic` | ≤ 40 / 60 ms | | 158 / 317 ms |

In short: a cold open paints in half the time or less, artifact sessions
paint as fast as plain sessions, and no open blocks input for more than 100 ms
on a loaded laptop.

## Plan

Do the steps in this order. Each step is one pull request with its own
benchmark result. After each step, run both benchmarks and record a new
`--label` result beside the baseline.

### Step 1. Read the server in large blocks

- Change `BLOCK_BYTES` in `claude-history-page.ts` to grow from 64 KB to 2 MB
  (double each read), so a small page stays cheap and a large page needs few
  awaits.
- Test: a unit test that counts reads for a 6 MB page.
- Expected: busy `agentic` read 317 ms → about 40 ms. Real p90 server page
  380 ms → under 100 ms.

### Step 2. Send the history request at the click

- In `SessionSidebar.activateTask`, before the two frames, call
  `prefetchSessionHistoryPage` with the row's session id, provider, project
  path, and `INITIAL_HISTORY_TURNS`. `requestSessionHistoryPage` already takes
  a matching prefetch.
- The prefetch key must equal the request that `loadSessionTranscript` sends
  (`meta.projectPath || defaultDir`). A test must hold the two keys equal, or
  the open reads the page twice.
- Serve `getSessionInfos` and `describeSession` from one read, or let
  `describeSession` return the metadata, so the open has one metadata round
  trip.
- Expected: request at 69 → under 10 ms (1×) and 247 → under 30 ms (4×).
  Paint gains about 60 ms (1×) and 200 ms (4×). Remote hosts save two round
  trips.

### Step 3. Remove artifact layout reads

- `SandboxFrame` takes its scroll root from the conversation (the view owns
  the scroll element) and stops walking up the tree with `getComputedStyle`.
- Read the sandbox theme palette once per theme change and keep it. Do not read
  it again for each `srcdoc`. Build the `srcdoc` only when the frame is near the
  viewport.
- Key the height cache by `workId` and content version, or by the fence
  identity, not by a hash of the full HTML.
- Expected: artifact fixtures paint within 20 ms of `typical`.

### Step 4. Load tool artifact HTML on demand

- Leave `render_artifact` HTML out of the history page when the message has an
  `artifactWorkRef`. Keep the title, work id, and content version.
- The frame reads the body when it nears the viewport, through the works store
  (`bodyAtVersion`). The store caches it.
- A message with no work reference keeps its HTML inline.
- Expected: `tool artifacts` page 779 → about 45 KB. This matters most on web
  and mobile over a remote connection.

### Step 5. One layout read phase per frame during the open

- `OuterScrollbar.updateThumb`, `ConversationMinimap.recompute`, the
  virtualizer `refresh`, the scroll to bottom, and the "not scrollable" check
  read layout in separate callbacks. Move these reads into one read phase after
  the transcript paints, or use `ResizeObserver` entries, which need no forced
  layout.
- Move `requestInputFocus` after the first transcript paint.
- Confirm the floating-ui cost. If the sidebar row tooltip opens under the
  pointer during the open, do not open it on a row that the user just clicked.
- Expected: style plus layout at 4× from 450–690 ms to under 200 ms. Longest
  task under 100 ms.

### Step 6. Highlight code outside the open

- Highlight visible code blocks first, in slices of 8 ms or less that yield to
  input. Highlight other blocks when the browser is idle. A Web Worker is the
  next option if slices are not sufficient.
- Expected: 130–140 ms (4×) of main thread time moves out of the open.

### Step 7. Small costs

- Cache the `Intl.DateTimeFormat` objects in `formatRailTime`.

### Later

- Codex pages now overlap the first item pages of up to three turns. Results
  are consumed newest first under the existing page budgets; continuation
  pages within a turn stay sequential. At most two unused first-page reads
  can finish after a page fills. No results are cached across page requests.
  Focused tests cover ordering, limits, cursors, and failures. Measure real
  opens with the profile events before claiming a latency improvement.
  Compare the elapsed `items` stage: `itemRequestMs` sums completed request
  durations, which overlap and can exceed elapsed time. Unused reads still
  in flight at return are not included in that sum.
- `loadSessionToolInputs`: read only the page that holds the keys, not the
  whole transcript.

## Surfaces

- Desktop and web share the workspace UI and get every client step. The
  benchmark runs the web client. Electron uses the same renderer code, but it
  was not measured.
- Mobile has its own transcript in `apps/mobile/`. It gets steps 1 and 4 (the
  server and the payload). Measure its open separately before any mobile
  change.
- Claude and Codex both get the client steps. Step 1 is Claude only. Codex
  needs its own step (see Later).
- Local and remote: steps 2 and 4 matter more on a remote host, because they
  remove round trips and bytes.

## Limits of this measurement

- The server and client are the built `dist/` from 2026-10-15 10:40, after HEAD `889dde187`. It can include uncommitted changes from that time.
- The host and client share a machine, so network time is near zero. The real
  cost of each round trip on a remote host is not in the numbers.
- CPU throttling slows the renderer only, not the server. The server busy loop
  is a separate model.
- Each open follows a page load. Module evaluation (about 60 ms at 4×) is
  part of the measured time, but a running app pays it only once.
- The probe that notices paint runs in an animation frame, so each time can be
  late by up to one frame.

## Remote round trips (2026-11-17)

The earlier numbers have near-zero network time. This round measures the web
client of the built app through a TCP proxy that adds 80 ms round-trip time,
and directly. Each fixture is a Claude transcript of 1,500 turns (52–93 MB):
one with inline `render_artifact` HTML, one with `html_path` artifacts and a
`create_automation` call, and one with no artifacts. The before and after
builds ran in turns on one data folder, 5 opens each, in headless Chrome.

### Changes

- `loadSessionTranscript` reads the automation list and the artifact bodies
  at the same time. Both still finish before the rows show, because their
  cards must be in the rows when they first show.
- An `html_path` body is the work's current body while the work is still at
  the version the call wrote: one read. Only an older version reads the
  revision list and the revision: two reads. The inline deferred HTML uses
  the same rule (`savedBody` in `artifact-history.ts`).
- `WorksStore.ensureContent` takes the session's host as a likely owner, as
  `bodyAtVersion` does. A work this client has not listed is no longer found
  by listing the works of every host first.
- Mobile requests the first page while `describeSession` runs. It reads the
  page again only when the lineage moves the thread to another provider.

### Results (median time to visible rows)

| Fixture | Open | 80 ms RTT before → after | Direct before → after |
|---|---|---|---|
| `html_path` + automation | Reload | 1042 → 865 ms | 435 → 491 ms |
| `html_path` + automation | First click | 874 → 874 ms | 242 → 222 ms |
| Inline HTML | Reload | 656 → 655 ms | 279 → 293 ms |
| No artifacts | Reload | 624 → 635 ms | 264 → 261 ms |

- The artifact read in a first click went from 187 to 92 ms at 80 ms RTT.
  The rows do not show sooner, because the conversation code loads after the
  click (30 script files) and that takes longer than the reads.
- Direct reloads of the `html_path` session overlap (before 400–475 ms, after
  382–499 ms). During page start, the automation read takes longer when the
  artifact reads run beside it.
- Mobile was not measured; focused tests cover the request order.

### Found, then changed (2026-11-17)

Measured with the same fixtures and method as above, before and after in
turns, 5 opens each (median time to visible rows):

| Fixture | Open | 80 ms RTT before → after | Direct before → after |
|---|---|---|---|
| `html_path` + automation | First click | 863 → 364 ms | 206 → 166 ms |
| `html_path` + automation | Reload | 873 → 798 ms | 369 → 375 ms |
| Inline HTML | First click | 863 → 313 ms | 204 → 156 ms |
| Inline HTML | Reload | 638 → 645 ms | 276 → 270 ms |
| No artifacts | First click | 857 → 303 ms | 190 → 160 ms |
| No artifacts | Reload | 631 → 635 ms | 243 → 230 ms |

- The first click gains from the idle load of the conversation. The
  benchmark clicks after the page is idle; a click before the load ends
  still waits for the rest of it.
- On a reload of the `html_path` session at 80 ms RTT, the automation read
  went from 233 to 151 ms.
- The time until layout stops changing after a direct first click is 10–47
  ms later (for example 371 → 418 ms with no artifacts), though rows show
  30–48 ms sooner. Not explained yet.
- **The frame height wait had no effect that we can measure.** Height
  changes after a first-click reveal are the same (median 13–16 in the HTML
  fixtures, before and after). Two after-build reloads at 80 ms RTT shifted
  the rows (0.22 and 0.14), against none in 10 before-build reloads; with
  heights remembered on a reload the wait does not run, so this is the same
  rare shift as before (3 of 96 earlier), not caused by the wait. Its cause
  is still open.

- **Conversation code after the first click.** The first open in a page
  loaded `ConversationView` as 43 files, 2 import levels deep. Over plain
  HTTP a browser fetches six files at a time from one host, so 42 files cost
  about 7 round trips: at 80 ms RTT a first click showed rows at about
  870 ms, against about 200 ms direct. Now the workspace loads the
  conversation once it has painted and the browser is idle
  (`preloadConversationView`), so a click usually finds it loaded.
  Tried and removed: a manual chunk for our own conversation modules. It
  made the first open 1 file, but Rollup keeps one value the workspace
  chunk imports in a chunk named `TaskPage`, and that chunk imports the
  conversation chunk. The page start then loaded and ran 624 KB of
  conversation code before its first paint.
- **Late layout shift with inline HTML.** In 3 of 96 inline HTML opens, the
  assistant rows moved after they showed (layout shift score 0.21–0.41). A
  frame with no height remembered in this browser grew when it reported one.
  Now such a frame counts as having no height until it reports
  (`holdFrameHeight`), and `ConversationArrival` waits up to 300 ms for the
  frames in view, then settles the scroll again. A remembered height costs
  no wait. Each benchmark run used a new browser profile, so it is the worst
  case.
- **Automation reads.** A load of every host and a load of one host each
  sent their own read, so one host could be asked twice at once. Each host
  now has one read at a time, shared by every caller. The list request no
  longer waits for the host capabilities, which cost a round trip first
  (about 230 ms into page start). The Solus API holds no automations and is
  not asked. A transcript waits for the session's host only, as the artifact
  reads do: a slow host elsewhere does not hold the open.
- **Codex turn list.** A page listed every turn summary, oldest first, 200
  at a time, before it read the newest turn's items. In `dev.log` (153 page
  reads) the turn list was the larger stage: p50 96 ms, p90 271 ms, max
  908 ms, against items p50 61 ms. Now a page lists turns newest first
  (`loadCodexTurnWindow`): a first page reads `turnLimit + 1` summaries in
  one request, and an older page stops at its turn. The page token is
  unchanged. `codex_history_page_profile` now says whether the thread was
  `resumed`. Every thread in that log had 15 turns or fewer, so the gain
  there is the smaller list; long threads gain the most.

### Open order (2026-11-17)

- A sidebar click on a listed session opens from the list: it no longer
  reads `readSessionMeta` first. `resumeSession` makes the tab and starts the
  history read at once, and `describeSession` answers beside the page. The
  rows wait for the description, because it names the thread to show. When it
  names another active thread (a provider handoff), the open closes that tab
  and opens the described thread with the description it has. A session that
  is gone closes its tab and is unavailable, as before.
- When the pointer or the keyboard rests on a row for 100 ms, its first page
  is read. That read serves an open for 10 s. A running session is read at the
  click.

Measured as above, 5 opens each; "rest" clicks after the pointer rests on the
row for 300 ms (median time to visible rows):

| Fixture | Click | 80 ms RTT before → after | Direct before → after |
|---|---|---|---|
| No artifacts | Plain | 303 → 182 ms | 150 → 144 ms |
| No artifacts | After rest | 305 → 167 ms | 137 → 149 ms |
| Inline HTML | Plain | 305 → 180 ms | 158 → 172 ms |
| Inline HTML | After rest | 309 → 177 ms | 159 → 156 ms |
| `html_path` + automation | Plain | 362 → 244 ms | 171 → 165 ms |
| `html_path` + automation | After rest | 360 → 216 ms | 157 → 157 ms |

- Direct opens are about the same (within 15 ms either way).
- A rest gains less than expected (182 → 167 ms): the rows still wait for
  the description, which starts at the click.
- The `html_path` session is still above 200 ms. Its automation read
  (83 ms) and artifact reads (90 ms) start only when the page arrives, one
  more round trip. To remove it, the host can send the bodies and the
  automations the page names with the page, or the client can start those
  reads when a prefetched page arrives.

### Native mobile conversation rendering (2026-11-18)

- History rows publish before `watchSession` answers. The live subscription
  still sets the final session state, but its network wait no longer hides
  history that the host has sent.
- A conversation store combines item notifications within one display frame.
  It applies every event to the model at once. Mounted rows read the latest
  item once per frame. Order and metadata changes publish at once and cancel
  a pending frame; closing the store cancels it too. Rows with no subscribers
  schedule no frame.
- Assistant text uses the same component while streaming and after the turn
  ends. A reply without inline pull request cards keeps its native Markdown
  view when it becomes final.
- An empty feed does not mount a list before history arrives. This removes
  the empty-list mount followed by the first populated-list mount.

These changes apply to the native iOS and Android clients, for both providers
and for local-network or remote host connections. They change no RPC contract
or product capability. Desktop and web have separate renderers.

Deterministic tests cover burst notification counts, complete text, immediate
order and metadata updates, cancellation on close, and history publication
while the live watch is pending. Native frame timing and transition quality
still need a device check; no device speedup has been measured for these changes.

### Submitting a native mobile draft (2026-11-18)

T3 Code main at `9a26f217ac85cdb49b55283135625ada48187abf` uses one
Thread route for a draft and its submitted conversation. `ThreadScreenHost`
keeps the detail screen, keyboard host, and composer mounted while the route
changes controllers. Its bindings publish before paint. Solus now uses that
source pattern with its own stores and route fields.

- A project selection opens a Thread route with draft params. Existing NewTask
  commands still work; a chosen project redirects to the draft Thread.
- Send clears the draft params on that route. It does not reset the stack or
  replace the native screen. The same conversation store owns the first prompt.
- Draft hero and controls are slots in the conversation screen. The hero reserves
  the measured full composer overlay, including draft controls and task offers.
- Project and host pickers return to the draft. Changing a project uses a new
  session identity when its store must change; changing hosts keeps task links.
- The composer reads the correct saved draft when its host or draft key changes.
  Missing-host and access-error states publish through the same screen outlet.

This applies to iOS and Android, for both providers and remote hosts. Desktop
and web use separate screen navigation; there is no RPC or capability change.

Tests use the installed navigation router to verify that submission keeps every
screen key. A React mounting test swaps draft and live controllers and checks
that the editor remains the same DOM instance, then checks that an access
fallback removes the old content. The screen host, route controllers, and detail
screen compile for iOS and Android. The composer keeps its existing manual
memoization because its earlier compiler skips remain.

Native verification used a fresh iPad Pro 13-inch (M5) simulator on iOS 26.5,
an existing native development binary, and the current JavaScript sources. The
fixture held host data in memory, delayed its prompt receipt by 1.2 seconds,
and sent eight simulated text events. First-prompt submission and later typing
passed. The header and composer stayed visible; the transcript had a short
initial-layout interval during keyboard dismissal. This was a focused native
stack fixture, not a test of the full workspace sidebar. No speed comparison
with T3 was measured. A 5.5-second recording is at
`/tmp/solus-draft-transition-short.mp4` on the verification host.

### Native bottom layout follow-up (2026-11-19)

The first native recording still showed movement at the bottom. The earlier
screen-host port did not include T3's full keyboard and transcript positioning
path. The native check established that submission worked; it did not establish
that the transition was smooth.

The follow-up ports these rules from T3 main at `9a26f217ac`:

- Keep composer safe-area padding fixed during keyboard motion. Give that inset
  to KeyboardStickyView as its opened offset, so keyboard dismissal needs no
  second padding layout.
- Use measured native overlay height directly for the transcript's bottom inset.
  Settle React's composer height estimate after T3's 220 ms transition instead
  of rendering the complete screen for each intermediate height.
- Keep the first prompt anchored with LegendList's trailing space. The initial
  prompt stays in place as text arrives. Existing, queued, and offline turns do
  not acquire a new initial anchor. The anchor rules and spacing resolver are
  copied from T3's `thread-feed-scroll-position.ts` and `shared/chatList.ts`.
- Use an explicit header inset and disable UIKit's automatic content adjustment,
  as T3 does. Keep the same list data identity when the first rows arrive.
- Remove the delayed 230/260 ms scroll corrections and the outer composer layout
  animation. Native layout and list position maintenance own those movements.

The history control moved to its own component to keep ThreadFeed below 1,000
lines. Both native platforms use the same changes. Desktop and web use separate
keyboard and transcript layout code.

Focused anchor, navigation, mounting, feed, and size-estimate tests pass (35).
The mobile typecheck passes. A new recording is pending: the device-control
service stopped responding during verification. The earlier video does not
show these follow-up changes.

On iOS, the transcript applies its bottom inset and scroll offset with each
frame of the keyboard opening. The latest message moves with the composer.
When the user reads earlier messages, the inset grows and their scroll
position stays fixed.

### Native session loading and reconnect

The mobile comparison used T3 Code `0591d32888dbd2f2f25915c245e6f1fe93dc4755` and the Solus backend. A row update at the same list position keeps the other row objects. Workspace consumers such as Settings subscribe to the host and project state. The directory can reuse a complete saved list when the host confirms its revision for the current caller.

On a conversation open, the app can display the navigation prefetch, the account's saved page, or the first authorized host page while session details load. A matching page keeps the model already on screen. Claude and Codex can reuse bounded, file-validated provider pages. A changed file invalidates a saved page. On a live reconnect the host can replay the suffix after a confirmed event. A settled turn, lost cursor, or host restart uses normal history validation. The phone requests saved artifact HTML when the card needs it.

| Measured operation | Comparison | Updated Solus |
| --- | ---: | ---: |
| Apply 200 text updates to a 1,000-message conversation | T3, 9.10 ms | 0.30 ms |
| Build a conversation from 750 tool calls and their results | Solus before the tool lookup change, 79.67 ms | 6.80 ms |

Both rows show median elapsed time inside Hermes on an iPhone 17 Pro simulator, after five warm-up runs. The text test applied the same chunks to each implementation, using each host's normal message shape, and checked the final text and message count. The tool test read the same 1,500 saved rows into each version of the Solus transcript model. These intervals cover client data processing. They exclude transport and native layout.

The screen comparison used the upstream and Solus Release bundles on the same iPhone 17 Pro simulator with iOS 26.5, the same native shell, and separate local hosts. Each host had the same three conversations. Each measurement starts at the launch or navigation request and ends at the first video frame with readable list or message text. Conversation navigation used the system link to open a two-message thread in the running app. The table gives the median of three runs per case. Frames were sampled every 50 ms.

| First readable content | Phone cache | T3 Code | Solus |
| --- | --- | ---: | ---: |
| Session list after app launch | Empty | 2.03 s | 1.86 s |
| Session list after app launch | Saved | 2.03 s | 1.89 s |
| Conversation after navigation | Empty | 0.49 s | 0.49 s |
| Conversation after navigation | Saved | About 0.49 s | About 0.49 s |

The app process restarted before each list measurement. Empty-cache runs cleared the phone's saved session rows and history before launch. Pairing and host caches were retained. These measurements cover the local iOS fixture. Physical devices, Android, and wide-area connections need separate measurements.

#### After moving session navigation and feed updates onto upstream code

The same fixture and video method above gave these medians with the migrated Release bundle.

| First readable content | Phone cache | T3 Code | Updated Solus |
| --- | --- | ---: | ---: |
| Session list after app launch | Empty | 2.03 s | 1.83 s |
| Session list after app launch | Saved | 2.03 s | 1.88 s |
| Conversation after navigation | Empty | 0.49 s | 0.48 s |
| Conversation after navigation | Saved | About 0.49 s | 0.48 s |

The conversation differences are smaller than the 50 ms video sample interval. A separate check opened a session by tapping its row and verified the saved prompt and reply. Tests cover the shared navigation read, account changes, queued creations, hidden Home, multi-host reconnect, revoked rows, failed history reads, streaming, tool details, and attachments.
