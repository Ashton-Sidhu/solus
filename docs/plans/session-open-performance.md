# Session opening: deferred turn contents

Opening a session for the first time used to mount the contents of every
collapsed turn in the transcript window. `display: none` prevented paint, but
Markdown parsing and component creation still blocked the renderer.

`ConversationView` now uses `TurnBody` to mount those contents when the turn
first becomes visible. Live turns and expanded failed turns mount immediately.
After a body has been shown, it stays mounted when folded, so its local state
survives. The summary row, final answer, and resources shown outside the fold
keep their existing behavior. Find already expands a matching turn before it
looks for the message in the DOM.

This is shared by desktop, web, mobile, Editor, and Pill. It does not change
provider history, RPC, session ownership, or reconnection.

## Measurements

Measured on 2026-09-07. The task contains the initial baseline and each result.
The isolated browser fixture has 100 synthetic messages in 20 settled turns.
It compiles the actual conversation turn loop and uses the real Markdown and
activity components. Each comparison uses two warmups and ten fresh mounts.

The initial comparison reduced synchronous mount time from about 139 ms to
84 ms. A final paired check at 1280×800 gave:

| Metric | Eager contents | Deferred contents |
| --- | ---: | ---: |
| Median synchronous mount | 173.15 ms | 83.10 ms |
| Median mount to next animation frame | 188.20 ms | 97.65 ms |
| DOM elements | 4,221 | 2,161 |
| Visible text characters | 33,411 | 33,411 |

The final medians average the middle two samples. The first benchmark version
reported the upper middle sample. Timing varies with host load; the element
reduction is deterministic. Neither measurement includes host traffic, input
chrome, rich work cards, or total click-to-session latency. The next animation
frame is a scheduling measure, not proof of presentation on the display.

Existing host logs contained 26 history-load pairs: median 23.5 ms, maximum
84 ms. These were read only and were not used as fixture data.

## Reproduce

Run `bun scripts/measure-session-open.ts --eager` to build the old mount policy,
then run without `--eager` to build the current policy. Each writes
`.tmp/session-open-benchmark/entry.js`. Load each bundle into an owned browser
page and await `sessionOpenBenchmark()` to obtain all samples. No server is
started and no session data is read or changed by the benchmark.

The lifecycle test compiles the production `TurnBody` and verifies deferred
mounting, immediate live mounting, retained DOM identity and draft state after
folding, and teardown. Existing turn, search, transcript, and pagination tests
cover the surrounding behavior.

Browser measurements covered a desktop viewport and iPhone 15 emulation.
Native desktop/Pill interaction and physical mobile hardware were not exercised.

## RPC scheduling for restored tabs

Restored-tab status reads use the existing `readSessionMeta` batcher. Reads in
the same microtask share a `getSessionInfos` call per host. Status is still
checked for every saved session, and a busy session still starts hydration.

A cold restored tab starts `loadSession` alongside `resolveSessionLineage`.
The history RPC already resolves a saved provider id to the complete session on
the host. Conversion waits for the lineage result and uses its stable identity
for cards and deferred inputs, then consumes the early history response without
a second read. Live watch attachment remains after transcript application so
replayed events cannot be overwritten by durable history. An early read failure
is observed while lineage is pending and still rejects hydration for retry.

`bun scripts/measure-session-open-rpc.ts` executes the production restore
commands with gated mock RPCs. Twenty tabs across two hosts used 20 individual
metadata RPCs before the change and two batched RPCs after it. The transcript
previously waited for two sequential RPC stages (lineage, then history); it now
waits for one parallel stage. Watch follows that stage in both versions. These
are request counts and dependency measurements, not network latency estimates.
The shared restore path applies to desktop, web and mobile. Opening a saved
session through the picker uses a separate description path; these scheduling
changes concern restored tabs selected for the first time.

## Mobile tool details

On mobile, tapping a collapsed tool summary loads its detailed tool inputs.
Initial history keeps tool names, status, counts and timing, with a content key
in place of each deferred input. Expanding a turn requests its tools; expanding
a tool group also supports this path. Loaded inputs stay on the existing
messages, so reopening does not request them again. Concurrent expansions share
requests. Failed or missing reads show a retry action, and a late response cannot
replace newer live input or a changed history reference.

Desktop keeps full inputs on initial load. Visible resource cards, subagents,
running tools and failed tools retain their inputs on all clients. Automatic
older-history paging still works on mobile, with the existing touch button as
another entry point. An earlier tap-only paging change was removed after the
product clarification; paging was not the intended fetch boundary.

The shared `loadSession` option and `loadSessionToolInputs` RPC serve both
providers and transports. Requests keep the source host, session and provider
and are bounded to 200 input keys. Keys include input content, so changed history
cannot return another tool's input. The host still reads provider history to
construct summaries and rereads it to resolve requested keys; this change reduces
client transfer and parsing, not provider history reads.

Run `bun scripts/measure-session-tool-inputs.ts` for the production wire fixture:
200 settled tools with 8 KB inputs. Initial transfer falls from 1,625,871 bytes
to 34,381 bytes (97.9% less). Opening a ten-tool summary returns 81,131 bytes for
those ten inputs. These are synthetic payload measurements, not latency estimates.
An iPhone 15 browser fixture using the production summary handler and store
confirmed zero requests before tapping, one on expansion, and still one after
closing and reopening. The task contains the capture. Physical mobile hardware
and a full remote session flow were not exercised.

## Codex history

Codex can return saved turns with `itemsView: summary` or `notLoaded`. These
payloads omit tool calls. The history loader now requests the missing items via
`thread/items/list`, newest first, until it has the requested message window.
It preserves chronological order, failure state, and turn completion timing.
Full and legacy turn payloads need no extra request. Picker previews continue
to use summaries so they do not load hidden tool history.

The regression fixture restored zero of two tools before the fix and both after.
A 100-turn fixture reads one 200-item page for the first-open window, with no
reads of older turns. Pagination errors remain errors; a repeated cursor cannot
cause an unbounded loop. Protocol shapes were checked against the installed
Codex CLI's experimental JSON schema; generated repository files were not edited.
