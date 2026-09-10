## Temporary Google-linked work policy

Google-linked works are read-only in Solus until a richer sync model is chosen. First publish still creates and links a Google Doc. Once linked, the host rejects local and agent body/title saves, revision restores, and repeat work publishes (including force). The shared document editor is read-only in rich and Markdown modes, and hides rename, restore, and repeat publish actions. Edit the document in Google Docs and use Pull latest to refresh Solus. Pull remains an explicit operation and retains the prior local version; existing unpublished local content is not removed just by linking or opening the work.

Private annotations and external comment reads, sharing, replies, and supported state changes remain available. Unlink restores local editing without changing Google. This policy applies to works; standalone plans and direct URL-based external document tools retain their existing contracts. It does not add automatic body refresh or change import fidelity.

Read-only rich text remains keyboard-focusable so selecting text can open a new local comment. Comment-capable document surfaces also expose the compact selection menu on mobile. Adding a comment does not enable body editing or automatically publish the comment.

# Google Docs comment sync

New quoted comments include Drive `quotedFileContent` as plain text; the message body contains only the comment. Refresh can therefore restore the normalized text anchor and place the thread inline in Solus when the current text matches uniquely. Older messages with an exact matching quote prefix omit that duplicate prefix for display. This does not create a native Google Docs highlight or remove Google's “Original content deleted” label for unanchored comments. Unquoted comments remain page discussions. Previously sent comments without quote metadata are not repaired automatically; message text is not parsed to guess an anchor. Missing or repeated quotes still have no inline placement.

The rail suppresses an unchanged local copy only when a sent receipt identifies its source message and an available external thread. It never matches by message text alone or deletes private annotations. A local thread with private replies, an edited draft, or no confirmed external match remains visible. Unlinking or deletion of the external thread restores the local copy. The shared card owns provider replies and resolve state; private history is not sent by this display change.

Google discussions and private agent instructions have separate ownership. A work's existing `comments` array remains local. Its host-owned `externalComments` snapshot holds shared Google threads, replies, provider authors, and delivery receipts. A local comment may reference a Google thread without becoming shared.

## User behavior

A linked document has one comments surface, not two — but that surface has two views, because a document carries two kinds of conversation:

- **Inline** is the margin. Every thread that annotates a passage rides the line it annotates, local and external alike. An external thread qualifies when the highlight plugin found its quote in this text exactly once.
- **Page** is a list. It holds the threads that annotate the document rather than a passage: page-level comments, detached threads, and quotes this copy no longer holds. They have no line, so they have no place in a margin.

The two-way toggle sits in the rail's own header beside the count, and appears only when the document has threads of both kinds. A view is never shown empty while the other holds threads, so a document whose only comments are page-level opens on them.

The header is one line at every width. The count is of the view you are in, so the toggle carries no numbers of its own — each side names its count in its tooltip instead — and when the rail is too narrow for both, the count truncates rather than the row wrapping or the toggle shrinking. Losing the toggle would strand a whole view; losing the tail of a count costs nothing.

Keeping the page threads out of the margin is not tidiness. The margin places cards against the lines of the text; a thread with no line has to be given an arbitrary one, and on a short document the extra cards push the anchored ones past the bottom of the margin, where they are clipped. That is also why `layoutThreads` reports `hidden`: a card the margin genuinely cannot fit is hidden and added to the `↓ n` edge counter rather than left half-drawn at the bottom edge. Pressing the counter opens that thread, which then wins its own line and comes back into view.

Above the rail sits one line of provider chrome — provider name, last check time, **Show resolved**, **Refresh** — with request errors under it. Resolve and Reopen show a spinner in place of the action while the request runs. Pending requests do not show a delivery warning. The rail refreshes when opened, when the window regains focus, and every five minutes while mounted. Errors leave the last complete snapshot visible.

