# Session identity

Supersedes the compatibility section of [session-handoff-lineage.md](./session-handoff-lineage.md).
That document introduced the lineage table for provider handoffs only. This one makes
the lineage the identity record for **every** session.

## Vocabulary

Lock these terms. Do not coin synonyms.

- **stable session ID** — Solus's own id for a session. The only id tabs, watches, routes,
  sidebar selection, tasks, and events use.
- **provider thread ID** — the id the agent runtime gives its own conversation. Adapter and
  transcript-reader metadata only.
- **session lineage** — the ordered list of provider threads one session has run on. Every
  session has one. Position 0 is where it started.
- **handoff** — appending a new provider to an existing lineage. Rare. A lineage of length 1
  has had no handoff.
- **registration** — writing a lineage row the first time a provider thread becomes known.
  First writer wins.

## The defect

The binding from provider thread ID to stable session ID lived in one in-memory
`Map` (`agentSessionToSession`) with last-writer-wins semantics. `submitPrompt` re-pointed
it to whichever client prompted last, and a server restart lost it entirely.

Clients mint the stable session ID themselves (`session.factories.ts`), which is safe for a
new session — the uuid has never left that renderer — but not on resume. What is durable on
disk is the provider thread, not Solus's name for it. Two clients resuming the same thread
each invented a different name, `watchSession` had no durable record to correct them with,
and each client then received only the turns it started.

## Decision

The server does not need to mint the ID. It needs to **register** it durably at first sight
and never re-point it afterwards.

1. Every session gets a lineage row at position 0, written at `session_init` — the single
   point where a provider thread ID first becomes bindable to a stable session ID.
2. Registration is first-writer-wins, enforced by the existing partial unique index on
   `(provider, provider_session_id)`. A second client proposing a different name for a
   thread that is already registered is answered with the registered name, not obeyed.
3. `agentSessionToSession` becomes a read cache of that table, not the record of truth.
4. `watchSession` already prefers the lineage answer. With universal registration it now
   resolves for every session, survives a server restart, and cannot be flipped by a late
   prompter.

Clients still adopt the ID `watchSession` returns. That stays correct and is now redundant
rather than load-bearing — which is the point.

Tab creation does not wait on the server. A new session's uuid is still minted locally, so
opening a tab stays instant and works while disconnected.

## Consequences to design around

Universal registration means `resolveSessionLineage` returns non-null for ordinary sessions,
so every site that read "a resolution exists" as "this is a handoff" must instead read
`members.length > 1`.

- `loadSessionPreview` would lose its `backend.loadSessionPreview` fast path and load a full
  composite transcript for every preview. Guard on lineage length; this is a hot path behind
  the session picker.
- `listSessions` currently emits a lineage as one grouped row and a plain provider row
  otherwise. Every row now takes the grouped path, so the picker starts naming sessions by
  their stable session ID. That is the desired end state — it is what lets a picker row on
  web resolve to the same session the desktop already has open — but the grouped row must
  carry the same metadata the plain row did.
- `loadSession` builds a composite with a divider before each member after the first. A
  single-member lineage produces no divider, so composite output equals plain output.
- `_pendingHandoffFor` requires a provisional member and a predecessor, so a single-member
  lineage is inert there.

## Lock step is a second problem

Identity alone does not make two clients agree. `bindRuntimeSession` replays only the
current turn's accumulated text, pending permission and question events, and a pending rate
limit. **Tool calls already emitted in the in-flight turn are not replayed**, because no
per-session event log exists, and the durable transcript on disk does not contain an
uncommitted turn.

So a client that opens a running session mid-turn joins correctly and receives every
*subsequent* event, but starts with a hole where the turn's earlier tool calls should be.

Fix: keep a bounded per-session log of the current turn's events, cleared when the turn
settles, and replay it to the joining client in `bindRuntimeSession` in place of the
text-only replay. Bounded because a long turn must not grow without limit; cleared on settle
because durable history takes over from there.

## Not in scope

Rebuilding lineage for provider transcripts that predate this change. An unregistered thread
registers itself the next time it runs.
