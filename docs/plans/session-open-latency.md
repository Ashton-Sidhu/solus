# Session open latency (host side)

Goal: the mobile app opens a session in about 100 ms (it was about 250 ms).
The provider transcript (the Claude JSONL file, the Codex app server) stays
the source of truth. The host does not keep a durable read model.

## Where a cold read spends its time

`session_history_response_profile` gives one field for each step of a page read:

| Field | Step |
| --- | --- |
| `historyMs` | All of the history read (the sum of the steps below and the fork check). |
| `lineageMs` | Find the lineage of the session. |
| `providerMs` | Read and parse the provider page. |
| `sendersMs` | Read the prompt senders from the activity table. |
| `activityReadMs` | Read the activity of the session for this caller. |
| `blockCheckMs` | Make the source key and check the known blocks. |
| `promptImagesMs` | Store inline prompt images as assets. |
| `projectionMs` | Project the rows for the wire. |
| `activityMergeMs` | Merge the activity into the rows. |
| `preparationMs` | Exchange progress, deferred inputs, layouts, turn items, blocks. |

`claude_history_page_profile` divides `providerMs` for Claude: `locateMs` (find
the file), `revisionMs` (`stat`), and `cache` (`hit`, `miss`, or `off`).
`codex_history_page_profile` gives the Codex stages and `cacheHit`.

Measured on 10 copied Claude transcripts (1 MB to 57 MB), a 5-turn first page:
the provider read and parse is 5–44 ms, and is more than 90% of the read. It
reads 1–16 MB from the end of the file, and `JSON.parse` of the user lines
(tool results) is most of that time. Every other step is less than 2 ms. The
parse has no safe shortcut, so the fix is to do the parse before the person
opens the session.

## Prewarm

`HistoryPrewarm` (`execution/sessions/history-prewarm.ts`) reads first pages
ahead:

- When the host answers `sessionDirectoryOpen`, it reads the first page of the
  10 most recent sessions, 2 at a time, after the answer. A running session is
  read too. A run only appends to its transcript, and each write changes the
  file's revision, so its page answers an open until the run writes again. The
  Claude cache key holds whether the page is the newest page of a run, because
  that page has no fork controls. A running Codex session is not cached: Codex
  caches a page only when every turn in it has ended.
- When a turn ends (`completed`, `failed`, or `interrupted`), it reads that
  session's first page again after 1 s.
- It reads each session with the first-page turn limits that clients send: 5
  (the mobile cold open) and 10 (`INITIAL_HISTORY_TURNS`). If a client changes
  these limits, change `FIRST_PAGE_TURN_LIMITS` too.
- It does not run in API mode, where pages come from the transcript mirror.

The read fills the provider page cache, `ProviderHistoryPages`. A request that
comes while the same page is being read waits for that read
(`readShared`), so a tap during the prewarm does not parse the file again.
After prewarm, the provider step of a read is 0.2–1.4 ms.

## Why the cache holds provider rows only

The cache key is the provider file path, the turn limit, and the cursor. The
value is valid only for the file revision (device, inode, size, and both change
times). So:

- A changed file is read again.
- A person with a private provider home has another path, so another person's
  page never answers them.
- Everything that depends on the caller runs for each request: the access
  check, the fork read, the activity read in the caller's scope, and the
  projection.

The final response is not cached. It also depends on live state that can change
with no change to the file: exchange progress, artifact layouts, and the
caller's activity. These steps cost less than 2 ms together, so a response
cache would add risk for almost no time.

Codex: the cache key also has the turn list, and the revision is the stat of
the rollout file from `thread/read`. The page also uses the async question
answers in the host database and the child threads in the app server. A file
revision does not cover them, so a Codex page is not cached at a higher level.
Prewarm fills the existing Codex cache of the item reads, which are the slow
step (up to 500 ms).

## Opening a session

With `openSession`, the host starts `describeSession` and `watchSession` at
the same time, and reads the page as soon as the watch has joined. The open
costs the slowest step, not the sum.

- Every open watches, a session with a run too. The watch joins first and
  replays the running turn; the page is read after it and leaves out that same
  turn (`running-turn-open.md`). An event after the watch reaches the client
  live.
- An older page or a jump to an entry does not describe or watch.
- `watchIfHistoryRevision` still waits for the page, because it compares the
  page revision.
