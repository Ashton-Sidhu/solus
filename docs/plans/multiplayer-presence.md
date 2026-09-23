# Multiplayer presence

**Status:** Implemented, first slice (2026-09-16); second slice adds queue author labels, the join notice, and follow mode (2026-09-16).
**Companions:** `docs/plans/multiplayer-sharing.md` (who may open a session or work), `docs/plans/provider-seats.md` (whose login a turn runs on).

Presence is what makes a shared host feel shared: who is here, where they are, whether they are typing, and whose turn is running. This slice adds it for sessions and for the host as a whole. Works use saved-copy checks, with no presence or cursors.

## 1. Vocabulary

- **participant** — one connected client, as every other client sees it. Two panes on one renderer are one participant; the same person on a laptop and a phone are two.
- **person** — a user. The client groups participants by user id before it shows anything, so a person is one face however many devices they have.
- **room** — the participants of one session: the control plane's watchers of that session whose socket is up. Not stored anywhere; derived from the watch set and the live sockets, so the two cannot disagree.
- **focus** — what a client's focused pane shows: a session, a work, or nothing. A hint for other people, never an authorization.
- **composing** — the client has a non-empty draft in a session. A client composes in at most one session at a time.
- **active turn** — the run in flight in a session and whose prompt it answers. It runs under that author's seat.
- **author** — who wrote a prompt, stamped by the host on the transcript echo and on a held prompt in the queue.
- **join notice** — the toast when a person arrives on a host the reader is on.
- **follow mode** — the reader goes where one person goes: each move of the followed person's focus is opened once. It ends when they leave the host or when the reader opens something of their own.

## 2. Rules

1. **The host names people.** Display name, avatar, and colour come from the admitted principal (`turnAuthorFor`). A client never supplies its own identity. The personal host's owner is `Host owner` on the wire, because a local connection knows no account; a client that knows the account from the directory row (`ownerName`, `ownerUserId` on the saved host) names the person instead, and merges them with the same account on every other host (`identityOf`, `roster`).
2. **Colour is a stable hash of the user id** (`presence-color.ts`, FNV-1a into eight hues). The same person is the same colour on every host, in every stack, on every bubble, before and after a restart.
3. **Presence is memory-only.** Nothing here touches SQLite. An entry lives exactly as long as its socket: it appears on the first connect and disappears on the last disconnect, even though the control plane keeps the client's watch through the transport's grace period so its stream can be recovered.
4. **Audiences follow sharing.** `session.presenceChanged` is a resource event for its session and reaches whoever can open it. `host.presenceChanged` reaches every admitted client except a guest, who is never told about the host. A guest's `presenceSnapshot` answers its own client id and an empty host; a guest's reported focus is clamped to its one resource.
5. **The reader is never in their own stack.** The store leaves out every participant under any id that is the reader's on that host (`selfUserIds`): the participant the host says they are, the account behind their connection, `host-owner` on a host they own, and their signed-in account id. A person who has the session open on a laptop and in a browser — one door as the host owner, the other as the account — sees only other people.
6. **Typing takes the right to prompt.** `presenceSetComposing` is resource-classed as editor on the session. `presenceSnapshot` and `presenceSetFocus` are host-wide and open to guests.
7. **Authors are live-only.** `user_message.author` is on the wire echo and on the in-memory transcript; a history reload does not know it, and the bubble then carries no name, exactly like `via`. A held prompt is named the same way: `prompt_queued.author` on the event and `QueuedPromptSnapshot.author` on the snapshot a reconnecting client reads. The host's own work (automations, follow-ups, the owner's local prompts) carries no name anywhere.
8. **A join notice names arrivals only.** A person is announced when they were not on the host in the previous snapshot. The first snapshot announces nobody, a second device of someone already here is not an arrival, and nothing is announced until the reader knows their own user id, because until then their own second device would be announced as a stranger. Leaving is silent.
9. **Follow mode is a tether, not a lock.** Following opens the followed person's focus once per change and waits while they have nothing open. The reader's own navigation ends it, and so does the person leaving the host. One person is followed at a time, on one host; a follow toast with **Stop** stays up for as long as it is on.

## 3. Contract

`packages/contracts/src/presence.ts`: `PresenceParticipant`, `PresenceFocus`, `HostPresenceSnapshot`, `SessionPresenceSnapshot` (participants plus `activeTurn`), `TurnAuthor`, and the request schemas. Events `session.presenceChanged` and `host.presenceChanged` are whole snapshots. RPCs: `presenceSnapshot()`, `presenceSetFocus({ focus })`, `presenceSetComposing({ sessionId, isComposing })`.

A host participant whose focus is a session also carries `activity`, the host's own description of that session (`SessionActivity`): its title from the index, the task it works on, its state (`running`, `waiting` on a person, or `idle`; `sessionActivityStateOf` maps a `SessionStatus`), and the active turn's author. The row's `isComposing` says the client has a draft in that focused session. The control plane answers (`sessionActivityFor`), and the host republishes the roster when a focused session's status changes, so "In Fix login, agent running" reads the same on a client that never opened Fix login. A session the index does not know yet has no `activity`.

## 4. Host

Closing or replacing the network listener removes every connected client from presence, once per client even when it has multiple sockets. The presence manager can outlive a listener during a remote-access change; it must not retain people from the old listener.

