# Resource utilization budget

**Status:** implemented; selected paths benchmarked on 2026-08-01  
**Scope:** Electron desktop, standalone web client, remote server, Claude, and Codex

## Objective

Solus keeps many tabs and both workspace modes mounted, so its safe steady state is
defined by bounded retention and demand-loaded expensive work rather than by relying on
garbage collection after an unbounded peak. The governing rules are:

1. A provider, model, watcher, or data surface does no work merely because its owner is
   mounted.
2. Each long-lived cache, queue, transcript window, and log buffer named in the budget
   table has a cardinality or byte limit.
3. Inactive Editor/Pill surfaces retain interaction state but release external
   subscriptions and expensive rendering work.
4. Deferred work is reported as deferred first-use cost, never as eliminated cost.

## Enforced budgets

| Resource | Budget | Owner |
|---|---:|---|
| Restored transcript window | 200 messages per provider segment until explicit expansion | Workspace history |
| Renderer run-log window | 5,000 lines per visible command | Run store |
| Backend run-log window | 20,000 lines per command | Run manager |
| WebSocket settled receipts | 100 and 16 MiB per client | WebSocket transport |
| WebSocket receipt result | 4 MiB per settled entry | WebSocket transport |
| Concurrent in-flight receipts | 64 per client; never evicted while running | WebSocket transport |
| Transport-wide settled receipts | 16 MiB across all client-instance caches | WebSocket transport |
| Transport-wide in-flight receipts | 64 across all client-instance caches | WebSocket transport |
| File-diff source cache | 8 MiB total; 512 KiB maximum entry | Diff renderer |
| PR project payload caches | 64 entries per cache | PR store |
| PR interdiff payload cache | 8 entries | PR store |
| Claude session-list cache | 64 entries | Claude history |
| Plan cache | 32 entries | Plan store |
| Navigation history stack | 50 entries, params only — never resolved payloads | Router |
| Resolved route payloads | 16 entries, LRU | Router |
| Session index read block | 256 KiB | Session indexer |
| Session index database batch | 300 records | Session indexer |
| Session index/head record | 4 MiB maximum | Session indexer/history |
| Production log entry | 64 KiB | Logger |
| Production queued log data | 1 MiB with one active write | Logger |
| Transcription concurrency | One inference and one admitted HTTP upload | Voice |
| Transcription worker idle lifetime | 2 minutes | Voice |
| Large diagram culling threshold | 150 nodes plus edges | Diagram canvas |
| Streaming transcript reveal cadence | 30 scheduled frames/second | Conversation renderer |
| Display clocks | One 1-second and one 60-second visibility-aware scheduler per renderer realm | Renderer lifecycle |
| Artifact delivery | Streamed with byte-range support; never buffered as one server `Buffer` | HTTP / desktop protocol |
| Tailscale status result | 4 MiB command-output cap; one coalesced probe per 5-second TTL | Endpoint discovery |
| Rate-limit identities | 10,000 FIFO buckets; constant-time saturated insertion | HTTP server |
| PR-check polling activity | Connected clients only; removed on disconnect and restored on reconnect | Checks handler |

## Implemented optimizations

### Startup and providers

- Codex app-server startup and Codex plan discovery are demand-loaded. The periodic
  refresh returns immediately until the client has actually started.
- Voice preparation downloads/checks model assets without loading ONNX. The utility
  process starts on inference and is terminated after the idle budget.
- Plan scans use bounded concurrency and scoped Codex thread queries instead of an
  all-project, unbounded fan-out.

### Backend and transports

- Claude transcript indexing streams 256 KiB blocks into 300-record transactions instead
  of retaining the entire unread tail and all parsed lines.
- Oversized JSONL records and session-head reads are bounded at 4 MiB.
- Production logging gates debug payloads before merge/serialization, bounds object graph
  traversal and bytes, and serializes filesystem writes.
- WebSocket receipts have timer-driven expiry, byte and count budgets, a result-size cap,
  separate never-evicted per-client admission, and transport-wide in-flight/settled-byte
  limits that arbitrary client-instance IDs or live transport rebinds cannot multiply.
  Socket.IO continues to own wire recovery; ADR-0004 records why the lost-ack idempotency
  receipt remains application policy rather than another transport framework.
