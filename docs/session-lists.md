# Session lists and search

A client reads session lists and session search through the workspace HTTP API.
The client does not scan provider files over RPC.

## Where a read goes

Each home keeps its own session records:

| Home | Keeps | Answers from |
|---|---|---|
| This machine (desktop) | Its own sessions | Its `session_records` and its transcript index |
| A personal VM | Its own sessions | The same, on that VM |
| The organization's Solus API | Every organization session | Records and transcripts that runners mirrored |

The picker search asks the homes in this order: this machine, then the person's
other machines, then the Solus API
(`searchServerIds` in `unified-picker/lib/conversation-search.svelte.ts`). It does
not ask an organization's machine. The Solus API has the record and the
mirrored transcript of each organization session, and it answers when the machine
is off.

- `GET /v1/sessions` lists records. The `#` session list in the composer uses it
  (`sessionRecordList`) for the tab's host.
- `GET /v1/sessions/search` searches what the person and the agent said. It does
  not search tool calls or tool output. A machine answers from its FTS5 index. The
  Solus API answers from `session_transcripts`: a `tsvector` index on
  Postgres, and a scan on SQLite.

## How the picker orders a search

The picker matches task titles, task bodies, task ids, and session names on the
client. It gets passages of what was said from the homes. A query of one
character does not ask the homes: it matches almost every message, and the
passages tell the reader nothing. Names still match it.

With **Best match first**, each row gets a tier from where the query matched,
and a score in that tier (`unified-picker/lib/picker-relevance.ts`):

1. **Id.** The query is a task's id (`T-42`).
2. **Name.** The words are in the task title or the session name. This includes
   the name of a session that no task claims.
3. **Evidence.** The words are only in a task body or in what was said. The
   index's score orders these passages.

In the name tier, a name that is equal to the query comes first. Then a name
that starts with the query, then a name that holds the query as a phrase, then
a name that holds the words in different places. A whole word beats a word
that only starts a longer word ("tab" finds "Tab strip" before "table"). A
short name that the query fills beats a long name. Recent, open work gets a
small lift. The lift is too small to put a weaker match above a better one.

When a session is a better match than tasks that come before it in the list,
the best three rows of both kinds go into **Top hits**, above Tasks and
Sessions. A row shows only once. A session is not lifted next to its own task,
because the task's row resumes that session. **Newest first** lists the two
sections by date and has no Top hits.

A session row in the list names its task, unless the session has the same name
as its task.

`bun tests/benchmarks/picker-search.ts` measures the search speed and where
planted targets land in the list.

## Organization sessions

A record from the Solus API names its runner (`runnerHostId`). When a
saved server with that `uplink.hostId` is connected, the picker row opens on that
runner. If no such server is connected, the row stays on the service and shows
as read-only with its runner offline (`session-home.ts`).

The message ID of a service hit is a position in the mirrored transcript. The
runner's index does not know that position. So when a row opens on its runner,
its preview opens on the transcript's ends, not on the passage.

## The record

A session record carries what a client needs to open a session with no other
read: `cwd`, `slug`, `isWorktree`, `branch`, `projectRoot`, and the delegation
(`messageId`, `depth`, `intent`, `createdAt`). The indexer and the runtime write
these fields. Runner reports carry them to the Solus API. A report that
does not name a field keeps the stored value.

At start, the indexer fills these fields for records written before the
fields existed, from the index rows (`fillRecordLocationsFromIndex`).

## First launch

A machine reads its transcripts into its index on its first sweep. Until that
sweep ends, `GET /v1/sessions` and `GET /v1/sessions/search` answer
`indexing: true`. Their answer is then not every session.

- The picker search shows "Indexing sessions…" and does not say "no match".
- The `#` menu shows "Indexing…" in the count slot of the Sessions category.

Every machine's server starts the sweep in `bootCore`. The desktop defers it
until its window first paints (`deferSessionIndex`, then `startSessionIndex()`).
The Solus API has no sweep and always answers `indexing: false`.

## Known difference

The record list has one row per session: a session that changed provider is
one record, which shows its current thread (`docs/plans/session-identity.md`).
The search reads transcripts, so a hit names the provider thread that holds the
text; opening it resolves the thread to its session.
