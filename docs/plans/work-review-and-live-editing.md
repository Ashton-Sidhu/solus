# Plan: work review and live editing

People in an organization, and people outside it, can **review** a work. A
reviewer approves it, requests changes, or leaves comments. This is the same
model as code review, applied to a doc, a diagram, or an artifact. Later, more
than one person can **edit** a doc or a diagram live at the same time, with the
agent as one more participant.

Implementation starts with the [work editing foundation](work-editing-foundation.md).
That plan covers the server `Work` class, content versions and immutable
history, a shared write/event path, full-history Share transfers, a host-safe
document schema, shared open-work state, and the `DiagramDocument` class.
Those refactors have landed.

## Status

| Phase | Status |
|---|---|
| 1. Revision history | Landed |
| 2. Work review | Landed, except push to offline members |
| 3a. Presence on works | Landed |
| 3b. Live edits | Landed; see the limits below |
| 3c. Offline edits | Landed |

User guide: [Work history and review](../work-history-and-review.md).

**Phase 1.** RPCs `loadWorkRevisions`, `loadWorkRevision`, and
`restoreWorkRevision` replace `loadWorkPrevious` and `revertWork`. The header's
**History** opens `WorkHistoryDialog`: every point newest first
(`historyRows` hides a `checkpoint` that repeats the row before it), a
comparison with the previous point or any chosen one, and restore of any
checkpoint. Docs compare block by block (`markdownBlockDiff`, rendered) or as a
source diff; diagrams mark changes on `DiagramPreview` (`marks`); artifacts show
two renders. "What the agent changed" is the newest point against the one before
it. `WorkPaneContext` gives the header the pane's base content version.

**Phase 2.** `commenter` is in `shareRoleSchema` and `resourceRoleSchema`;
`applyWorkComment` and `workReviewDecide` need it. Table `work_reviewers`
(sqlite `0029`, postgres `0018`); domain `data/works/work-reviews.ts`; handlers
`transport/handlers/work-review-handlers.ts` on the host and the Solus
API; topic `workReviews.changed`. `Work.checkpoint` reuses a checkpoint of
the same body and reason. `workReviewDecide` takes a target: a checkpoint, or
the current body at the version the reviewer read (checkpointed first, refused
if it moved). `workReviewStates` feeds the gallery. The agent tool
`request_work_review` goes through `WorkspaceOperations` and the HTTP route
`POST /v1/works/{workId}/review-requests`. The renderer store is
`WorkReviewsStore` (`worksStore.reviews`); both boots call
`subscribeWorkReviewChanges`. Notice setting: `work_review`.
Decisions taken: only a commenter or higher comments (open decision 5); on a
Local work, **Copy review link** opens the Share dialog to publish first (open
decision 1). The host has no organization directory, so a request carries each
reviewer's directory name as a hint; the reviewer's own admitted name replaces
it when they decide, and clients show the directory's current name.
**Send open comments to agent** resumes the work's newest session
(`sendMessageToWorkSession`) and leaves the threads open for the agent to
resolve; the older rail buttons still resolve on send.
Not done: user ids on push subscriptions, so an offline member gets no push.

**Phase 3a.** `{ kind: 'work', workId }` focus and `presenceSetEditing` (the
typing rule, `TYPING_EXPIRY_MS` on the host). `WorkPresence` in the header, faces
on the gallery row, "Editing <work>" and jump-to in the phone roster, and follow
mode into works. The pane reports editing when it saves.