- Authenticated HTTP and privileged desktop artifact responses use asynchronous stat,
  byte ranges, and `createReadStream` instead of allocating the entire file as one
  response buffer. HTTP canonicalization remains synchronous and may canonicalize the
  requested path plus configured project roots.
- Tailscale status runs asynchronously with a timeout, output cap, five-second result
  cache, and concurrent-call coalescing; public endpoint discovery no longer blocks the
  Node event loop on a child process.
- Saturated rate-limit admission evicts one FIFO bucket in constant time and keys requests
  from the socket address rather than caller-controlled forwarded headers.
- PR-check activity is owned by connected-client generations. Disconnect releases polling,
  stale in-flight activity lookups cannot resurrect it, reconnect re-reports visibility,
  and transport rebind/shutdown clears all retained activity and timers.
- Voice upload admission happens before body buffering. WAV lengths, direct PCM inputs,
  worker generations, failed kills, and audio-duration-aware timeouts are guarded.
- Attacker-controlled rate-limit key cardinality is capped.

### Renderer and GPU proxies

- Restored sessions load a 200-message window; explicit expansion reconciles handoff
  lineage and live events that arrive during the RPC.
- Hidden Editor/Pill workspaces and split panes keep state mounted but suspend transcript,
  panel, watcher, keybinding, and run-log work.
- Run logs subscribe only while a command is visible, discard late backfills after
  release, and render a 5,000-line maximum with `content-visibility`.
- Agent-conversation metadata, PR payloads, and diff-source caches named in the budget table
  are released or capped instead of growing for the renderer lifetime.
- Full Iconify collections were replaced in both production build configurations with a
  generated local subset.
- Streaming message reveal is capped at 30 frames per second and large diagrams enable
  viewport culling. Image export briefly renders the complete diagram so culling never
  omits offscreen nodes from an export.
- Twelve separate one-second display-timer implementations now share one live clock, and
  historical timestamps share one minute clock. Both stop while the document is hidden
  and release their scheduler after the final subscriber unmounts.
- The standalone connection/pairing surface no longer imports the multi-megabyte workspace
  graph. The workspace JavaScript and its component CSS are loaded after host selection.
- Replacing a primary web connection destroys the displaced transport, and generation
  guards prevent stale dynamic imports or auth callbacks from reviving an abandoned host.

## Benchmark record

### Environment

- Apple M4, 10 logical cores, 24 GiB RAM, arm64
- macOS 26.5.2
- Bun 1.3.14, Node 25.8.1, Electron 42.7.1
- Isolated temporary fixtures and data directories; no live Solus state
- Medians are used for synthetic repeated runs. Build timing is a single directional
  observation and is not a statistical claim.

### Controlled results

