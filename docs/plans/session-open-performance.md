# Session open performance

Status: steps 1–7 implemented, and the turn image gallery mounts its carousel
only when a turn has an image. Clean A/B on 2026-10-15: the same tree built
twice, with and without steps 1–7 (`session-open-ab-a*.json`,
`session-open-ab-b*.json`). The server goal is met; the client goal is not.

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

Round C (`session-open-ab-c*.json`) tried the three fixes above:

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

Round D (`session-open-ab-d*.json`) measures the corrections. Median, A → D:

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
built for production (`session-open-prod*.json`), median:

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

Round E (`session-open-prod2*.json`, production build) adds: the composer
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

Round F (`session-open-prod3*.json`) adds: a view that opens at the end
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

Round G (`session-open-prod4*.json`) keeps the newest render's HTML in the
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

- Codex pages: read turns with bounded concurrency instead of one at a time.
  First add a Codex fixture, or the benchmark cannot see the change.
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