The header count beside the document title counts both kinds of thread and shows or hides the whole surface. Below the rail's fold width (a narrow pane or a phone) there is no margin to hold cards on their lines, so the same surface opens as a sheet on the foot of the reading pane; it stays closed until the count is pressed or a thread is opened. Clicking an external highlight opens that card in the rail rather than a popover, because its provider actions do not fit one.

Each thread in the rail names **Google Docs** as its origin, so **Reply…**, **Resolve**, and **Reopen** on that card are understood as external actions. **Ask agent privately** creates a linked local comment and opens a private prompt draft.

The rail's **Send to agent** button hands over everything the count holds: the open local threads, then the unresolved external threads under a preamble that names them as review content and forbids posting back to the provider. Only the local threads are resolved by the send; external thread state is the provider's and is changed only by an explicit action on that card.

To publish a local message, select the Google Drive mark on that message. Only that message is sent. The rest of the thread stays local. New comments have no native Google Docs highlight. **Find in text** selects text only if the quote has one exact match. Missing or repeated quotes leave the document selection unchanged.

Shared discussions appear in `read_work` as external review content. Local `comment_document`, `reply_comment`, and `resolve_comment` tools remain private. The generic `read_external_doc_comments` and `write_external_doc_comment` tools now support direct Google comment reads, creation, replies, edits, deletion, resolution, and reopening when the user requests the external action. See [External document comment tools](external-doc-comment-tools.md) for permissions, provider capabilities, and delivery limits.

## Storage and transport

The host owns Google access, pagination, serialization, and persistence. `readWorkExternalComments`, `refreshWorkExternalComments`, and `sendWorkExternalComment` use the common RPC registry across desktop, web, and mobile. The existing `annotations.changed` event invalidates the shared snapshot. Shared refreshes never replace local editor drafts or private comments.

Local annotation saves cannot set or overwrite `externalComments` (or the legacy `googleComments`). Network operations re-read the document link before saving so an unlink or relink cannot install a snapshot from a different document. All Google refreshes and sends for one work are serialized. A partial pagination failure never replaces the previous complete snapshot.

Outbound commands carry stable request IDs. The host records the command before POST and persists success before fetching the updated thread. A repeated successful or uncertain command does not POST again. A definite HTTP rejection may be retried with the same request ID. A timeout, server failure, or interrupted send requires checking Google Docs before composing another send; the application does not claim exactly-once delivery where Google offers no idempotency key. Unsent UI drafts remain during a failed request, but are not an offline outbox and do not automatically send on reconnect.

Google comments are rendered as text, including decoded quoted HTML. Native anchors are opaque strings such as `kix.…`, not necessarily JSON. Missing `resolved` means open. Deleted threads are retained in the cached snapshot but hidden in the rail. Provider read access does not imply comment write access: the current `drive.file` grant writes app-authorized documents, while `drive.readonly` alone cannot write an arbitrary imported document.

## Comment publishing UI

**One control, one click.** A local message on a linked Google document carries a single 20px button wearing the Google Drive mark. Selecting it publishes that message and nothing else. There is no status caption, no preview step and no second verb: the mark's presence already says the document is linked, and its state says whether this message reached it. The button sits in the thread head beside the timestamp, on the trailing edge of each reply, and in the narrow-screen comment popover.

The button is the whole state model. It is always legible, never hidden on hover, and it carries a sage tick once the message is published. Where it cannot be pressed it is `aria-disabled` rather than `disabled` — a disabled button takes no pointer events, so its tooltip would never open — and the tooltip is the only place a reason is written:

| State | Pressable | Tooltip |
|---|---|---|
| Ready | yes | Publish to Google Docs. Only this message is sent — the rest of the thread stays in Solus. |
| Publishing | no | Publishing to Google Docs… |
| Published | no | Published to Google Docs |
| Unconfirmed | no | Delivery was not confirmed. Check Google Docs before publishing this comment again. |
| Failed | yes | The provider's error, then: Select to publish to Google Docs again. |
| Empty | no | There is nothing to publish yet. |