| Workload | Before | After | Change | Interpretation |
|---|---:|---:|---:|---|
| Standalone production debug hot path, 200 large payloads — wall | 1,131.05 ms | 0.111 ms | **-99.99%** | Packaged standalone runtime now gates debug work before payload handling. |
| Same workload — CPU | 1,238.44 ms | 0.236 ms | **-99.98%** | This is the disabled-debug path, not enabled development logging. |
| Same workload — ending RSS | ~225.5 MB | 38.08 MB | **≈-83.1%** | Applies only to this disabled-debug fixture. The 64 KiB entry and 1 MiB queue are configured bounds, not a slow-storage benchmark. |
| 52.99 MB session tail — CPU | 303.01 ms | 295.67 ms | **-2.42% observed median** | Streaming performs the same parse/index work in bounded batches; the small CPU delta is inconclusive. |
| 52.99 MB session tail — ending RSS | 269.63 MB | 148.80 MB | **-44.81%** | Lower ending process RSS in this fixture; peak RSS was not measured. |
| 52.99 MB session tail — wall | 406.09 ms | 417.63 ms | **+2.84% observed median** | Distributions overlap; the latency delta is inconclusive. |
| 80-file synthetic plan scan — CPU | 149.08 ms | 138.01 ms | **-7.43% directional** | Six-way bounded concurrency. |
| 80-file synthetic plan scan — ending RSS | 154.63 MB | 86.46 MB | **-44.09% directional** | The corpus is a benchmark fixture, not an 80-file product cap. |
| 80-file synthetic plan scan — wall | 95.38 ms | 91.65 ms | **-3.91% directional** | Wall speedup is secondary to bounded fan-out and RSS. |
| Electron selected diagram/icon vendor/subset chunks — raw | 12,690,858 B | 561,288 B | **-95.58%** | Captured emitted production chunks, same raw-size scope. |
| Electron selected diagram/icon vendor/subset chunks — Brotli | 4,465,772 B | 121,543 B | **-97.28%** | Deterministic artifact size. |
| Standalone client icon JavaScript — raw | 12,229,197 B | 119,390 B | **-99.02%** | Captured emitted production chunks. |
| Standalone client icon JavaScript — Brotli | 4,370,762 B | 42,110 B | **-99.04%** | Deterministic artifact size. |
| Unpaired standalone initial JavaScript — raw | 3,785,410 B | 1,104,680 B | **-70.82%** | Workspace code is deferred, not eliminated; connecting loads the App chunk. |
| Unpaired standalone initial JavaScript — gzip | 1,064,272 B | 258,908 B | **-75.67%** | Captured initial entry chunk before and after the lazy boundary. |
| Unpaired standalone initial CSS — gzip | 76,443 B | 54,579 B | **-28.60%** | App component CSS is deferred; global renderer CSS remains initial. |
| Saturated rate limiter, 1,000 new identities — wall | 311.39 ms | 0.283 ms | **-99.91%** | Five-run synthetic median at the 10,000-bucket cap; isolates the removed full-Map scan. |
| Same saturated limiter — CPU | 315.60 ms | 0.396 ms | **-99.87%** | Synthetic denial-path benchmark, not ordinary request latency. |

Artifact streaming is recorded as an asymptotic behavior change—whole-file response
allocation to a backpressured stream—not as a production CPU/RAM percentage. A separate
discard-sink diagnostic confirmed the expected memory-shape difference, but it is not an
HTTP/Electron route benchmark and is therefore excluded from the reduction table.

### Deferred idle cost

| Expensive operation | Measured component/first-use cost | Configured idle behavior | Scope |
|---|---:|---:|---|
| Codex app-server initialization | 648.9 ms median; ~133.7 MiB process tree | **0 until first Codex use** | Cost moves to the first Codex operation. |
| Three ONNX sessions | 752 ms wall; 831 ms CPU; ~1.93 GB worker RSS | **0 ONNX RSS until first transcription** | Model asset download/check remains asynchronous at startup. |
| One-second first transcription | 772 ms wall; 1,038 ms CPU; ~1.94 GB worker RSS | Worker exits after 2 minutes idle | Native allocator reclamation is guaranteed by process exit. |

### Directional build observation

The final production build completed successfully. The build measurements remain a
directional engineering check rather than a runtime benchmark: caches were not alternated,
and maximum RSS varied enough that no build-memory reduction is claimed. The final values
after the last source edit were 28.38 seconds wall, 55.02 user CPU seconds, 3.24 system CPU
seconds, and 4.057 GB command maxRSS, versus 30.03, 61.66, 3.46, and 4.048 GB in the baseline.
Those are observed one-run deltas of -5.49% wall, -10.77% user CPU, -6.36% system CPU,
and +0.24% command maxRSS. The RSS delta is below run-to-run noise and is explicitly
inconclusive; it is not whole-app runtime memory or a controlled descendant-process peak.

Raw repeated measurements retained from this pass:

