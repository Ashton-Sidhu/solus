# Session search replacement and benchmark

Measured on 2026-10-26, on Apple M4 with 24 GiB RAM and Bun 1.3.14.
The checkout started from `1eaf53d9cc8b1df951f19b51f6e444ff8eacc0ba` with other work in progress.
The before measurements were taken from the working code before this change.
They are not the older `picker-search-baseline*.json` results.

The replacement improves the new regression cases from **3/11 to 11/11 correct first results**.
The existing picker corpus stays at **19/19**. Most search times are close to
before. This is a relevance and consistency improvement, not a general speedup.
The largest measured cost is the rare `pelican` query on the large corpus:
33.66 to 46.96 ms, a 39.5% increase. Names-only search adds about 9%.

## What changed

- One matcher owns session normalization, name quality, score tiers and message targets.
  It supports coding boundaries, accents, word prefixes, exact numeric tokens,
  joined names and a conservative second pass for name typos.
- Hosts and both service engines apply the shared scores before paging.
  Names are no longer tied by a single bonus. Message ranking no longer uses
  corpus frequency, so narrowing a scope cannot make a phrase bonus negative.
  Visibility is applied before the page and its total.
- The host retains encoded message positions and indexed retrieval. SQLite service
  substring scans are replaced by normalized FTS5. Postgres uses `simple` tokens
  instead of English stemming. Tool output and provider-child messages are excluded.
- Search hits state which field matched. They carry a provider thread/message
  reference plus text/time for histories without message IDs. A preview resolves
  the target again after positions change. Mirrored previews need no live runner.
- Desktop/web and native Home/tablet sidebar share a paged client controller.
  Local names appear at once. Fast hosts display without waiting for slow hosts.
  Later replies append; stale replies are ignored; failures stay visible.
  Native search now reads full message history and exposes paging and message jumps.
- Search rebuilds derived indexes from stored messages. Original messages remain.
  No separate legacy matching path is retained.

The ranking tiers are exact ID, title, branch/PR, message phrase, all words in
one message, and words across messages. Match quality or saturating counts order
results inside a tier; activity breaks ties. Fine word distance within one
message is not a separate tier. Pick history and a trigram index remain deferred.

## Matched timing runs

`picker-search.ts` seeds the same corpus with seed 42 for both versions:
67,547 messages at scale 1 and 672,274 at scale 10. Both runs keep 1,260 client
tasks. Each host timing is the median of 15 runs after 3 warm-ups. Each typed
prefix uses 25 client list runs after 5 warm-ups; “worst” is the slowest prefix's
median, not a latency percentile. Final after runs were sequential, with no
other tests or typechecks started by this session during the timed work.
Other work on this shared machine was not controlled.

All values below are milliseconds. Small differences can be timing noise.

| Operation | Before, 67k | After, 67k | Before, 672k | After, 672k |
|---|---:|---:|---:|---:|
| "the" | 16.52 | 16.52 | 181.21 | 181.41 |
| "session" | 8.58 | 8.95 | 94.04 | 95.03 |
| "sess" | 8.42 | 8.93 | 95.11 | 96.16 |
| "websocket reconnect" | 8.62 | 8.92 | 90.72 | 92.42 |
| "fix sidebar scroll" | 9.49 | 9.84 | 102.05 | 108.00 |
| "pelican" | 4.56 | 4.51 | 33.66 | 46.96 |
| "the" in one project | 15.55 | 15.75 | 183.75 | 184.37 |
| "sess" in one project | 8.62 | 9.17 | 97.64 | 99.50 |
| "websocket reconnect" in one project | 8.53 | 9.17 | 91.76 | 95.09 |
| "sess", names only | 4.30 | 4.69 | 42.86 | 46.61 |
| "the", second page | 15.89 | 16.03 | 181.58 | 184.74 |
| Client list: per keystroke, mean | 2.03 | 2.19 | 2.04 | 2.25 |
| Client list: per keystroke, worst | 3.22 | 3.24 | 3.26 | 3.22 |
| client list build, no query | 0.49 | 0.47 | 0.48 | 0.51 |

The common-word scan remains proportional to its postings. A second page runs
the match again. The large-corpus rare-query regression shows that scanning
session candidates and the richer matcher still have a cost when few messages
match. A second pass for typos also has a cost when the first pass has no result.
A repeated lineage read found during measurement was removed before these final runs.

The existing corpus has hit@1, hit@3 and MRR of 1.00 before and after at both
scales. It already passed the old title-order cases when this work began;
those results cannot be counted as a new quality gain.

## Additional regression corpus

`session-search-quality.ts` uses 2,053 sessions and 60,055 messages. It includes
coding names, accents, a typo, an old exact title behind 35 newer matches,
scoped phrase ranking, words across messages and old history. It uses 3 warm-ups
and 15 samples per case. This corpus targets known failure modes; it is not a
held-out estimate of search quality on real conversations.

