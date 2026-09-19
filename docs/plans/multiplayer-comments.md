# Multiplayer comments: people on threads, and threads on artifacts

**Status:** Implemented, first slice (2026-09-18).
**Companions:** `docs/plans/multiplayer-sharing.md` (who may open a work), `docs/plans/multiplayer-presence.md` (who a person is on a host, and their colour).

A comment thread on a shared work is a conversation between people, so it needs what a prompt bubble and a presence stack already have: the host says who wrote each message, every reader sees the same thread at the same time, and nobody can write over anybody else. This slice gives that to the threads on documents, slides, and diagrams, and adds threads to artifacts, which had none.

## 1. Vocabulary

- **thread** — one `PlanComment`: a head message and its replies, on one anchor.
- **anchor** — what a thread is on: a quoted run (documents), a node or edge (diagrams), a **pin** (artifacts), or the whole work.
- **pin** — a point over an artifact's render, kept as fractions of the render's width and height (`CommentPin`). A pin is numbered by its place among the render's pins; "Pin 3" in a card and the dot marked 3 are always the same thread.
- **person** — the host-stamped identity on a human message (`TurnAuthor`: user id, display name, avatar, colour), the same one a prompt bubble carries. Absent on a plan, on the host's own work, and on every thread written before this slice.
- **command** — one change to a work's threads, sent by a client and applied by the host (`WorkCommentCommand`).
- **read mark** — one person's last read of a thread (`readBy`). `readAt` stays as the single-reader mark a plan keeps.
- **moderator** — who may edit or delete another person's thread: the work's owner, or a host admin.

## 2. Rules