- Logger before wall: `1117.37, 1099.85, 1131.05, 1174.79, 1182.60 ms`
- Logger before CPU: `1238.44, 1237.44, 1246.40, 1228.85, 1301.36 ms`
- Logger after wall: `0.126375, 0.111917, 0.107709, 0.110375, 0.110625 ms`
- Logger after CPU: `0.276, 0.236, 0.234, 0.230, 0.246 ms`
- Session index before wall: `421.554, 406.089, 391.302 ms`
- Session index after wall: `417.626, 400.908, 417.929, 427.207, 408.492 ms`
- Session index before RSS: `284475392, 269631488, 267452416 bytes`
- Session index after RSS: `147947520, 150306816, 148799488, 147685376, 149667840 bytes`
- Final build observations (wall/user/system/RSS):
  `28.44/55.19/3.33/4090298368`, `29.01/57.00/3.19/4074569728`,
  `28.26/55.26/3.05/4035510272`, `28.32/54.92/3.26/4035756032`,
  `28.38/55.02/3.24/4057300992`
- Saturated limiter before wall: `318.472, 311.394, 310.162, 310.997, 312.125 ms`
- Saturated limiter after wall: `0.283, 0.222, 0.202, 0.332, 0.336 ms`
- Saturated limiter before CPU: `323.967, 315.032, 313.508, 315.604, 315.811 ms`
- Saturated limiter after CPU: `0.402, 0.223, 0.396, 0.333, 0.468 ms`

## Verification and observability

Focused tests cover cache eviction, receipt expiry/admission, voice allocation and worker
lifecycle, logger retention, run-log release, history reconciliation, icon completeness,
session-index streaming, shared-clock suspension, artifact ranges, primary-transport
ownership, agent-watch cleanup, and transport reconnect semantics. The production build
covers both Electron and the standalone client.

GPU usage was not assigned a runtime percentage in this pass. Starting or controlling a
live app without an explicit isolated run would violate Solus development safety. Bundle
size, scheduled-frame ceiling, hidden-surface suspension, row containment, and diagram
culling are therefore recorded as GPU/renderer proxies. A future isolated production run
should sample Electron `app.getAppMetrics()`, renderer `process.getProcessMemoryInfo()`, and
the Chrome DevTools Protocol Performance domain under fixed Editor/Pill scenarios. Those
remain renderer/GPU-process proxies; actual GPU-engine utilization requires Chromium
GPU tracing/Perfetto or OS instrumentation such as Instruments/Metal System Trace.

Primary-source research informed the infrastructure pass: Electron recommends deferring
expensive module and process startup and exposes per-process metrics; Chrome documents
hidden-page lifecycle and timer throttling; Socket.IO documents per-client memory drivers
and native WebSocket-engine trade-offs; ONNX Runtime documents the latency/energy
consequences of intra/inter-op thread pools. These sources support the chosen demand-load,
visibility suspension, transport bounds, and measure-before-changing-thread-count rules:

- https://www.electronjs.org/docs/latest/tutorial/performance
- https://www.electronjs.org/docs/latest/api/app
- https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- https://socket.io/docs/v4/memory-usage/
- https://socket.io/docs/v4/performance-tuning/
- https://onnxruntime.ai/docs/performance/tune-performance/threading.html

## Remaining measured trade-offs

- A first Codex action now pays the deferred app-server initialization cost.
- A first transcription pays ONNX initialization, and one active inference can still use
  approximately four cores and 1.9 GB in the isolated worker. Lower thread counts require
  an energy/latency benchmark; fewer cores are not automatically fewer CPU-seconds.
- The voice model asset check/download remains asynchronous at startup because the current
  microphone UX assumes a ready/downloading state. Making the download first-click-only
  requires an explicit product decision and a visible install action.
- The session-index fixture showed +2.84% median wall time and -44.81% ending process RSS;
  the latency delta is inconclusive and peak RSS was not measured.
- Artifact routes choose bounded response allocation and backpressure over whole-file
  buffering. No route-level CPU/RAM percentage is claimed.
- The unpaired web-client reduction is first-load deferral. A connected workspace still
  downloads the deferred `2,679,409 B` App JavaScript and `140,752 B` App CSS chunks, so it
  is not reported as total-byte elimination. Saved-host autoconnect loads App immediately,
  while pairing preloads it during the pairing request.
