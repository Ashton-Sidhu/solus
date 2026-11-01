# Fresh-login backend benchmark

Run the current implementation from the solus-cloud checkout:

```sh
SOLUS_STARTUP_BENCHMARK=1 SOLUS_STARTUP_BENCHMARK_OUTPUT=/tmp/solus-login.json bunx vitest run --project server src/lib/server/auth/sign-in-clients.test.ts -t 'benchmarks token'
```

The committed JSON contains the before/after samples captured during implementation. It is a fixture benchmark, not a production Google-login or browser-paint benchmark. Each sample creates a new client grant. The existing website session represents the point after Google authentication. Database delay is injected after each query; overlapping requests retain their overlap. The timer starts after authorization and ends when account/settings data is available. In `startup-bootstrap`, that data arrives in the token response, with no follow-up reads. Periodic refresh is measured separately. No database delay is injected into code authorization; resource-cache work at that stage is outside the measured interval. Compare warm-server samples for stable query counts.

The `after` stage ran while focused tests were also active; its no-delay CPU measurements are noisy. The final network-delay reductions follow fewer sequential database waits. Five samples per case do not establish production percentiles.

The `startup-bootstrap` samples were run without concurrent test workers. The preceding implementation used six calls and three sequential waits; the login payload uses two calls and two sequential waits. Settings are empty in this fixture; a separate correctness test checks a stored settings document and its revision.

The [Safari recheck](fresh-login-safari-2026-10-30.json) records two fresh Google client logins against app.solus.sh and a repeat of the fixture benchmark. Browser times start at workspace navigation after Google and measure first contentful paint, not complete workspace readiness. The live code exchange reported four SQL calls, while the warm fixture still used two; the extra live calls were not attributed in this check. No separate account or settings requests occurred. Raw HAR data remains outside the repository; the report contains timing data only.

The [host-token benchmark](host-token-exchange-2026-10-30.json) measures the next local changes: five reads, three joined reads, then one snapshot. Run it from solus-cloud with `SOLUS_HOST_BENCHMARK=1 SOLUS_HOST_BENCHMARK_OUTPUT=/tmp/solus-host.json bunx vitest run --project server src/lib/server/auth/sign-in-clients.test.ts -t 'benchmarks host'`. The production auth proxy's callable pool identity caused repeated signing-key reads; its fix has a regression test, but the live query counts still need a post-deploy check.

The [post-deploy Safari recheck](fresh-login-safari-post-deploy-2026-10-30.json) confirms two live code-exchange queries and one query per host exchange. First contentful paint was 3.084 and 3.633 seconds from workspace navigation after Google, with 1.292 and 1.670 seconds between the startup response and first paint. These observations do not show a paint-time improvement. The report separates navigation, API and paint timing and records the measurement limits.

# Web client load on a shaped network

`node scripts/bench-web-load.ts label=<vite build dir> ...` serves one or more `vite build` outputs of `apps/client` the way the CDN does (HTTP/2 over TLS, Brotli) and shapes every response itself, so Chromium and WebKit see the same network. `--profile slow` is 300 ms per round trip and 1.5 Mbit/s with the CPU four times slower (Chromium only); `--profile fast` is 40 ms and 20 Mbit/s. Each run is a fresh browser context. The timer ends at the `solus:workspace-code` mark, which `apps/client/src/main.ts` sets when the workspace code has downloaded and run. It measures code loading only, with no sign-in and no host.

The [results](web-load-2026-10-30.json) measure each change against the one before it:

| Step | Slow, Chromium | Slow, WebKit | Fast, Chromium | Fast, WebKit | Brotli KB |
|---|---:|---:|---:|---:|---:|
| Baseline | 8.44 s | 7.90 s | 0.80 s | 0.82 s | 1223 |
| Static preloads of the startup graph | 7.25 s | 7.24 s | 0.61 s | 0.67 s | 1223 |
| Artifact shell and save picker on demand | 6.60 s | 6.57 s | 0.56 s | 0.62 s | 1099 |
| Composer Markdown without lang-html | 6.18 s | 6.17 s | 0.52 s | 0.57 s | 1026 |
| Ed25519 verifier on demand | 6.10 s | 6.11 s | 0.52 s | 0.57 s | 1013 |
| Palette commands load with the palette; four stores out of the contexts barrel | 6.07 s | 6.14 s | 0.52 s | 0.56 s | 1002 |

On the slow profile the bytes set most of the time: 1 MB at 1.5 Mbit/s is about 5.4 s. The static preloads remove the round trip per import level; the browser otherwise finds App's chunks four levels deep. The preload block sits between `<!--solus:workspace-preloads-->` markers, and Solus Cloud's `serveClientShell` drops it on share links, which resolve before any app code loads (docs/plans/instant-share-open.md).

`--profile local` removes the network (no round-trip delay, unlimited bandwidth, full CPU), which approximates the desktop renderer loading its files from disk. The desktop renderer keeps Vite's runtime preloads, which already avoid the import-level waterfall, so the list in the HTML only starts the fetches earlier. Measured on web builds configured like desktop (runtime preloads on), Chromium went from 181 ms to 159 ms (−12%) with the list. `scripts/vite-workspace-preloads.ts` is shared by `apps/client/vite.config.ts` and the renderer in `electron.vite.config.ts`.

The last row is within run-to-run noise in WebKit (6.11 s against 6.14 s). It removed only 11 KB: most of the startup code now belongs to the workspace core (sessions, transcript, composer, sidebar) and to the libraries it needs, not to feature stores. Locally (`--profile local`) Chromium went from 175 ms to 170 ms and WebKit from 232 ms to 218 ms.

## A small first-screen core (fast-secure-startup step 4)

