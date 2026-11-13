# Unified search: tasks and sessions as equals

Status: updated, 2026-10-26. Host and SQLite service behavior have focused tests.
The Postgres implementation has not been run against a database in this change.
Current before/after results are in [Session search benchmark](session-search-benchmark.md).

> **2026-11-10.** [Provider-owned tasks](provider-owned-tasks.md) replaced the
> task model. GitHub and Jira own every task; Solus has no local task, no task
> in an organization and no task sharing. The rules of this plan stay. The
> task text that a search reads is the host's task cache: titles and bodies of
> the tasks that the person's task sources list, and the comments of the tasks
> that were opened on the host. A task has no project of its own, thus a
> project scope does not narrow the comment search. Task status in the filters
> is the status category.

> **2026-11-12.** The picker is now **Search**: one search of sessions, tasks,
> works, pull requests, automations, and projects. It replaces the History
> place of the sidebar. See "Search types" below. That section replaces the
> result menu, the remembered result type, and the task rows that opened to
> show their sessions. The other rules of this plan stay.

Search opens on the All type on desktop and web. Native session search shows
sessions only (see "Search types", decision 9).

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
- **word rule** — session text and queries use the same normalization:
  punctuation, camelCase, acronyms and numbers split words. Case and accents
  are ignored. A word can match a prefix; a number must match a whole token.
  There is no stemming.
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

1. **One session matcher.** `packages/contracts/src/session-search.ts` owns
   normalization, name matching, score tiers and portable message targets.
   The host uses normalized FTS5 tokens. The SQLite service uses normalized
   FTS5 tokens; Postgres uses normalized text with the `simple` configuration.
   Both services use the shared scorer. Client name matching uses it too.
   A joined name such as `vscode` can find `VS Code`. If the first pass finds
   no result, names get one conservative typo pass. Numbers get no correction.
2. **Session match, not message match.** A session is listed when each word is
   in its name, its metadata or any message.
3. **Names are searched on the host.** The host reads names and metadata from
   its `sessions` and `session_pull_requests` rows. A name hit ranks above a
   passage hit; the client places it in the `name` tier. A session's opening
   message is not a name: it stands in for a title on screen, but it is what
   was said, and it is found as a message. (Treated as a name, a long opening
   message outranked sessions and tasks named for the words.)
4. **Portable targets and local index positions.** A local message row id is `session number × 2^20 +
   position`. The session a hit belongs to is read from its row id, with no
   join. This is what makes a session match affordable on a large index (see
   "Measurements"). `session_keys` gives each session its number. Search also
   returns the provider thread and message identity, with a text/time reference
   for messages without an identity. Previews resolve that target again instead
   of trusting an old position. Opening a message result loads older history
   pages until the matching message is available, then reveals it. A stalled
   read stops and shows an error. Mirrored previews work while a runner is offline.
5. **Session score before paging.** An exact session ID ranks first, then a
   title, then a branch or PR, then a message phrase, words in one message,
   and words spread across messages. Match quality orders names within their
   tier. Message counts saturate within their tier. The score does not depend
   on a host's corpus size or word frequency. Activity breaks ties. Read
   visibility is applied before paging and totals. Each hit names the field
   that matched. At most three message passages are returned per session.
6. **Every session, in pages.** A query lists every session that matches. A
   host answers with the total and its first page; the list asks for the next
   page when its end comes into view. With no query the picker lists every
   session in the scope. The "20+" cap is gone.
7. **Task comments are searched on the host.** `tasksSearchComments` asks each
   host for the tasks whose comments hold every word. A task found this way is
   in the `evidence` tier, and its row shows the comment passage.
8. **Keywords mode searches names.** "Keywords in names only" asks the hosts
   for name and metadata hits only. It no longer turns session search off.
