# ADR 0006 — The transcript mirror is for readers; the session repository is for hosts

Status: ACCEPTED, 2026-11-21.

## Context

Portable sessions (`docs/plans/portable-sessions.md`) gave each session a Git
repository that a host pushes to the cloud. Phase 5 also made that repository a
store for readers: each turn commit held the projected rows (`rows/<n>.jsonl`)
and the diff of the turn (`diff/<n>.patch`), and the Solus API read them at the
recorded head (`SessionCloudReader`).

Solus had a reader store before that: the transcript mirror. A host sends the
projected rows of a published organization session to the Solus API
(`session_transcripts`), also while a turn runs. Search, `listSessionMessages`
(the `read_session` tool), the session record page, and the live rows of a turn
on a host that a reader cannot connect to all read the mirror.

So a reader had two stores, and each client had rules for the two:

| | Transcript mirror | Session repository |
| --- | --- | --- |
| Rows of a published organization session | Yes, a running turn included | Yes, until 2026-11-21 |
| Rows of a personal session | No | Yes |
| Diff of a turn with no host online | No | Yes |
| Search, API clients, live rows | Yes | No |
| Read-only surface on desktop and web | The session record page | The rows in the tab |

Two reviews compared the options (Solus works `9c0a6c3b-…` and `ea959f13-…`).
Option B, "the repository is the one source for a session with no host online",
was built on a branch and rejected: the mirror cannot be removed (search, API
clients, and live rows need it), so the two stores stay, and the rule "which
store answers" depends on whether a turn runs.

## Decision

The two stores have separate roles.

1. **The transcript mirror is the one store for readers.** Each reader that
   does not read a live host reads the mirror on the Solus API: the read-only
   view with no host online, the diff of a turn, search, `read_session`, API
   clients, and live rows.
2. **The session repository is only for a host that continues a session.** It
   holds the provider thread files, the code bundles, and the manifest. It
   holds no rows and no patch. The Solus API reads no file of it.
3. **The mirror also holds personal sessions**, in the owner's own scope,
   `person:<accountId>`, in the place of an organization id. The owner's
   personal delegated token delivers them. The Solus API keeps no session
   record and no share row of a personal session; only its owner reads it.
4. **The mirror also holds the diff of each ended turn** (delivery kind
   `turn-diff`, table `session_turn_diffs`), with the limit of the old
   repository patch (2 MiB, then `too-large` with the counts).
5. **One switch.** The cloud sync decision (`sessionCloudSync`: the host
   setting, the policy, and a signed-in person) gates the cloud copy of a
   session, the mirror of a personal session, and the diff of each turn. The
   rows of a published organization session keep their own gate: publication.
6. **The client rule does not change:** read the host when a host that holds
   the session can be reached, else the Solus API. What the copy holds is the
   answer of the mirror. A client does not decide it from repository facts.

The details are in `docs/plans/portable-sessions-cloud.md`, "The mirror for
readers".

## Consequences

- One read path on the Solus API. `SessionCloudReader`, the row capture of the
  archive writer, the row and patch files of new turn commits, and the byte
  limit of `RepositoryProvider.readFile` are deleted.
- A reader gets the rows of a running turn of a personal session, and the tool
  details of each turn, which the repository reader did not give.
- An organization session with cloud sync off is readable with no host online
  from each client. Before, the tab said that Solus Cloud had no copy.
- The Solus API database holds the projected rows of personal sessions, with
  their search text column, and their turn patches. The rows have no tool
  result body. Only the owner's scope reads them; no search reads them.
- A turn commit is smaller, and the host reads no history page at turn end.
- Old turn commits keep their row and patch files. No repository is written
  again. A turn that ended before this decision has no diff for a reader. A
  session with a cloud copy and no mirrored row is mirrored once after boot.
- Not decided here: search and `read_session` of a personal session on the
  Solus API (they need a session record there, decision D2 of the cloud plan),
  and retention and delete of mirrored personal rows (D9).