1. **The host names people.** A client sends what a thread is on and what it says; the host stamps `author: 'you'`, `person`, and `createdAt` from the admitted principal (`turnAuthorFor`). The wire schema strips anything a client claims about who wrote it.
2. **Every change is a command, never the whole sidecar.** `applyWorkComment(workId, command)` reads, applies, and writes with no await between, so two people commenting at once each land on the other's result instead of over it. `saveWorkAnnotations` is gone from the RPC surface; the agent's tools still write the sidecar directly on the host.
3. **A thread is its author's.** Its author edits and deletes it; a moderator may tidy anyone's; an agent's note belongs to nobody in particular, so any editor may. A thread from before works had people is the moderator's. Replying and resolving are any editor's, and both carry who did them (`person` on the reply, `resolvedByPerson`).
4. **Read marks are per person.** `read` writes the caller's entry in `readBy`; a reply does too, because answering is reading. Unread means someone else — an agent or another person — spoke after the reader's own mark; the reader's own words are never unread to them. A reader who does not yet know their own ids counts only the agent.
5. **Commenting takes an editor; reading takes a viewer.** `applyWorkComment` is resource-classed editor on the work, `markWorkCommentRead` viewer, so a viewer keeps their place in a conversation they cannot join. A guest has the role of its link. This follows the existing decision that changing a task or a work takes an editor; a "can comment" role between viewer and editor is a product question this slice does not answer.
6. **Everyone who can open the work hears the change.** The host emits `annotations.changed` for every command (it already did for the agent's), the audience is the work's (`eventResource`), and every open surface re-reads. Re-reading reconciles by thread id (`reconcileComments`), so an untouched thread stays the same object and one person's reply does not repaint every card.
7. **The reader's own thread carries no byline.** As before: in a one-person document "You" tells the reader nothing. Another person's thread carries their face in their presence colour and their name; an agent's its spark. The verbs Edit and Delete are offered only where the host would allow them.
8. **A pin rides the render.** It is a fraction of the render's box, so it lands on the same spot at every pane width and on every device; a render that reflows its own layout at a new width moves the content under a pin, which is the trade this slice accepts for anchors that need nothing from the sandboxed frame. A thread with no pin is a note on the whole render — what `comment_document` leaves on an artifact, since there is no prose to quote.

## 3. Contract and host

- `packages/contracts/src/types.ts`: `PlanComment.person`, `pin`, `readBy`, `resolvedByPerson`; `PlanCommentReply.person`; `CommentPin`, `CommentReadMark`.
- `packages/contracts/src/comment-commands.ts`: `workCommentCommandSchema` (`add`, `edit`, `delete`, `reply`, `resolve`, `read`, `resolve-open`), `CommentActor`, `applyCommentCommand`, `mayChangeThread`, `CommentCommandError`. The reducer lives beside the schema because the host, the demo backend, and the tests must agree on one answer to "may this person do this to that thread".
- RPC: `applyWorkComment(workId, command)` and `markWorkCommentRead(workId, commentId)`, both answering the whole `WorkAnnotations`. `saveWorkAnnotations` removed.
- Host: `packages/server/src/folio/work-annotations.ts` `applyWorkComment`; `folio-handlers.ts` builds the actor from the principal and the share list (`canModerate` = host admin or the work's owner); `access-policy.ts` classifies both methods.
- Agent tools (`annotations/comment-tools.ts`): `read_work` names the person on a thread and says where a pin is ("At 30% across, 20% down the render"); `comment_document` on an artifact skips text anchoring and leaves a whole-render note.

## 4. Clients

One implementation in `packages/workspace-ui`, so desktop, web, and the mobile web client behave alike.

- `contexts/works/works.store.svelte.ts`: every thread method is a command — shown at once, reconciled with the host's answer, re-read if refused. `watchAnnotations(workId)` re-reads on `annotations.changed`; `resolveOpenAnnotationComments` settles a round of feedback handed to an agent (the diagram used to clear its threads; it now resolves them, as the document does, so the record stays for everyone).
- `components/comments/lib/thread.ts`: `isOwnMessage`, `messagePerson`, `canChangeThread`, `isUnread(comment, selfIds)`, `authorLabel(message, selfIds)`. `lib/comment-viewer.ts`: the reader (`selfUserIds` from presence, `canModerate` from the share list) as a Svelte context, set by each shell and read by the card, so the rail and layer between carry nothing they do not read.
- `CommentThreadCard`: a person's byline (`PresenceAvatar` + name) on someone else's head and replies; verbs gated by `canChangeThread`. The diagram's Comments tab and pins take the same `selfIds`.
- **Artifacts** (`components/artifact/`): `ArtifactCommentLayer` over the render — pins in their author's colour (accent for an agent, sage when settled), the composer where a pin was dropped, one open thread's card placed by the diagram's `placeThreadCard`, and a list of every thread including whole-render notes. The layer lets pointer events through to the frame until the pin tool is armed; then the next click drops a pin. `ArtifactShell` carries the pin tool (hidden for a viewer), the comment count, `⌥C` (`artifact.comment`) and `Esc` (`artifact.dismiss`), and loads, watches, and sets the viewer. `lib/artifact-comments.ts` holds the geometry.
- Guests: a guest on a work opens it through the same `WorkPane`, so an editor guest comments and a viewer guest reads, at the link's role, with the host refusing what the shell does not offer.

## 5. Proof

- `tests/unit/comment-commands.test.ts` — stamping, who may change what, per-person read marks, resolve-open, the schema stripping a claimed author.
- `tests/unit/comment-thread-people.test.ts` — bylines, verbs, unread across people, the plan's single-reader mark.
- `tests/unit/comment-sync.test.ts` — reconcile keeps identity, follows order, drops cleared fields.
- `tests/unit/artifact-comments.test.ts` — pin fractions, stable numbering, card placement inside a narrow pane.
- `tests/unit/access-policy.test.ts` — editor to comment, viewer to read-mark, a guest at its link's role.

## 6. Not in this slice

Plan comments keep the single-reader blob (`savePlanAnnotations`) and no people. A "can comment" role. Comments on a session transcript. Comments in the conversation's inline artifact card (the pane is the surface). Anchoring a pin to an element inside the sandboxed frame. Mentions and notifications for a thread someone answered. Older hosts refuse the new methods with "Unknown method"; the rail then shows no change and logs the refusal.