Publishing is outbound and cannot be recalled, so only a definite rejection reopens the button, and a retry reuses the original request ID. Outcomes are reported by toast; the card itself never grows an error block. `publishState` in `components/work/lib/google-comments-view.ts` owns these rules and is tested directly.

An external card is for published threads and replies; it has no second composer and no local-message selector. It wears the same surface as a local thread, so the two read as one margin, with a **Google Docs** origin line carrying the same provider mark. `railThreads` in `components/comments/lib/thread.ts` merges the two kinds into one ordered list, and `measureAnchors` measures external threads off the highlight plugin's decorations — an external thread with no measurement is exactly the one that belongs to the Page view. Older hosts show an update/restart instruction when the comment RPC is unavailable.

## Publishing constraint

Live verification on a disposable document established:

- Native thread reads, replies, resolution, and reopening work through Drive v3.
- API-created custom anchor data round-trips, but the documented API does not create native Docs highlights.
- Deleting and reinserting an identical body leaves the discussion present but detaches its native anchor. Google displays **Original content deleted**.
- After detachment the API still returns the old anchor and quote. Their presence cannot establish that a native highlight survives.

Google document updates never replace the body. The highlight-loss override and confirmation action have been removed. The adapter used by works, plans, and direct agent updates applies targeted text edits only. The creation writer is separate, rejects nonempty documents, and contains no body deletion.

The supported update path reads Google’s indexed paragraph and table structure. It edits existing paragraphs and single-paragraph cells in rectangular, unmerged tables. Unchanged tables, blank paragraphs, standalone images, and section breaks stay in place. It applies bold, italic, strikethrough, link, and heading changes with range-specific style requests; unrelated fonts, colors, spacing, table borders, and widths remain unchanged. A changed paragraph retains its newline. A complete text replacement is allowed within an unprotected cell or paragraph when other text in the document remains; a complete document rewrite is refused.

Operations run from the end of the document toward the start. Each paragraph’s style requests follow its text change, using that paragraph’s updated indexes. All requests go in one batch with explicit tab IDs and `requiredRevisionId`. No-op body updates send no batch. Positional writes are never automatically retried; a new attempt reads the document and plans again. The Drive version is checked before and after the body read when the caller supplies an expected version. Import stores the upstream content hash, and Google publishing refreshes that comparison before choosing its expected version. A comment or deferred Google revision must not create a false content conflict.

Comment guards use native document indexes, including gaps between table cells. A partial edit strictly inside a uniquely located quote is allowed if its boundary text remains. Missing, repeated, or boundary-crossing quotes block text changes. Google keeps the original quotedFileContent after an edit. The host therefore stores a per-document/tab comment checkpoint under its data directory: thread ID, original quote, transformed quote, and an indexed-text fingerprint. Before the batch, it atomically saves both possible text states. After a restart or an uncertain response, only an exact fingerprint match can restore the transformed quote. External text changes invalidate the mapping. This cannot recover edits made before checkpoint support was installed, or prove native highlight attachment.

This increment rejects merged/nested tables, cells with multiple paragraphs, list/code/blockquote changes, mixed image/text paragraphs, arbitrary imported image replacement, suggestions, and multiple/nested tabs. These need additional structural operations and recovery tests. Unsupported updates fail before sending any request; there is no destructive fallback, including for old clients that send the removed override. The host uses the same adapter for desktop, remote clients, plans, works, and direct document tools.

Structural publishing now supports one unambiguous contiguous group of row additions/removals or column additions/removals per table, plus one contiguous group of paragraph additions/removals. Existing text establishes the retained rows, columns, and paragraphs; ambiguous repeated content and simultaneous changes to both table dimensions are refused. Keep retained cell text unchanged while changing a table dimension; formatting changes can accompany the operation. Structural changes across custom section breaks remain unsupported.

