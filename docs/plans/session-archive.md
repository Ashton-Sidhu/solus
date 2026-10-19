# Session archive, the session list, and the session's home

Status: implemented, 2026-10-14.

A session's place in a person's list is part of the session. Each client reads
the full list each home keeps for the person, and each session in it carries
its state, its view, and its pull requests. A change arrives as an event with
what it leaves. This follows T3 Code: a thread shell carries `settledAt`,
`snoozedUntil` and `archivedAt`, the client gets every thread that is not
archived, and the archive bounds the list (read at `pingdotgg/t3code` main,
2026-10-14).

This replaces the shelf read of `docs/plans/session-pull-requests.md`
(`sessionShelfList`). That read had a limit of 500, and a client took a session
missing from the answer as active. With more than 500 recent settles, a
snoozed session came back to the active list on each reload.

## Vocabulary

- **home** — the host that keeps a session's records: its list state, its pull
  requests, and its record. A published organization session's home is the
  organization's Solus API. Every other session's home is its machine: a
  personal session, and an organization session that is not published. Such a
  session belongs to the organization only for its Insights; its record never
  leaves the machine, so the Solus API does not know it.
- **machine** — where the session runs: prompt, stop, the live transcript,
  permission answers, and PR watches that wake the agent. It does not change.
- **settled** — the session's work is finished. Shared: every person sees one
  settle.
- **archived**, **snoozed** — one person's own view of a session. They change
  that person's list, and nobody else's.
- **session list** — the sessions in a person's list: every root session of
  theirs that they did not archive and that was active in the last 30 days,
  that they snoozed, or that waits on an open pull request. A session is theirs
  when they own it, when they prompted or organized it, or when it has no
  owner (a machine's personal sessions).
- **session picker** — the search that finds any session, archived ones too.

Do not say "closed", "hidden" or "dismissed" for an archived session. Closing a
tab is a different action: it changes nothing on the home.

## Decisions

1. **Every call about a session goes to its home, except execution.** The
   machines that run organization sessions rotate and go offline, so the Solus
   API keeps their state. `sessionHomeId` (`client-core/session-home.ts`)
   names the home: for a published organization session, the organization's
   Solus API when the client is connected to it; else the machine. The server
   uses the same rule (`workspaceToolContext`, `RunnerDelivery.reportSession`).
2. **Shared and personal state are apart.** `session_states` keeps the shared
   settle (`SessionShelf`). `session_views` keeps each person's archive and
   snooze (`SessionViewer`, keyed by `ownerKeyOf`). An archive keeps the settle
   and the snooze, so a return puts the session back on its shelf.
3. **A person's list holds their own sessions.** In an organization every
   member can read every session, but a list of everyone's work is no list.
   The list keeps a session the person owns (`owner_key`), and one they
   have a view row for: their first prompt writes an empty one
   (`SessionViewer.returnToList`), and so does an archive or a snooze. The
   picker and search still find every session they can read.
4. **Idle is a rule, not a write.** The list query leaves out a session with no
   activity for 30 days, unless the person snoozed it or it waits on an open
   pull request (`sessionListedClause`). Nothing sweeps, and a new prompt
   brings the session back by its activity.
5. **One set of `/v1` resources on both homes.**

   | Route | Methods | Holds |
   |---|---|---|
   | `/v1/sessions/:sessionId` | GET, PATCH | `settled` for every person (editor); `archived`, `snoozedUntil`, `snoozeNote` in the caller's own view (viewer) |
   | `/v1/sessions/:sessionId/pull-requests` | GET | the session's links |
   | `/v1/sessions/:sessionId/pull-requests/:pullRequestId` | PUT, DELETE | link (idempotent), remove (tombstone) |
   | `/v1/sessions/:sessionId/turns` | POST | a prompt reached the session (a host acting for the person only) |

   One PATCH carries both kinds of field: the server checks the role each
   field needs before it writes anything, and answers the session with its
   state and the caller's view. A session the home does not keep is 404.
   `:pullRequestId` is `host/owner/repo#number`, URL-encoded. `GET /v1/sessions`
   answers each session with `state`, `view` (the caller's), `listed`, and
   `pullRequests`. It answers top-level sessions in the caller's list by
   default. `scope=all` answers every top-level session they may read, as the
   tasks list does; `parentSessionId` answers the sessions one session started.
   The RPCs
   `sessionSetSettled`, `sessionSnooze`, `sessionSetArchived`,
   `sessionPullRequestsList`, `sessionPullRequestLink` and
   `sessionPullRequestUnlink` are gone. `sessionPullRequestWatch` stays an RPC:
   watching is execution.
6. **A change carries what it leaves.** `session.stateChanged` is
   `{ sessionId, state }`, broadcast. `session.viewChanged` is
   `{ sessionId, view }`, sent only to that person's connections
   (`session-view-events.ts`). A client writes either one and reads nothing back.
7. **The machine tells the home.** At each prompt the machine records it
   locally and posts the turn to an organization session's home
   (`admitTurnAtHome`, `run-launcher.ts`). An agent's pull request link and the
   link Solus makes when it opens a pull request travel in the delivery queue
   (`sessions/link-pull-request`, with `source`). The agent tool
   `organize_session` uses the home's operations (`workspaceToolContext`).
8. **The home keeps pull requests fresh.** The Solus API runs PR sync for its
   organization sessions (`organization-pr-sync.ts`): it reads the branches the
   records name and each repository as a person whose live session works in
   it. solus-cloud gives it the person's GitHub connection in the process
   (`accountCredential`, `useAccountCredentialSource`). Settling sessions whose
   pull requests ended runs there too.
9. **Clients.**
   - Desktop and web: `SessionListStore` holds the list, the shared states, and
     this person's views; `SessionPullRequestsStore` takes the links the list
     carries and reads one session again on `session.pullRequestsChanged`.
     The X on a session's row archives it in the person's list, with Undo.
     "Close Tab" only closes the tab.
   - The picker lists every session; an archived one has a mark and "Return to
     List", and the Archive filter shows only archived ones.
   - Mobile reads the list and the sessions out of it, and archives, snoozes,
     and settles through the same methods.

## Limits

- Mobile does not connect to an organization's Solus API. Its home for a
  published organization session is the machine the session came from, so its
  archive and snooze of one land on that machine until mobile connects to the
  API. For every other session mobile, desktop, and web use the same home.
- A Solus API with no `accountCredential` (local development) runs no PR sync.
- Read state, titles, branches, pins, and the thread goal are not on the home's
  routes yet. Each needs its own route.
- `watchSession` and `unwatchSession` are execution: the Solus API registers
  them for presence, but its plane refuses them.
- A machine still settles its own copy of an organization session by its pull
  requests. Clients read the home's copy, so the machine's copy shows nowhere.

## Verification

- `session-states`: shared settle; one person's archive and snooze leave
  another's view; a prompt returns the session to its person's list; a
  session someone else owns joins a list at that person's prompt; the list
  rule past 500 sessions; the API list, one PATCH, and turn admission.
- `session-home-routes`: the pull request resource over HTTP, `listed`, and the
  turn route's refusal.
- `pr-sync`: the Solus API links an organization session's branch pull
  request, reading as the session's owner.
- `session-list-store`, `session-sidebar-archive`, `session-organize-tool`,
  `solus-api-composition` (the API applies a runner's outbox), and the mobile
  thread list tests.