**Phase 3b.** Host: `packages/server/src/work-live/` — `WorkLiveManager` (rooms,
pushes stored with their receipt in `work_live_docs` before the answer, relay
to the room only, projection 800 ms after the last push and at least every
4 s, the agent edit lock), `live-codec.ts` (seed, projection of a copy, and
structural absorb with `updateYFragment` for documents, field diffs for
diagrams), `live-store.ts`. Table `work_live_docs` (sqlite `0030`, postgres
`0019`). RPCs `workLiveOpen/Push/Awareness/Close`; topics `workLive.update`,
`workLive.awareness`, `workLive.state`, audienced by work and published to the
room's clients. `Work.find`, `loadWork`, duplicate, and Share export flush the
live doc first; `Work.updateContent` and `restoreRevision` go through
`WorkLiveBridge.write`, which takes the lock, flushes, checks the version
(rule 12), writes, and folds the body into the doc after commit. A lock whose
write never commits ends after 30 s. The diagram model is
`contracts/diagram-live.ts` (`__order` keeps node order). Live topics, and a
session's streamed events and presence, go through
`HostEventPublisher.publishToRoom`: the audience check runs on each member's
first event in the room (`RoomAdmissions` remembers a pass, never a refusal)
and again after any share or task change. On a share change,
`WorkLiveManager.revalidate` removes who can no longer open the work and makes
read-only who can no longer edit. Clients:
`WorkLiveDoc` (provider, push queue with sequence numbers, retry on `locked`,
reconnect with state-vector exchange, awareness at most every 100 ms),
`WorkLiveStore` (`worksStore.live`, one doc per host and work),
`DocumentEditor` with Collaboration and CollaborationCaret (Collaboration's
undo replaces `UndoRedo`), `DiagramLiveHistory` (Y.UndoManager scoped to the
reader's origin) behind `DiagramDocument`, selection outlines
(`DiagramLivePresence`), and `liveStatus` in both headers. A host from before
live editing answers `unsupported`, and the pane saves whole bodies as before.
Open decision 4: the Markdown source stays editable in a live document; each
edit is applied as a structural change, and a host update waits until the
pending Markdown edit is applied, then refreshes the source.

**Phase 3c.** `y-indexeddb` keeps each live doc per host and work
(`work-live-offline.ts`), with the client key, sequence, and unsent count; a
list in local storage names the works with unsent edits. Signing out, or
removing a host, asks before it deletes them (`askBeforeDiscardingUnsent`).

Limits of what landed:
- Share (Move into an organization) does not carry the Yjs state: the
  organization's copy starts a new live doc from the body, so edits a device
  made offline against the machine's copy do not merge after the move.
- The agent edit lock covers the write, not the whole streaming tool call, and
  the agent is named in the status line, not in the avatar stack.
- Diagrams on a phone keep the current behavior (open decision 2). Viewers
  and commenters open the full diagram shell (header, History, Review, threads)
  over a read-only canvas, with the reason in the header: a commenter comments
  and reviews, a viewer reads the threads and writes none. Nothing a reader
  does is saved or pushed.

The product work then has three phases, in this order:

1. **Revision history**: authored revisions that a review can point at.
2. **Work review**: reviewers, decisions, stale approvals, and the inbox.
3. **Live editing**: presence on works, live edits for docs and diagrams, and
   offline edits.

Review does not need live editing. It needs only revision history. Review gives
value sooner and has less risk, so it comes first.

## Vocabulary

Use these terms in code, UI, and conversation. Do not make synonyms.

- **content version**: a monotonic version of the current body. Every accepted
  body change advances it, including a human save without a history snapshot.
  Code: `contentVersion`. This is the precondition for an agent write.
- **revision**: one saved version of a work's content, with its author and
  the reason it was made. Code: `WorkRevision`. This expands the existing
  `work_revisions` row.
- **review request**: an owner or editor asks a person to review a work.
  Code: `WorkReviewRequest`.
- **reviewer**: a person with a review request on a work, or a person who
  gave a decision through a review link. Code: `WorkReviewer`.
- **review decision**: `approved`, `changes_requested`, or `commented`, with an
  optional summary. It always names the revision it applies to.
  Code: `WorkReviewDecision`.
- **stale decision**: a decision on a revision whose content is not the
  current content. The UI says "Approved an earlier version".
- **review state**: the work's overall state: `draft`, `in_review`,
  `changes_requested`, or `approved`. It is always derived and never stored.
  Code: `WorkReviewState`.
- **review link**: a share link with the `commenter` role. Anyone who opens it
  can comment and give a decision.
- **commenter**: a new share role between `viewer` and `editor`. A commenter
  can read, comment, and give a review decision, but cannot edit.
- **live doc**: the shared, mergeable state of one work while people edit it
  live. Code: `WorkLiveDoc`. Do not call it a "session". In Solus, a session
  is an agent conversation.
- **agent edit lock**: the short period while the agent writes a work. During
  this period, the work is read-only for people and shows "Agent is editing".

## Product rules

1. **Review is information only.** A review decision does not block publishing,
   does not change a task's status, and does not stop an agent. No reviewer is
   required. The review state is a label, not a gate.
2. **A decision applies to one revision.** Each decision records the revision
   and its content hash. When the current content hash is different, the
   decision is stale. A stale decision stays visible, but it does not count in
   the review state. If an edit is undone and the content returns to the
   approved hash, the approval is current again.
3. **Re-request review.** When the reviewer's decision is stale, the owner or
   an editor can re-request a review from that reviewer. The reviewer then sees
   **changes since my last review**.
4. **Review state derivation.**
   - `draft`: no reviewers.
   - `changes_requested`: one or more current `changes_requested` decisions.
   - `approved`: one or more current `approved` decisions, and no current
     `changes_requested`.
   - `in_review`: all other cases.
5. **Reviewers inside and outside the organization.**
   - An organization member is assigned by user id from the organization
     directory.
   - A person outside the organization reviews through a review link, and can
     be anonymous. The host names that person from the guest grant (the typed
     display name). A client never names itself.
6. **Comments are the review threads.** Review uses the comment threads that
   exist now on docs, diagrams, and artifacts. It does not add a second comment
   system.
7. **The agent can address feedback.** One action sends the open threads to
   the work's session. The agent edits the work and replies in each thread with
   the tools that exist now (`comment_document`, `reply_comment`,
   `resolve_comment`).
8. **Artifacts:** presence, comments, and review. No live editing. Artifacts
   stay view-only for people; only the agent writes them.
9. **Slides are out of scope** for this plan.
10. **Google-linked works are out of scope for live editing.** They are
    read-only in Solus. People can still comment on them and review them.
11. **Concurrent edits always merge to the same result on every client.**
    Compatible edits are preserved. A delete can remove a concurrently edited
    paragraph or node. Concurrent assignments to the same field have one
    winner. Recovery is limited to edits retained by undo or saved checkpoints;
    history does not record every discarded concurrent value. See
    "Concurrent edits" in phase 3b.
12. **The agent never overwrites edits that it did not see.** An agent write
    carries the content version that the agent read. If the host accepted a
    body change after that version, it rejects the write and the agent must read
    again. Offline edits not yet received by the host merge on reconnect.
13. **Per-person undo.** `mod+z` undoes only the edits of the person who presses
    it, never a teammate's or the agent's edits.
14. **Offline edits stay until reconnect.** A client keeps its unsent edits on
    the device for as long as it is offline, including over a restart. When the
    connection returns, the edits merge. The UI always shows "Offline" or
    "Reconnecting" and the number of unsent edits.

## Current state

The facts that this plan depends on:

- **Storage.** A work is one row of `works`. The content is a markdown string
  for docs, a JSON `{nodes, edges}` for diagrams, and HTML for artifacts
  (`packages/server/src/data/works/schema.ts`).
- **Revisions.** Each agent save adds a `work_revisions` row, and nothing
  deletes old rows. A user save adds no row. The UI reads only the newest row
  ("what the agent changed", revert). Revert currently mutates that newest
  snapshot in place, so history is not immutable yet
  (`packages/server/src/data/works/works.ts:163-258`).
- **Saves replace the whole content.**
  - The doc editor saves `editor.getMarkdown()` after 350 ms
    (`components/editor/DocumentEditor.svelte`).
  - The diagram editor saves the serialized document after 600 ms
    (`components/diagram/DiagramShell.svelte`).
  - Both call `saveWork(id, {content}, expectedUpdatedAt)`. The server rejects
    the save if `updatedAt` changed (`works.ts:319`).
- **Agent writes replace the whole content** through `update_work`
  (`packages/server/src/execution/agents/tools/work-tools.ts`). An open editor
  learns about it from a `work_updated` session event. A clean editor remounts,
  and a dirty editor shows a conflict pill (`components/work/WorkPane.svelte`).
  User saves are not sent to other clients.
- **Comments.** Anchored threads on all work types, with author, resolve, and
  per-person read marks (`PlanComment` in `packages/contracts/src/types.ts`).
  `applyWorkComment` requires the `editor` role
  (`packages/server/src/admission/access-policy.ts:160`). A viewer cannot
  comment today.
- **Sharing.** Roles are `viewer` and `editor`. A share link (`everyone`
  subject) can admit an anonymous guest, but only on the cloud Solus
  API (`packages/server/src/transport/http.ts:533`). A Local work is
  reachable only by the host owner and share-listed members.
- **Organization directory.** `GET /v1/orgs/:organizationId/directory` lists
  members and teams. The share dialog already uses it through `directoryFor`
  (`contexts/sharing/shares.store.svelte.ts`).
- **Notifications.** Attention is only for sessions
  (`packages/contracts/src/attention-types.ts`). A browser notification
  comes only from an open Solus tab, and there is no web push. Nothing can notify
  one particular person. There is no native mobile push; mobile is the
  responsive web client.
- **Presence.** It runs only in memory. The focus is `session` or `none`
  (`packages/contracts/src/presence.ts`).
- **Client storage.** localStorage only. No client uses IndexedDB, and the
  service worker caches nothing.
- **Libraries.** `yjs` and `@tiptap/extension-collaboration` are root
  `devDependencies`, but no code imports them.

## Phase 1: revision history

### Features

- A **History** list on each work: every revision with its author, time, and
  reason (`agent`, `review`, `restore`).
- A diff between any two revisions, and between a revision and the current
  content.
  - Docs: a rendered markdown diff.
  - Diagrams: added, removed, and changed nodes and edges, marked on the canvas.
  - Artifacts: the two renders side by side.
- **Restore** any revision. A restore adds a new revision; it deletes nothing.
- "What the agent changed" becomes "changes since the revision before this
  agent save". It works the same as today.

### Model

The [foundation plan](work-editing-foundation.md#1-give-one-work-a-class-and-separate-versions-from-history)
owns the storage change. `Work` provides immutable revisions with source
content version, author, reason, and content hash. Use `documentContentHash`.
The current body's `contentVersion` is separate from a history revision id.
Legacy authors and source versions remain unknown where they cannot be proved.

Agent saves, upstream pulls, and restores preserve the displaced body and
checkpoint the resulting body. An explicit `previousRevisionId` keeps the
existing comparison and revert behavior; the latest history row is no longer
assumed to be the previous body. Review requests also checkpoint the exact body
being reviewed. Normal human saves advance `contentVersion` without adding a
history row. Do not add timed checkpoints now.

### Agent base content version (rule 12)

`read_work` returns `content_version`. `update_work` requires
`expected_content_version` from that read. The `Work` mutation checks it inside
the write transaction. On mismatch, the agent must read again. A fresh read
inside the update tool must never silently replace the original precondition.
This applies to direct API calls and queued outbox updates alike.

The gap is confirmed: the current update tool reads a fresh `updatedAt` just
before saving, which does not protect edits since the agent's earlier read.

## Phase 2: work review

### Features

**Request a review**
- A **Review** control in the work header, with an avatar and a decision
  state for each reviewer, and the overall review state.
- Add reviewers from the organization directory, with an optional message.
- **Copy review link** for people outside the organization.
- Remove a reviewer, and re-request a review (reverse states).
- The same commands are in the command palette, and in the context menu of a
  work card in the works gallery.
- The agent can request a review with a new work tool, `request_work_review`.
  The tool takes the work and the member ids.

**Give a decision**
- Approve, Request changes, or Comment, with an optional summary.
- A reviewer can change their decision at any time. The newest decision
  replaces the older one.
- A reviewer who returns after edits sees **changes since my last review**:
  the Phase 1 diff from their reviewed revision to the current content.

**See what needs you**
- A **Needs my review** filter in the works gallery, and a count badge.
- The work card shows the review state.
- Mobile shows the same inbox and all decisions. A reviewer can read, comment,
  and decide from a phone.

**Address feedback**
- **Send open comments to agent** sends the open threads to the work's
  session, or starts a session when the work has none.

### Model

One new table, `work_reviewers`. It has one row for each reviewer on each work.

| column | meaning |
|---|---|
| `work_id`, `reviewer_id` | Primary key. The reviewer id is a user id or `guest:<id>`. |
| `display_name`, `color_index` | Stamped by the host from the principal. |
| `requested_by`, `requested_at`, `request_message` | Null for a person who reviewed through a link without a request. |
| `requested_rev` | The fixed checkpoint for the current request; set on request/re-request and returned to the reviewer. Null when there was no request. |
| `decision`, `decision_summary`, `decided_at` | Null until the first decision. |
| `decided_rev`, `decided_content_hash` | The revision that the decision applies to. |
| `organization_id` | The work's organization, as for every work table. |

The review state and staleness are derived on read from `decided_content_hash`
and the current content hash. Nothing is stored twice.

A review request adds a revision with the reason `review` and stores its id
in `requested_rev`, so the reviewer opens that fixed version. Re-requesting
sets a new requested checkpoint but preserves the last decision and its
`decided_rev` for the changes-since-last-review comparison.

### Roles

- Add `commenter` to `shareRoleSchema` and `resourceRoleSchema`, between
  `viewer` and `editor`.
- Change `applyWorkComment` and the new decision call to require `commenter`.
- A review request to a member who has no access shares the work with that
  member as a commenter.
- Request, remove, and re-request require `editor`.

### Contracts

Add these calls to `packages/contracts/src/rpc.ts` on the `collaboration`
plane:
- `workReviewGet(workId)` returns the reviewers, their decisions, staleness,
  and the review state.
- `workReviewRequest(workId, reviewerIds, message?)`
- `workReviewRemove(workId, reviewerId)`
- `workReviewDecide(workId, revisionId, decision, summary?)`: the host takes
  the reviewer from the principal and the hash from that work's immutable
  revision. It never substitutes the latest revision. If the reviewer chooses
  the current edited body, checkpoint it against the version they saw first.
  A decision on an older revision can be recorded as stale.
- `workReviewInbox()`: the works that wait for the caller's review.

Add the topic `workReviews.changed`. It has the same audience as
`annotations.changed`: everyone with a role on the work.

The renderer state goes in a `workReviews` store beside `works.store`.

### Notifications

Nothing can notify one particular person today. The first step:
- An in-app inbox and badge on every connected client.
- A toast when a review request or a decision arrives for the caller.

Then add a user id to the push subscriptions on the Solus API, so that
"Review requested" and "Changes requested" can reach a member who is offline.
A person outside the organization gets no notification; the owner sends the
review link.

## Phase 3: live editing

### 3a. Presence on works

- Add `{ kind: 'work', workId }` to `presenceFocusSchema`.
- The work header shows an avatar stack. "Jump to" in the host roster opens
  the work.
- This can ship before 3b, together with Phase 2.

**Typing indicator.** All typing indicators in Solus use one rule. Sessions
already use it (`contexts/presence/typing-reporter.ts` and
`PresenceManager.setComposing`):
- The client reports typing on the first keystroke after a pause. While the
  person continues to type, the client reports again at most once each 3 s
  (`TYPING_REPEAT_MS`).
- The host clears the mark 5 s after the last report (`TYPING_EXPIRY_MS`),
  and tells the room. The timer is on the host, so every client sees the same
  state, and a client that joins late gets it in its first snapshot.
- The client sends a stop when typing ends on purpose. For a work, that is:
  the person closes the work, or the work goes out of view. A disconnect
  clears the mark.

For works, the same rule sets an `isEditing` flag for the works gallery and the
host roster. Inside an open doc, the Yjs updates already repeat while a person
edits, so a receiving client clears the "editing" label 5 s after the last
update from that person, and sends no extra message.

### 3b. Live edits for docs and diagrams

**Model.** Each work that people edit live has a Yjs document.
- Docs: a `Y.XmlFragment` bound to Tiptap through
  `@tiptap/extension-collaboration`.
- Diagrams: a `Y.Map` of nodes and a `Y.Map` of edges, keyed by id. Each node
  and edge is a `Y.Map` of its fields. Two people who edit different nodes do
  not conflict. If two people change the same field, one value wins, and every
  client sees the same winner.
  - `DiagramDocument` owns semantic edits and binds them to Yjs transactions.
    `DiagramShell` renders its projection; it does not own a second document.
    Nested detail uses the same node/edge field model as the root, not one
    whole-document field.
  - A node's position is **one value** `{x, y}`, never two fields. With two
    fields, two drags at the same time can merge to a position that nobody
    chose.
  - An edge is valid only when both of its end nodes exist. The renderer and
    the host's `works.content` copy drop an edge whose node was deleted at the
    same time.
- The Yjs state is kept in a new table, `work_live_docs`, with the columns
  `work_id`, `state`, `updated_at`, and `organization_id`.
- The `works.content` column stays the readable copy for agents, export,
  search, and preview. The host writes it from the live doc when the edits
  pause. The host owns this conversion, so the agent always reads the same
  content that people see.

**Architecture.**

```text
CLIENT (desktop, web, mobile)                      HOST (local host, or Solus API for org works)
┌───────────────────────────────────────┐          ┌─────────────────────────────────────────────┐
│ DocumentEditor (Tiptap + Collaboration)│          │ WorkLiveManager  (memory, one room per work) │
│ DiagramDocument (Y.Map commands)       │          │  • one Y.Doc per open work                   │
│            │                           │          │  • room = clients that opened the work       │
│            ▼                           │  RPC     │  • apply update → send to the room           │
│ WorkLiveDoc store (contexts/works/)    │ ───────▶ │  • awareness: cursors, in memory only        │
│  • Y.Doc + Awareness                   │ workLive │  • agent edit lock                           │
│  • unsent-update queue                 │ Open /   │             │                                │
│  • connection state                    │ Push /   │             ▼  durable state + receipt       │
│            │                           │ Awareness│ work_live_docs   (durable Yjs state)         │
│            ▼                           │          │ works.content    (markdown / JSON copy,      │
│ IndexedDB (y-indexeddb): offline edits │ ◀─────── │                   written when edits pause)  │
└───────────────────────────────────────┘  topics  │             ▲                                │
                                    workLive.update │ update_work (agent) ── diff into Y.Doc       │
                                 workLive.awareness └─────────────────────────────────────────────┘
```

Parts:
- **`WorkLiveDoc` store** (client, `contexts/works/`). It owns one `Y.Doc` and
  one awareness object for each open work, the IndexedDB copy, the queue of
  updates the host has not confirmed, and the connection state that the header
  shows. Editors bind to it; they never call the host directly.
- **`WorkLiveManager`** (host). A focused manager, similar to
  `PresenceManager`. It keeps one `Y.Doc` in memory for each work that one or
  more clients have open, and the room of those clients. It applies updates,
  sends them to the room, keeps awareness in memory, holds the agent edit
  lock, and writes the stored state.
- **Handler** (`transport/handlers/work-live-handlers.ts`). It checks access
  and passes calls to the manager.

**Owner.** The host that stores the work owns its live doc. For a Local work,
that is the local host. For an organization work, it is the Solus API.
Clients hold copies.

**Sync.** It goes through the typed RPC layer and `eventsFor(serverId)`, so it
works the same over Electron IPC and WebSocket, and for local and remote
hosts:
- `workLiveOpen(workId, stateVector)` joins the room. It returns the updates
  that the client does not have, and the host's state vector, so the client
  can send the updates that the host does not have.
- `workLivePush(workId, update)` sends the client's updates.
- `workLiveAwareness(workId, state)` sends this client's cursor and selection.
  The client sends it at most once each 100 ms, and only when the cursor moves.
- `workLiveClose(workId)` leaves the room. A disconnect also leaves it.
- The topic `workLive.update` sends updates to the other clients in the room.
- The topic `workLive.awareness` sends cursors and selections. It never goes
  to disk.

Whole-content writes still pass through `Work`. Artifacts keep agent writes.
Google-linked works remain read-only in Solus; only an upstream pull may
replace their body.

**Rules.**
- **Only the room receives updates.** The room is the clients that opened the
  work, not everyone who has a role on it. This keeps traffic low when many
  people can see a work.
- **The access check runs on each push.** An editor can push updates. A
  commenter or a viewer can open the work and receives updates, but cannot
  push. A guest stays limited to the one work that was shared with them.
- **The host confirms each push.** The client removes an update from its
  queue only after its state and retry receipt are durably committed. A host
  restart cannot lose an acknowledged edit. A lost response causes a safe retry;
  markdown projection may be debounced separately.
- **Ordinary edits send deltas.** A client sends
  small incremental updates during ordinary editing. Initial sync or a client
  with no state can require a full state transfer. If the host has no live
  state, the host alone initializes it from `works.content`; clients do not
  independently seed duplicate initial content.

**Flows.**
1. **Open.** The client loads its IndexedDB copy and shows it at once. Then it
   calls `workLiveOpen` with its state vector. Each side sends only the updates
   that the other side does not have.
2. **Edit.** A local change becomes a small Yjs update. The client writes it to
   IndexedDB and sends it with `workLivePush`. The host applies it to its
   `Y.Doc`, durably commits the accepted state and receipt, and sends the update
   to the other clients in the room. When edits pause, it refreshes `works.content`.
   Agent reads, exports, and review checkpoints must obtain a projection that
   matches the returned content version even before that debounce fires.
3. **Offline.** Updates collect in IndexedDB and in the queue, also across a
   restart. The header shows "Offline" and the number of unsent edits. When
   the client reconnects, flow 1 runs again and the edits merge.
4. **Agent write.** The host acquires the agent edit lock and checks the content
   version from the agent's read under that lock (rule 12). It tells the room
   and applies the new
   content to the `Y.Doc` as a diff (see "Agent edit lock" below), sends the
   update to the room, and releases the lock.
5. **Last client leaves.** The host writes the state, compacts it, and removes
   the `Y.Doc` from memory.

**Cursors.** Live cursors and selections in docs, with each person's name in
their presence color. On diagrams, the node a person selected or drags has an
outline in their color.

**Per-person undo.** Use the Yjs undo manager, which tracks only local
changes. It replaces Tiptap's history extension on live docs.

**Agent edit lock.**
- While an `update_work` call streams, the work is read-only for people. The
  header shows "Agent is editing", and the agent shows in the avatar stack.
- The host applies the new content to the live doc as a diff, not as a full
  replace. For docs, this is a structural ProseMirror diff. For diagrams, it
  is a diff by node and edge id. So cursors stay in place, and offline edits
  still merge.
- Rule 12 still applies. A later phase can remove the lock and let agent edits
  merge like a person's edits.
- The lock is enforced in the client editor (it becomes read-only), not only
  on the host. A write already in flight or made offline stays queued when the
  host answers "locked". That answer is retryable. After unlock, the client
  reconciles and merges its pending updates; it never resets its Y.Doc or drops
  a refused update that later edits depend on. The owner serializes lock
  acquisition, the content-version check, and the agent commit.

**Concurrent edits.** Yjs is a CRDT: every client applies the same updates and
gets the same document, with no locks and no conflict dialog. For the user
this is the same class of experience as Google Docs. (Google Docs uses
operational transformation on a central server; Yjs lets each client merge by
itself, which is what full offline editing needs.) The spike confirmed:

| Case | Result |
|---|---|
| Both people type at the same position | Both texts are kept, each as one run, in the same order on every client. |
| Edits at different positions in one paragraph | Both merge. |
| One person formats a range while the other types in it | Both are kept. The new text also gets the format. |
| Overlapping deletes | The union is deleted. |
| Offline edits after a long time | They merge on reconnect. |
| Undo after a merge | It reverses only the local person's edits. |
| One person deletes a whole paragraph while the other types in it | **The typed text is lost.** In the Tiptap model a paragraph is one element, and deleting it deletes its content. Undo and history can restore it. |
| Two people set the same diagram field | One value wins on every client. The other value is lost. |
| One person deletes a node while the other renames it | The node stays deleted. The rename is lost. |

Cursors and selections are the main way to prevent these cases: people see
each other and avoid the same place.

**Tiptap packages.** We use Tiptap's editor-side collaboration packages, but
not its sync server:

| Part | Package | Status |
|---|---|---|
| Editor to Y.Doc binding | `@tiptap/extension-collaboration` with `@tiptap/y-tiptap` | Installed, not used yet |
| Per-person undo | Collaboration's undo. Turn off StarterKit's `undoRedo` in live docs. | Installed |
| Cursors and name labels | `@tiptap/extension-collaboration-caret` | To add |
| Offline storage | `y-indexeddb` | To add |
| Sync provider | Our own `WorkLiveDoc` provider over the typed RPC | To write |
| Host | `yjs` in `WorkLiveManager` | Installed |
| Diagrams | `DiagramDocument` commands bound to `Y.Map` | To write |

**Spike results.** Two spikes ran with the same scenarios: our own provider
over a WebSocket that works like the planned RPC calls, and Hocuspocus 4.7.0
(Tiptap's sync server, MIT). Both passed all their tests (31 and 24).

The experience is the same, because merges, cursors and undo come from Yjs and
the Tiptap binding, not from the sync layer:

| Measure (localhost) | Our own provider | Hocuspocus |
|---|---|---|
| Median time for an edit to reach the other client | 0.2 ms | 0.1 ms |
| Bytes per keystroke, sender to host | 156 B (JSON + base64) | 28 B |
| Cursor messages per second | 10 (throttled) | 58 by default, 10 with a throttle |
| Edits lost or duplicated after a dropped connection | None | None |
| Unsent edits after an app restart | Kept | Lost without `y-indexeddb` |
| Integration code | 353 lines | 213 lines |

**Decision: our own provider over the typed RPC.** Hocuspocus is a second
protocol and socket beside our RPC. With it we would still build ticket
checks when the socket opens, disconnection when access is removed, tunnel
routing, a real edit lock (it has none, and a refused write blocks that
client's later edits until it reconnects), and offline storage. Our own
provider reuses our auth, access policy, logs and transports. From Hocuspocus
we copy the save timing (a debounce with a maximum wait, and save and unload
when the last client leaves) and the reconnect backoff.

**Rules from the spikes.**
- **Schema version check (critical).** An editor or host whose schema does not
  know a node or mark type deletes that content from the shared doc, and the
  deletion goes to everyone. On the host, one unknown mark deleted a whole
  paragraph. So:
  - `workLiveOpen` sends the client's schema version. The host refuses a
    client with a different version, or opens it read-only.
  - The host converts a **copy** of the Y.Doc to markdown, never the live doc.
- **One schema list for the editor and the host.** The host conversion works
  in Node without a DOM. But `mermaidBlockExtension.ts`,
  `htmlBlockExtension.ts`, `diagramEmbedExtension.ts`,
  `artifactEmbedExtension.ts`, `frontMatterExtension.ts` and `codeBlockView.ts`
  import Svelte at the top of the module. Move their schema parts into
  modules without Svelte, as `lib/front-matter.ts` already does.
- **Comment highlights are local decorations,** not document content.
  Otherwise `planComment` marks would become shared content. The foundation
  also keeps `asset://` references in document nodes and resolves display URLs
  only in image views.
- **Viewers and commenters open the editor read-only.** Otherwise their local
  edits wait in the queue forever.
- **Keep the protocol small.** The spike sent about 8 times the Yjs payload.
  Bind the client key at open, merge queued updates with `Y.mergeUpdates`
  while a push waits, and batch confirmations.
- **Save the duplicate check with the doc.** The host keeps the last sequence
  number for each client, so a resent edit is not relayed twice. Save it with
  the Yjs state, or a host restart relays resent edits again.
- **First live save.** No content is lost, but the first save changes the
  formatting of each existing work: soft line breaks are joined, tables are
  re-padded with a blank line around them, `*` bullets become `-`, `[^1]` is
  escaped, and the trailing newline is removed. The output does not change
  after that.

### 3c. Offline edits

- Each client keeps its live docs in IndexedDB (`y-indexeddb`), keyed by host
  and work. This includes desktop, which uses the same Chromium storage.
- Offline edits stay on the device until the client reconnects, including over
  a restart. They are sent after `workLiveOpen`.
- The work header shows "Offline, 3 unsent edits" or "Reconnecting". A work
  with unsent edits never shows "Saved".
- Signing out, or removing a host, asks before it deletes unsent edits.

## Surfaces

- **Clients:** desktop, web, and mobile (the responsive web client) for all
  phases. Mobile gets the review inbox, decisions, comments, presence, and live
  editing. On a phone, a diagram can be viewed and reviewed, but it stays
  read-only.
- **Entry points:** the work header, the works gallery (filter, badge, card
  menu), the command palette, and the host roster (jump to).
- **Providers:** Claude and Codex use the same work tools, so rule 12, the
  agent edit lock, and `request_work_review` apply to both. They need no
  provider-specific behavior.
- **Connection modes:** Local works on desktop-local and desktop-hosted
  connections; organization works on the Solus API. A remote web client
  must use RPC for all of it, and never a local path.
- **Reverse states:** remove a reviewer, re-request, change a decision, restore
  a revision, and delete unsent offline edits.
- **Docs:** a user-visible guide in `docs/` when Phase 2 ships.

## Open decisions

1. **An external review of a Local work.** Only the Solus API can
   admit a guest. The existing Share flow moves a Local work into an
   organization. Recommendation: on a Local work, **Copy review link** first
   runs Share with a commenter link, and says that the work moves. The
   alternative is guest admission on a personal host, which is new security
   work.
2. **Diagrams on a phone.** This plan makes diagrams read-only on mobile.
   Confirm.
3. **Server-side markdown conversion.** Decided: the host converts. The spike
   proved that it works in Node without a DOM (see "Spike results").
4. **Raw markdown during live editing.** Preserve it in the foundation.
   Before live editing ships, implement structural diffs into the shared doc
   or obtain an explicit product decision to restrict raw editing. The current
   whole-document `setContent` path is not a safe default for collaboration.
5. **The new commenter role and viewers.** Can a viewer comment after this
   change, or only a commenter? Recommendation: only a commenter, so "viewer"
   keeps its current meaning.

## Risks

- **Schema mismatch.** A client or host with a different schema deletes
  shared content. The schema-version check and the conversion of a copy are
  required (see "Spike results").
- **Markdown round trip.** The spike measured it: no content is lost, but the
  first live save changes the formatting of every existing work. The output
  does not change after that. Fix the table alignment-row padding before 3b.
- **Performance.** Updates and cursors go to every client that has the work
  open. Send updates in batches, limit how often cursors are sent, and never
  send the full content when a small update is enough.
- **Stored state size.** Yjs state grows with history. Compact its stored
  representation when the last client leaves while preserving CRDT identity.
  Do not recreate a new document from markdown: old offline updates must still
  merge. The same identity requirement applies when Share moves a live work.