The planner validates the current indexed layout, predicts the structure after each native row/column or paragraph request, and plans cell fills and formatting against that result. All structural and text/style requests are validated before sending one requiredRevisionId batch. No empty intermediate table is published in a separate request. Comment guards reject removing any protected text; inserting a new paragraph or structural gap at a quote boundary is permitted without changing the stored quoted text. Structural index changes participate in the same before/after comment checkpoint. Same-host updates are serialized per Google document, including separate work links and direct tools, so a rejected concurrent writer cannot replace the successful writer’s checkpoint.

Live structural verification on disposable doc `1DkMB3V3ERt5zgn7dvh_xi_FJWEcFPHOcIGiIFE88W8k`: insert/delete row, insert/delete column, insert/delete paragraph; row insertion immediately below header; rightmost column insertion; paragraph insertion at document start/end; exact readback after each update. Original API-created quoted comment stayed on the same thread and received one completion reply. Evidence: `/tmp/solus-google-review-e2e-XVLbHG/structure-live-evidence.json` and `structure-edges-evidence.json`. This is adapter/API evidence, not native-highlight or client-UI verification.

Existing Solus diagram images can now be replaced in place through Google's `replaceImage` operation, with the same object ID, tab and display box. Work and plan links persist `googleImages` (work ID, object ID, tab ID, caption, source URI and original PNG hash). New publishes capture these bindings; legacy links can adopt an image only through a unique matching caption. Duplicate diagrams, missing images, removed/reordered images and upstream source changes fail before staging. An explicit Pull accepts the current image source and clears the old pixel hash; it cannot reconstruct a Solus diagram model from externally edited pixels. Image changes detected during refresh are upstream changes even when markdown is identical.