The [results](first-screen-core-2026-10-31.json) compare three builds in one session per profile (7 runs, medians). Startup JavaScript is the entry, the App chunk, and their static imports.

| Build | Chunks | Raw | Gzip | Slow, Chromium | Slow, WebKit | Fast, Chromium | Fast, WebKit | Local, Chromium | Local, WebKit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Before | 136 | 3.13 MB | 1.00 MB | 6.07 s | 6.07 s | 514 ms | 565 ms | 155 ms | 213 ms |
| Code cuts | 120 | 2.38 MB | 0.76 MB | 4.82 s | 4.81 s | 419 ms | 452 ms | 136 ms | 161 ms |
| Code cuts and one startup chunk (web) | 66 | 2.36 MB | 0.72 MB | 4.56 s | 4.50 s | 407 ms | 430 ms | 148 ms | 131 ms |

The largest cut is the prompt editor: CodeMirror, its Markdown, and the autocomplete menus were about a third of the startup code. `DeferredPromptEditor` starts to load it with the workspace and shows a plain field until it runs; the field takes text, Enter, paste, and focus, and hands the draft and the focus to the editor. The other cuts load on first use (menus, dialogs, the work pane, the companion strip, the host-connect page, the hostless page), at the first device event (`device-feature.ts`), or after the first paint (the MCP sign-ins in `app-core.ts`). Each such store reads every connected host in full when it loads.

`workspaceStartupChunk` puts our own startup modules in one chunk; package code keeps Rollup's chunks, because a walk through a package barrel would claim modules that only later surfaces use. WebKit gains the most (local 161 ms to 131 ms). Chromium is 12 ms slower locally with one large chunk, so the desktop renderer, which is Chromium and loads from disk, keeps Rollup's chunks.

The 400–600 KB target is not met. What remains is mostly the libraries the shell draws with (bits-ui, svelte, zod, tailwind-merge and tailwind-variants, lucide, paneforge, svelte-sonner, socket.io) and the workspace core (`WorkspaceContext`, the sidebar, the composer's chips). The tasks store (about 18 KB of output) and the pull request stores (about 55 KB) stay in the core: the sidebar reads both synchronously, and the gain does not pay for 35 changed call sites. `tests/unit/startup-import-graph.test.ts` holds the line: the deferred modules and packages, and a source budget per client.

## The empty workspace in the HTML (fast-secure-startup step 5)

The [results](web-first-screen-2026-10-31.json) compare the branch before and after step 5, 7 runs each, medians. `scripts/bench-web-load.ts` now also records first contentful paint (FCP) in the same run as the `solus:workspace-code` mark. The bench has no host, so both builds end on the hostless page; before step 5 that page, drawn after the workspace code, is the first content.

| Profile | Engine | FCP before | FCP after | Code mark before | Code mark after |
|---|---|---:|---:|---:|---:|
| Slow | Chromium | 5352 ms | 1088 ms | 4471 ms | 4487 ms |
| Slow | WebKit | 5056 ms | 4412 ms | 4417 ms | 4437 ms |
| Fast | Chromium | 496 ms | 224 ms | 402 ms | 400 ms |
| Fast | WebKit | 490 ms | 400 ms | 421 ms | 425 ms |
| Local | Chromium | 176 ms | 124 ms | 146 ms | 148 ms |
| Local | WebKit | 183 ms | 183 ms | 129 ms | 130 ms |

Chromium paints the frame when the HTML and the entry CSS (545 KB raw, render-blocking) are in. The code mark does not move: the frame adds 8.6 KB of HTML and no script.

WebKit paints a page only when it is "visually non-empty": more than 200 characters of text, or more than 1024 px² of inline SVG, or no script, style, or font load pending. The frame has about 100 characters and one 12 px icon, and the startup preloads in the HTML stay pending until about the code mark, so WebKit paints the frame just before the code runs. With every script held for 1 s, WebKit painted the frame as built at 11.1 s, without the preload block at 1.04 s, and with a 40 × 40 inline SVG or 300 more characters at 0.12 s. Safari gets the gain only when the first screen passes that gate; what the first screen shows to pass it is a product decision (`docs/plans/fast-secure-startup.md`, step 5).

## The boot splash on the web (fast-secure-startup step 5, revised)

The [results](web-boot-splash-2026-10-31.json) compare the branch before and after the change, 5 runs each, medians. Before: the empty workspace in the HTML and a render-blocking entry stylesheet. After: the desktop's boot splash in the HTML (inline styles), and the entry stylesheet as a preload that becomes a stylesheet when it arrives. Each surface mounts only after the stylesheet applies. "CSS" is when the HTML's stylesheet has arrived.

| Profile | Engine | FCP before | FCP after | CSS before | CSS after | Code mark before | Code mark after |
|---|---|---:|---:|---:|---:|---:|---:|
| Slow | Chromium | 1100 ms | 352 ms | 4373 ms | 4360 ms | 4483 ms | 4476 ms |
| Slow | WebKit | 4412 ms | 336 ms | 4377 ms | 4364 ms | 4434 ms | 4421 ms |
| Fast | Chromium | 224 ms | 56 ms | 372 ms | 373 ms | 399 ms | 400 ms |
| Fast | WebKit | 400 ms | 55 ms | 371 ms | 371 ms | 426 ms | 420 ms |

Both engines now paint the splash when the HTML arrives: the 84 px mark is more than 1024 px² of inline SVG, so WebKit takes the page as "visually non-empty", and no stylesheet holds the paint. The stylesheet's arrival and the code mark do not move, so the first surface mounts when it did before. The bench server sends its responses first in, first out, with no HTTP/2 priorities. A CDN that honours priorities can send the stylesheet (a preload, high priority) before the low-priority startup preloads, and the bench cannot show that gain.
