# Unified picker: search results

How the task and session picker (⌘P, ⌥⇧F) reads a query and shows what it
finds. This locks the vocabulary and the rules; the code is under
`packages/workspace-ui/src/components/session/unified-picker/`.

## Vocabulary

- **query** — the text in the search box.
- **word** — one whitespace-separated part of the query, lower-cased.
- **hit** — a task, session, or passage the query matched.
- **passage** — the message text a full-text hit was found in, with the
  matched tokens marked by the index.
- **order** — how a section lists its hits: **Relevance** or **Recency**.
- **search mode** — what the query is matched against: **Everything said**
  (full text) or **Keywords in names only**.

## One matching rule

A query is a set of words. Every word must start a token of the text it is
matched against, in any order. This is the rule the hosts' full-text index
applies to a message, and the picker applies the same rule to task titles,
task bodies, task ids, and session names. So `auth flow` finds a task titled
"Flow for auth" and a message that says "the flow for auth", and `auth` marks
"Authentication" but not the tail of "oauth" in either section.

Marks in names come from the words. Marks in a passage come from the index,
which wraps each matched token in the control characters U+0001 and U+0002
(`packages/contracts/src/search-snippet.ts`). Every reader splits on those
markers or strips them; nothing shows them raw. The index stems, so this is the
only way "running" can mark "runs".

A task matches on its title, then its body, then its human id `T-<n>`. Its
status and project path are not fields: matching them listed every task that
shared them.

## Two sections, one order

Under a query the list has two sections in a fixed order, each with a header
that states the order it is in.

- **Tasks** — every task the query hit, folded. A body hit shows the passage of
  the body as the row's second line. An id hit shows the id, marked.
- **Sessions** — every session the query hit by name or by passage, flat, one
  row per session. A session of a listed task is not repeated here; the task
  row is its way in. A session with both a name hit and a passage hit is one
  row carrying the passage.

The **order** applies to both sections and defaults to **Relevance**:

- Tasks: title hits, then body hits, then id hits; newest first within a tier.
- Sessions: name hits first, then passage hits by the index's score, newest
  first among equals.

Under **Recency** both sections are newest first by the date the row shows,
whatever matched.

Each host returns at most 20 passage hits. When a host stops at that cap, the
Sessions count reads `20+` in the header and the footer.

## Search mode

**Everything said** asks every connected host for passages as the user types.
**Keywords in names only** does not ask the hosts at all; the list is only
tasks and sessions whose names match. Both the order and the mode live on the
workspace with the project scope, so every mounted picker reads one choice.
`⌥S` opens the menu; `⌥A` still opens the project scope.

## Preview

The preview beside the list, and the sheet a phone raises in its place, reads
in transcript order, with a plain rule between each part:

1. the opening prompt,
2. the passage the words were found in, only when the row was found by them,
3. the last reply.

A hit that is the opening prompt or the last reply takes that slot, cut around
the words, so no message is shown twice. When the index no longer holds the
passage, the ends alone are shown. On a phone every row, including a
passage hit with no task, opens the same sheet, whose one action is Resume.