| Query | Before rank | After rank | Before median ms | After median ms |
|---|---:|---:|---:|---:|
| `connections` | missing | 1 | 9.71 | 7.91 |
| `schema` | missing | 1 | 9.51 | 7.59 |
| `cafe` | missing | 1 | 10.77 | 7.29 |
| `keybindngs` | missing | 1 | 9.45 | 7.64 |
| `vscode` | missing | 1 | 9.59 | 7.27 |
| `reconnect websocket` | 1 | 1 | 9.88 | 7.62 |
| `tab` | missing | 1 | 0.38 | 0.33 |
| `websocket reconnect` | 2 | 1 | 10.71 | 10.01 |
| `lighthouse header` | 1 | 1 | 10.09 | 7.59 |
| `connections store` | missing | 1 | 9.97 | 7.56 |
| `pelican migration` | 1 | 1 | 10.07 | 7.41 |

Hit@1 improves from 0.273 to 1.000. MRR improves from 0.318 to 1.000.
The before report's message-count header was corrected from a hard-coded 60,059
to the actual 60,055. Its recorded ranks and timings were not changed.

## Verification and limits

15 focused test files pass on SQLite: host search and index refresh/reader,
service search, shared matching, client search, picker relevance/rows/selection,
message navigation, highlights, API mode, mirror sinks, native feed and native
search scope/ranking. Tests cover index replacement/deletion/rebuild, portable
previews after positions change, organization isolation, visibility before
paging, late host failures and stalled history reads.

Contracts and mobile typechecks pass. The new search modules pass targeted
lint. The three changed picker/conversation Svelte components compile; the row
has an existing accessibility warning. Broader server, client-core and workspace
checks still report unrelated errors, including native bridge globals,
`session-indexer` lifecycle/delegation types and conversation/code-intelligence
utilities. Existing complexity warnings remain in `session-indexer.indexFile`
and `ThreadNavigationSidebarPane`.

Desktop and web share the changed Svelte code and existing typed RPC. Mobile has
its own UI for Home and the tablet sidebar. Claude and Codex use the same
provider-neutral indexed-message path. No new transport method is required;
the existing search and message-window contracts carry the new fields.

No interactive desktop, browser or device verification was run. No dev server
or app build was started. Postgres SQL and migrations are implemented but were
not executed: this environment has no configured disposable Postgres server.
Network latency, cold reads, index write cost, database size and memory use are
not measured here. Timing numbers cover direct host search and client list
construction, not the complete RPC or UI path. The benchmark's existing async
record writer logs a closed-database warning after results are recorded during
fixture teardown; this occurs outside the timed queries.

Large touched files remain flagged for review: `session-indexer.ts` (980 lines),
`ConversationView.svelte` (993), `ThreadFeed.tsx` (973) and
`ThreadNavigationSidebar.tsx` (860). The extracted reader, window and message-row
modules keep each below 1,000 lines without changing adjacent behavior.

## Reproduce

Run on the desired source version. Every command creates disposable fixture
data and removes it afterward. Record a before version before replacing it.
Do not run the timing commands concurrently with other verification.

```sh
bun tests/benchmarks/picker-search.ts --record-baseline --baseline tests/benchmarks/session-search-before.json --output /tmp/search-before.json
bun tests/benchmarks/picker-search.ts --scale 10 --record-baseline --baseline tests/benchmarks/session-search-before-x10.json --output /tmp/search-before-x10.json
bun tests/benchmarks/session-search-quality.ts --output tests/benchmarks/session-search-quality-before.json

# After the change:
bun tests/benchmarks/picker-search.ts --baseline tests/benchmarks/session-search-before.json --output tests/benchmarks/session-search-after.json
bun tests/benchmarks/picker-search.ts --scale 10 --baseline tests/benchmarks/session-search-before-x10.json --output tests/benchmarks/session-search-after-x10.json
bun tests/benchmarks/session-search-quality.ts --output tests/benchmarks/session-search-quality-after.json

bun scripts/test-unit.ts session-search-index session-search-service session-search-matching conversation-search picker-relevance unified-picker-rows picker-selection search-message-navigation search-highlight api-mode mirror-sinks native-mobile-thread-feed native-mobile-session-search session-index-reader session-index-refresh
```

Raw results: [before](../../tests/benchmarks/session-search-before.json),
[after](../../tests/benchmarks/session-search-after.json),
[before ×10](../../tests/benchmarks/session-search-before-x10.json),
[after ×10](../../tests/benchmarks/session-search-after-x10.json),
[quality before](../../tests/benchmarks/session-search-quality-before.json),
[quality after](../../tests/benchmarks/session-search-quality-after.json).