- `packages/server/src/presence/presence-manager.ts` — `PresenceManager`, keyed by client id: join, leave, focus, composing, host snapshot, session snapshot for a given watcher list. `turnAuthorFor(principal)` and `activeTurnFor(actor, provider)` live beside it.
- `packages/server/src/server/index.ts` wires it: join on socket connect (the newcomer gets the room whether or not it is new; everyone else hears only about a new face), leave on last disconnect, the session rooms of a client republished on both. The control plane emits `watchers-changed` from `watchSession` and `_dropWatch`; `session-status` republishes the room so the "whose turn" line follows the run.
- `TurnActor` gains `displayName` and `avatarUrl`; `turnAuthorOf(actor)` in the presence manager turns it into the `TurnAuthor` that `_userMessageEvent`, `_enqueueRequest`, and `_queuedPromptsForSession` all stamp.

## 5. Client

- `contexts/presence/presence.store.svelte.ts` — one store: host snapshots, session rooms, this client's id per host, `hostPeople`, `sessionPeople`, `peopleFocusedOn`, focus reporting (coalesced, cleared on the host being left, re-sent on reconnect), composing reports (coalesced per session), the join notice (a diff of consecutive host snapshots), and follow mode (`following`, `follow`, `stopFollowing`, `isFollowing`, `syncFollow`). Presence is a store because it is durable host state read by many surfaces at once: the band, the sidebar rows, the roster, the bubbles, and the toasts must never disagree, and the reports to the host must be coalesced in one place.
- `components/presence/lib/presence-people.ts` — the pure view model: people from participants (`peopleFrom`, reading with `PeopleOptions`: who the reader is there and what the host's owner is called), `newArrivals`, `followStep`, the typing words, the stack, the tint. `lib/host-people.ts` — the roster across hosts: rows per host, merged into one person per identity (`rosterPeople`, `RosterPerson` with its `presences`), the host they are best reached on (`primaryPresence`), and the words for where a person is (`whereIs`, `rosterWhere`, `sessionLabelIn`), used by the phone roster.
- `components/presence/` — `PresenceAvatar` (initials on the person's colour, avatar when it loads, ring for the active turn's author or the followed person, dot for a draft), `PresenceStack` (faces with a count and a tooltip roster; `tooltip={false}` for a caller that opens its own), `SessionPresence` (the band: the faces are a button, so the roster opens on click, tap, or Enter and not only on hover; each person's row toggles **Follow**, and a last row, **Who can open…**, opens the share dialog, which is where a guest is let out — turning the link off — since everyone in the room is already here and there is no per-person removal), `ComposingLine` ("Alice is typing…" at the transcript tail), `TurnAuthorLabel` (the name over someone else's prompt, held or sent).
- `apps/client/src/shell/mobile/MobileHereNow.svelte` — the phone's roster in the drawer, between the pins and the tasks: a row per person (tap to jump to where they are, on whichever host that is) with a **Follow** / **Following** control.
- Surfaces: the session band before Share; the transcript tail beside the queued prompts; user bubbles, including the held prompts in the queue; task session rows in the sidebar (from the host roster, so a row can say who is in a session this client has not opened); the task page's Sessions section, table and phone cards alike (faces, the draft dot, and the ring on the turn's author, from the host roster's `activity`); the phone drawer between the pins and the tasks.
- Focus is reported from one `$effect` per shell (`apps/client/src/App.svelte`, `apps/desktop/src/renderer/shell/desktop-runtime.svelte.ts`) reading the router's focused pane, and a second `$effect` beside it keeps up with the followed person; composing from the input bar's synchronous emptiness flag while the bar is active.

## 6. Proof

- `tests/unit/presence-manager.test.ts` — identity from the principal, rooms as connected watchers, one composing session per client, stable colour.
- `tests/unit/presence-people.test.ts` — the client view model: one face per person, the reader left out, the typing line's words, the roster across hosts, who counts as an arrival, the steps of a follow, and how a roster names a session.
- `tests/unit/control-plane-queue-author.test.ts` — a member's held prompt carries their identity on the queue event and the snapshot; the host's own does not. `tests/unit/session-event-card-stream.test.ts` — the reducer keeps it on the held bubble.
- `tests/unit/presence-audience.test.ts` and `tests/unit/access-policy.test.ts` — who hears which room, and who may call what.
- `packages/lab/scenarios/presence.ts` — two members and a guest on a real host, both flavors: rooms, typing, focus, the guest's clamp, and leaving; and the roster's `activity`: a draft in the focused session reaches the host room, a turn parked on a permission reads running then waiting for input with its author and the host's name for the session.

## 7. Not in this slice

Work multiplayer is removed (2026-09-19). No work focus, avatars, carets, pointers or follow mode. Session follow and presence remain. A reading marker in the minimap and guest presence beyond the shared session room remain out of scope.

## 8. Decisions for the next slices (2026-09-18)

1. **Org members see each other's activity by default.** The cloud activity projection (who is on which host, which sessions run, their task and run state) is visible to every member of the org, not only on shared hosts. A jump opens the host when the reader has access; otherwise the row says the person is on a machine that is not shared. Guests are never in it.
2. **Work carets are removed.** The earlier caret-toggle decision is withdrawn; cloud works use saved-copy change checks.
3. **Task detail shows people.** Session rows on the task detail carry the faces, the typing dot, and the active-turn ring, on desktop, web, and mobile. Done (2026-09-18), together with the host-described `activity` on roster rows.