9. **Rows never move when a host answers.** The client matches task titles,
   session names and the titles of the sessions it has listed on each
   keystroke, and ranks them into Top hits, Tasks and Sessions. The hosts
   answer later. A host's passage for a session already listed is shown in
   its row, and the row keeps its place. A session that only a host found is
   listed in a last section, In messages, under every other row (as in t3code
   #24343). Each host's reply appears at once; a slow host does not delay the
   others. Later replies append. Errors remain visible beside partial results.
   The keyboard cursor follows its row by key.
10. **Filters live in the search options menu**, beside the order and the
   search mode. The chip shows how many are set. They apply with or without a
   query.
11. **All clients.** Desktop and web share the picker. Native Home and the
    tablet sidebar use the same paged client search controller. They show local
    names at once, search full message history on hosts, expose errors and more
    pages, and open the matching message. Project filters include all selected
    clones on a host, with each worktree root searched once.
12. **A project scope includes the chats.** A chat belongs to no project, so
    a project scope also asks each home for its chats with the `chats` filter
    on `searchSessions` and `listSessions`. A home with no checkout of the
    project is asked for chats too. Without this, a chat that another person
    shared from a cloud machine was found only with every project selected.
    Desktop, web, and native Home do the same.
13. **Rebuild derived data only.** The local FTS index is rebuilt from stored
    messages. Mirrored messages get normalized search text and an engine index.
    Original messages stay intact. There is one session matching model, with
    no alternate legacy search path.

## Search types

Search is the place a person finds a thing in Solus by its name or by what it
says. The History place of the sidebar opened the picker of sessions and
tasks. The same key and the same place now open Search.

### Vocabulary

- **Search** — the surface: the box, the type tabs, the list, and the preview.
  In code it is the unified picker (`components/session/unified-picker/`).
- **type** — the kind of result the list holds: All, Sessions, Tasks, Works,
  Pull requests, Automations, Projects. A tab for each type is below the box.
- **record** — a row that is not a task and not a session: a work, a pull
  request, an automation, a project, or an action (`picker-records.ts`).
- **Recents** — the list of the All type while the box is empty.
- **action** — a command at the end of the list. There is one: New session.
- **preview** — the pane beside the list. It shows the row the cursor is on.

### Decisions

1. **One box, a tab for each type.** The All type lists every type. Each other
   type lists one kind. ← and → change the type, as do the tabs. The query
   stays when the type changes: the same words are read against another kind.
   Search opens on All each time. A type is a choice for one visit, so the
   client does not remember it.
2. **Recents.** With an empty box, All shows the ten newest sessions and works,
   then the actions. Recents is what the person last worked on. Tasks, pull
   requests, automations, and projects are not in Recents: other people change
   them, so their dates do not say what the person did.
3. **Each type lists all of its rows.** Sessions: every session of the scope.
   Tasks: the tasks in their lifecycle sections. Works and Automations: newest
   first. Pull requests: the open pull requests. Projects: the order of every
   project list.
4. **Rows are flat.** A task row does not open to show its sessions. The
   preview of a task lists its sessions, and each one opens from there.
5. **Records are matched on the client**, by the word rule that tasks and
   sessions follow. The words in a title are a name hit. The words in a work's
   preview text, an automation's instructions, a project's folder, or a pull
   request's branch or author are evidence, and the row shows the passage. A
   pull request number, typed whole, is that pull request.
6. **Pull requests are asked of the code host.** An empty box reads the first
   page of open pull requests of each project in the scope. A query of two
   characters or more asks the code host, which searches every state and the
   text this client does not hold. Each project is asked through the pull
   request context (`ProjectPrs.query`), so the rows reach the index and the
   list of the Pull requests page is not changed. The All type asks only under
   a query. The answers are kept only while Search is open.
7. **Sections under a query, in order:** Top hits, Tasks, Sessions, Works, Pull
   requests, Automations, Projects, Actions, In messages. Top hits lifts the
   best three rows of any kind when a lifted row would otherwise be below the
   first rows. An action is listed when the query names it.
8. **Every row has a preview.** A session shows its transcript, a task shows
   its page in small, a work shows the start of its document, a pull request
   shows its state, branches, size, and description, an automation shows its
   schedule and instructions, and a project shows its folder and host. The
   preview of an artifact or an app shows its text: it does not run the page.
   ⏎ opens the row where its own page opens it. On a project, ⏎ starts a new
   session in that project.
9. **Clients.** Desktop and web share Search. The native app has session search
   on Home and its own Workspace, Pull requests, and Tasks screens. A search of
   every type on the native app is not built. This is an open product decision.
10. **A guest of a share link** has the All and Sessions types only.

### Scope and filters

- The project scope narrows sessions (as before), works, automations, and the
  projects that pull requests are read from. It does not narrow tasks or the
  Projects type.
- Updated narrows every record that has a date. A project has none.
- Task status, Agent, Host, and Archive keep their meanings. They do not
  narrow records.

### Keys

| Key | Action |
|---|---|
| ↑ ↓ (or Tab, ⇧Tab) | Move the cursor |
| ← → | Change the type. With a modifier, the arrows move the caret |
| ⏎ | Open the row |
| ⌥⏎ | Open the menu of a task or session row |
| ⌥A | Choose the project scope |
| ⌥S | Order, search mode, and filters |
| Esc | Close |

The foot of the list shows these keys. They are absent for a touch pointer. The
preview of a task, of a task's session, or of a pull request has a floating bar
at its foot with the actions of the row, and the primary button of that bar
shows what ⏎ does. A row with one action has no bar: the foot of the list shows
what ⏎ does to it.

A pull request row is the row of the Pull requests page (`PrListRow`, built by
`prRow`), so the two surfaces cannot disagree. Its icon is its state: open,
draft, merged, or closed. A mark at the corner of the icon shows a conflict
with the base branch. The row also shows the review verdict, the checks, the
size of the change, and the author. The verdict is an icon with no words,
because the list has half the width of the card. The checks icon opens the
check runs. The row is taller than the other rows of the search, and it does
not mark the words of the query.

### Loading states

- While the code of Search loads, a frame of the same size shows placeholders
  for the box, the types, the list, and the preview.
- While a read that can fill an empty list is in flight, the list shows
  placeholder rows and the preview shows a placeholder. Only the reads of the
  type in view count (`pickerListLoading`): the Tasks type does not wait for
  the sessions.
- When the reads end with no rows, the list says why it is empty. It does not
  say "no pull requests" before the code host answers.
- When the list has rows and a host is still searching, the rows stay and the
  foot of the list says "Searching the hosts…".

## Known differences

- Search does not find the text of a work's whole body. It reads the title and
  the preview text that the host lists.
- With every project in the scope, a query asks the code host one time for each
  project.

- An upstream provider comment is not stored on the host, so only Solus
  comments are searched.
- Task comment storage and retrieval are outside this session index change.
  Client task titles use the shared name matcher.

## Historical measurements (2026-09-30)

These results describe the earlier encoded-ID change. They are not the
baseline for the 2026-10-26 replacement. See the [current matched runs](session-search-benchmark.md).

`tests/benchmarks/picker-search.ts` measures speed and relevance on a seeded
corpus. It records the "before" in `picker-search-baseline.json`. A 10× corpus
(`--scale 10`, about 700k messages) stands for a heavy user.

A lab test of the query shapes on 720k messages:

| Query | Before (message rank + join) | Session match (encoded ids) |
|---|---|---|
| `the` | 1,629 ms | ~50 ms |
| `sess` | 865 ms | ~25 ms |
| `websocket` | 205 ms | ~5 ms |

## Historical results (2026-09-30)

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

## Follow-ups

- A second page could reuse the first page's match while the index is
  unchanged.
- Fine word distance within one message is not a separate score tier. The
  current tiers distinguish a phrase, one message and several messages.
- Search selection history and a trigram index remain deferred.