The renderer already supplies diagram PNGs through the shared publish contract. Unchanged PNG hashes skip image writes. A text-only publish with no fresh render retains the existing diagram embed and image. Replacement bytes are validated before upload, then padded with transparency to the existing image aspect ratio. This avoids CENTER_CROP cutting diagram content; a one-pixel margin accounts for integer rounding. PNG decoding/encoding uses pngjs, with CRC checking and a 25-megapixel limit before and after padding. The original display dimensions are preserved. Google may remove existing image effects as part of replacement; preserving arbitrary edited image effects is outside this path. See [Google ReplaceImageRequest](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#ReplaceImageRequest).

Changed PNGs use temporary link-readable Drive staging, as creation already did. All image replacements join the same revision-guarded text/structure batch. Staged files are deleted on success or failure; cleanup failures are logged. Positional batches are never replayed after an uncertain response. If an image write succeeded but its result was lost, Pull can recover its current source before the next publish. Arbitrary imported photos have no Solus asset mapping and are preserved, not automatically replaced. Moving/inserting/removing images remains unsupported.

Live image verification: disposable doc `1Samcbgh-doSjRGNybjw9kVuN48lz5Cw7O5g8cft0SSw`. Actual adapter created an image, replaced a wide PNG with a tall PNG, and retained the same object ID/display size and byte-identical body structure. Exact markdown readback, unchanged-image no-op, text-only publish retaining the image, staged-file deletion and original comment plus one completion reply passed. Evidence `/tmp/solus-google-review-e2e-XVLbHG/image-live-evidence.json`. API-created comment fixture does not prove native highlight attachment. No client UI or native IPC verification in this increment.

Live verification on disposable Google Doc `1MqI9opB9kpt7Ux6JTRA5h392nB7_Y3ehN-nCjSzt4YE`: unchanged-table no-op; cell text edit plus bold prose edit; exact markdown readback; a second edit using original quote metadata; and actual adapter comment → two publishes → reply with stable thread and one reply. The review fixture was an API-created quoted comment, not a native highlight. Evidence: `/tmp/solus-google-review-e2e-XVLbHG/structured-evidence.json` and `structured-adapter-evidence.json`. The new table path has not been exercised through native desktop IPC or the client UI.

These are conservative text and range checks, not proof of native highlight preservation. Native anchors remain opaque and comments can change independently of document content. Actual native highlight checks remain required before claiming preservation. Rich-document editing needs further implementation; this increment intentionally refuses those updates.

## Verification

Focused tests cover native anchor decoding, all-page import, partial read failure, private/shared storage boundaries, duplicate/uncertain sends, relink races, and the publish guard. Live API verification uses a disposable document only. UI checks use a temporary standalone data directory with synthetic local and shared threads; no real account is attached to that instance.

The local/shared boundary also applies when a work is linked to a different Google document: the new document gets a fresh shared snapshot; local discussions remain local. Unlinking stops Google operations and removes the external threads from the rail. Already posted comments remain in Google Docs.

### Verification record (2026-09-09)

- Eleven focused tests passed for API parsing, delivery receipts, private data isolation, stale links, quote matching, and the publishing guard. Thirty-two existing comment-tool and work-sync tests passed.
- `bun run build` passed. Broad server and Svelte type checks still report existing errors outside this feature; the new comment files have no reported type errors.
- The implemented Google API helpers read the disposable native thread and successfully created a comment, replied, resolved, and reopened it. No existing user documents were modified.
- The built web client passed Playwright checks with synthetic data at desktop size in light mode and at 390 × 844 with touch emulation in dark mode. Verified shared-thread rendering, selected-message preview, retained draft after failed send, keyboard opening, exact quote selection, mobile compose access, and no horizontal overflow or browser errors. Screenshots are in `/tmp/solus-comments-ui-jZJkeQ/`.
- Desktop Electron IPC and physical iOS/Android devices were not exercised. They use the same RPC methods and shared document components. Editor/Pill-specific interaction and direct outbound agent tools were not exercised.

## Document adapter comment capability

`DocProviderAdapter.comments` is an optional `DocCommentsAdapter`. It exposes supported `actions`, human-readable `limitations`, `list(ref)`, and `mutate(ref, mutation)`. An absent capability means that comments are not integrated for that provider. Listed actions describe implementation support; they do not grant access to a particular document.

The Google work-comment service now obtains this capability from the document provider registry. The adapter owns authentication and API conversion. The host retains private/shared storage, command validation, request receipts, serialization, stale-link checks, and client events. The existing Google RPC names and persisted snapshot remain compatible; this change alone does not enable Confluence comment sync.

Adapters return a complete comment snapshot or reject the read. A `DocCommentRequestError` distinguishes definite rejection from an uncertain write. Adapters must not retry uncertain writes. The host keeps that distinction in delivery receipts so an interrupted send cannot silently produce duplicate comments.

## Shared work integration for Confluence

The work store, RPC methods, and the one comments rail now support both Confluence and Google Docs. `WorkExternalComments` binds snapshots and delivery receipts to the provider, external document ID, and external scope/site. Import and agent `read_work` refresh shared comments for either provider. The mounted rail refreshes on open, focus, and its existing presence timer; private local comments remain independent.

The shared UI uses the provider label and logo, including the single-message publish button. Replies send to the same external thread. Confluence page threads do not offer resolve/reopen; existing inline threads do, except detached threads. Private agent discussions remain separate local comments. Google comments remain document-level messages with optional quoted text. Confluence now creates native inline comments for unique quoted selections, preserves native marker IDs during supported page edits, and refreshes current marked text for Solus highlights. Unquoted Confluence messages remain page discussions. See `external-doc-comment-tools.md` for limits and live evidence.

Legacy Google snapshots migrate on refresh, preserving sent and uncertain receipts. Older Google RPC names remain registered for client compatibility. Private annotation writes cannot replace either shared field. New sends include the expected provider/site/document target; stale targets fail before an API write. Renderer snapshots from an old link are not applied or shown after a relink.

Live verification on the disposable Confluence page used a temporary work database and the actual import, annotation, and work-comment services. Import populated external threads/replies; one selected message posted once despite a repeated request; local private text was preserved and not sent. The renderer uses shared components and RPC on desktop/web/mobile; visual browser checks were unavailable in this session. Native highlights and anchor preservation across publish remain unverified.
