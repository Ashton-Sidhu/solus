# Unified search: tasks and sessions as equals

Status: implemented, 2026-09-30. The Postgres Solus API is not yet run against a database.

The picker lists tasks and sessions as peers (`task-conversation.md` §8: a
session has no task of its own). Search must treat them the same way: a person
finds a session by what it is called or by what was said in it, as easily as a
task by its title, its body or its comments, and fast enough to answer every
pause in typing.

## Vocabulary

- **name** — what a row is called: a task's title; a session's title (its
  custom or generated title, else its opening message, else its slug).
- **session metadata** — a session's branch, and the number and title of each
  pull request linked to it. Searched with its name.
- **evidence** — where the words are when they are not in the name: a task's
  body or comments; the messages of a session.
- **word rule** — how a query matches text, the same everywhere: the query is
  split on white space, and every word must start a word of the text. Case is
  ignored. There is no stemming.
- **session match** — every word of the query is somewhere in the session: its
  name, its metadata, or any of its messages. The words need not be in one
  message.
- **passage** — the message a session row shows under its name, with the words
  marked. A session found only by its name has none.
- **page** — one part of a host's answer to a query. The first page comes with
  the query; the next comes when the list reaches its end.
- **filters** — Updated (any time, 24 hours, 7 days, 30 days), Task status (any,
  open, done), Agent (any, Claude, Codex) and Host (any, or one machine).
  Updated narrows both kinds; Task status narrows tasks only; Agent and Host
  narrow sessions only. A Host filter asks only that machine and the workspace
  service, because a service record opens on the machine that ran it. Host is a
  submenu with its own scrolling list, so the menu does not grow with the
  number of machines. It shows only when there is more than one machine, or
  when a host is selected.

## Decisions

1. **One word rule.** The client, the host index and the Solus API use
   the word rule. The host index drops the Porter stemmer and matches every
   word as a prefix, not only the last. "running" no longer finds "run" in a
   session and still does not in a task: the two agree.
   - The Postgres Solus API still stems (its `tsvector` is built with
     the `english` configuration); it matches every word as a prefix. The
     SQLite Solus API matches substrings. Both are listed under
     "Known differences".
2. **Session match, not message match.** A session is listed when each word is
   in its name, its metadata or any message.
3. **Names are searched on the host.** The host reads names and metadata from
   its `sessions` and `session_pull_requests` rows. A name hit ranks above a
   passage hit; the client places it in the `name` tier. A session's opening
   message is not a name: it stands in for a title on screen, but it is what
   was said, and it is found as a message. (Treated as a name, a long opening
   message outranked sessions and tasks named for the words.)
4. **Encoded message ids.** A message row id is `session number × 2^20 +
   position`. The session a hit belongs to is read from its row id, with no
   join. This is what makes a session match affordable on a large index (see
   "Measurements"). `session_keys` gives each session its number.
5. **Session score.** A session's score sums, for each word, the word's weight
   (rarer words weigh more) times a saturating count of the session's messages
   that hold it. A session with one message that holds every word gains a
   bonus, and one with the words as the phrase typed gains more. Recency
   breaks ties. The passages are the newest messages with the phrase, then
   with every word, then with each word, rarest first; at most three.
6. **Every session, in pages.** A query lists every session that matches. A
   host answers with the total and its first page; the list asks for the next
   page when its end comes into view. With no query the picker lists every
   session in the scope. The "20+" cap is gone.
7. **Task comments are searched on the host.** `tasksSearchComments` asks each
   host for the tasks whose comments hold every word. A task found this way is
   in the `evidence` tier, and its row shows the comment passage.
8. **Keywords mode searches names.** "Keywords in names only" asks the hosts
   for name and metadata hits only. It no longer turns session search off.
9. **Filters live in the search options menu**, beside the order and the
   search mode. The chip shows how many are set. They apply with or without a
   query.

## Known differences

- The Postgres Solus API stems English words.
- The SQLite Solus API (a small lab service) matches substrings.
- An upstream provider comment is not stored on the host, so only Solus
  comments are searched.

## Measurements

`tests/benchmarks/picker-search.ts` measures speed and relevance on a seeded
corpus. It records the "before" in `picker-search-baseline.json`. A 10× corpus
(`--scale 10`, about 700k messages) stands for a heavy user.

A lab test of the query shapes on 720k messages:

| Query | Before (message rank + join) | Session match (encoded ids) |
|---|---|---|
| `the` | 1,629 ms | ~50 ms |
| `sess` | 865 ms | ~25 ms |
| `websocket` | 205 ms | ~5 ms |

## Results

`bun tests/benchmarks/picker-search.ts` against the recorded "before", on the
seeded corpus (67k messages) and at `--scale 10` (672k messages, 22k sessions).
Times are medians on one machine; they vary by some milliseconds between runs.

| Host search | Before | After | Before ×10 | After ×10 |
|---|---|---|---|---|
| `the` | 103 ms | 12 ms | 1,435 ms | 137 ms |
| `sess` | 44 ms | 5 ms | 534 ms | 54 ms |
| `websocket reconnect` | 2.5 ms | 4.6 ms | 33 ms | 48 ms |
| `fix sidebar scroll` | 1.3 ms | 5.6 ms | 9 ms | 62 ms |
| `pelican` (rare) | 0.1 ms | 0.7 ms | 0.2 ms | 7 ms |
| `sess`, names only | — | 0.7 ms | — | 7 ms |
| `the`, second page | — | 11 ms | — | 141 ms |

| Relevance (19 queries) | Before | After |
|---|---|---|
| hit@1 | 0.79 | 0.95 |
| MRR | 0.79 | 0.95 |
| A session by its title only | missing | #1 |
| A session by its branch | missing | #1 |
| Words across two messages | missing | #1 |

The client list build per keystroke did not change (about 2 ms mean, 3 ms
worst, for 1,260 tasks).

What the steps did, measured each time:

1. **Session match on message rows.** With a join and a rank for every hit,
   "the" took 1.6 s on the lab index; reading the session from an encoded row
   id took about 18 ms per word.
2. **Passages from the pass that counts hits.** A per-session FTS query for the
   best passage cost about 16 ms for each session on a common word; the newest
   hits kept while counting cost nothing more.
3. **Passages for the page only.** Building passage lists for every session
   was 30 ms of a three-word search at ×10; the page needs 30 of them.
4. **No schema parse of each hit row.** A parse of 672k rows was a third of the
   search for "the".
5. **Phrase bonus.** Without it, "flaky reconnect test" fell from #1 to #18
   among sessions that hold the words apart.

What costs more than before: a query of several words whose words are in
almost every session. Each word is scanned on its own, where the old query
intersected them in one message; this is the price of a session match. A
second page costs as much as the first, because the host matches again.

Not measured here: the Solus API engines. The SQLite engine is
covered by `api-mode.test.ts`; the Postgres engine is not run by the
unit tests without `POSTGRES_ADMIN_URL`.

## Open questions

- Under a query, the Tasks section still comes before the Sessions section.
  Top hits lifts the best three rows of both kinds, but a session named for the
  words, typed in another order ("reconnect websocket"), is #143 behind every
  task that holds the words. This was the same before this change.
- A second page could reuse the first page's match while the index is
  unchanged.
