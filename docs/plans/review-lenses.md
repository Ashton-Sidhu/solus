# Plan: review lenses

A **lens** is a custom HTML view of a change. The user writes a prompt, and a
review agent makes a sandboxed HTML artifact from that prompt and the change.
The artifact shows in a **Lens** tab in the review panel, after Map · Guide ·
Diff. A lens can explain the change, show it as a picture, or show it in any
other shape the user asks for.

A lens has the same scope as a review guide. It works on a working tree, a
session, a branch, and a pull request.

## Vocabulary

Use these terms in code, UI, and conversation. Do not make synonyms.

- **lens** — the output: one generated HTML artifact for one review target.
  Code: `ReviewLens`.
- **saved lens** — a named prompt in Settings that the user can use again on
  any target. Code: `SavedLens`.
- **lens prompt** — the text that makes a lens. It comes from a saved lens or
  the user types it one time in the Lens tab.
- **lens edit** — a prompt that changes the current lens ("make the diagram
  bigger", "add a risk section"). It does not start again from zero.
- **lens comment** — a comment the user anchors on part of the lens.
- **review view** — Map, Guide, Diff, or Lens. This is the existing
  `ReviewView` term. Do not call a lens a "view".

## Product rules

1. **One lens for each target.** A working tree, a session, a branch, and a
   pull request each have a maximum of one lens. A new lens or a lens edit
   replaces the current lens. This is the same rule as a pull-request guide.
   Solus keeps **one previous version** only for "Restore previous". The
   previous version is not a second lens: the tab does not show it, and a
   generation does not use it.
2. **Replace only on success.** If a generation fails or the user cancels it,
   the current lens stays.
3. **Manual generation only in v1.** Nothing generates a lens when the user
   opens a review. The warmer does not run lenses.
4. **The lens keeps its own prompt.** The lens stores a copy of the prompt that
   made it. If the user edits or deletes the saved lens later, the current lens
   does not change and does not become outdated.
5. **Outdated when the change moves.** A lens is outdated when the change
   fingerprint is different from the fingerprint of the lens. The tab shows
   this, and the user can regenerate.
6. **Save as work is explicit.** A lens lives in the review cache. "Save as
   work" copies it into Folio as an `artifact` work. Solus does not make works
   automatically.

## Features

### Combined lenses

The user can tick up to four saved lenses (`MAX_COMBINED_LENSES`) and generate
one lens with a tab for each. This is built on the client only
(`combinedLensSource` in `components/review/lib/lens-surface.ts`): the saved
prompts are joined into one `ReviewLensSource` with tab instructions. The host
sees one prompt, so rule 1 (one lens for each target) and Regenerate, edits,
Restore, and comments are unchanged. The lens does not record which saved
lenses made it; "Save as lens" on a combined lens saves the joined prompt as one
new saved lens. A single ticked lens keeps its own source.

### Settings → Review → Lenses

- Add, edit, reorder, and delete saved lenses. Each has a name and a prompt.
- Starter templates: "Architecture delta", "Risk by file", and "Data flow".
  The user can start from a template and edit it.
- Saved lenses are global in v1. Saved lenses for one project are a later
  change.

### The Lens tab

The tab is in both tab rows: `review/ReviewViewTabs.svelte` (local) and
`pr-review/PrViewTabs.svelte` (pull request). The tab shows the same states as
Guide: absent, queued, generating (spinner), ready, unread, outdated, failed,
and cancelled.

**No lens yet**

- A list of saved lenses. Select one to generate.
- A prompt field for a **one-time prompt**. The user types a prompt and
  generates a lens from it. The prompt is not saved in Settings unless the user
  selects "Save as lens".
- A model and reasoning picker. It starts at the review companion agent,
  model, and effort in Settings → Review. A change applies to this generation
  only; Solus does not save it. Regenerate and lens edits use the Settings
  values. The picker has no fast-mode switch, because a lens run does not send
  fast mode.
- The panel is centered in the Lens canvas, the same as the guide's empty
  offer.

**Generating**

- Progress steps (preparing, analyzing, writing) and Cancel. The guide and the
  lens use the same progress screen (`review/ReviewProgress.svelte`): a
  medallion with a ring that fills as the steps advance, and a step list.

**Ready**

- The lens in `SandboxFrame`.
- A header with: the lens name or "One-time lens", the prompt (can expand),
  the generation time, the commit, and an outdated badge when the change moves.
- Actions: Regenerate (same prompt, current change), New lens (saved lens or
  one-time prompt; asks for confirmation because it replaces the current lens),
  Restore previous, Save as work, and Save prompt as lens.
- **Restore previous** swaps the current lens and the previous version. A
  second Restore swaps them back, so Restore is its own reverse. The action is
  disabled when there is no previous version. The restored lens keeps its own
  fingerprint, so it can show as outdated.
- **Edit bar.** A prompt bar under the lens: "Ask for a change…". A lens edit
  sends the current HTML, the edit prompt, open lens comments, and the change to
  the agent. The result replaces the lens. Focus goes back to the edit bar
  after the user sends an edit.
- **Lens comments.** The user pins comments on the lens with
  `LensCommentLayer`. It reuses the pin geometry of the artifact comments
  (`artifact/lib/artifact-comments.ts`), but not `ArtifactCommentLayer`: a lens
  comment has no replies, and it has pull-request actions. "Apply comments" sends all open comments as one lens
  edit. After the edit completes, those comments are marked resolved. A new lens
  (not an edit) removes all comments, because their anchors are not valid.
  Comments belong to one lens version: Restore previous also restores the
  comments of that version.
- **Post to pull request.** On a pull-request target, each lens comment has a
  "Post to PR" action. The comment body goes out with a short quote of the
  anchored part of the lens, so the reader on the code host has context.
  - If the anchored element names a file and a line (see "Code anchors"
    below), the comment becomes a draft line comment in the existing review
    draft (`ReviewDraftComment`). The user sends it with the normal Submit
    review flow.
  - If not, the comment goes out at once as a pull-request conversation
    comment through the existing `prAddIssueComment`. The action asks for
    confirmation first, because the post is public.
  - After a post, the lens comment shows "Posted" with a link, and it is
    marked resolved. A posted conversation comment is removed from the pull
    request with the existing `prDeleteIssueComment`; a draft line comment is
    removed from the review draft.
  - On other targets (working tree, session, branch), the action is not shown.
  - The action is disabled when the code host does not give comment
    permission (`viewerPermissions.comment`), with the reason in a tooltip.
  - While the diff loads, an anchored comment cannot be checked, so the action
    is disabled.
  - A line that already has a draft is refused as a draft line comment, so the
    user's own draft is never overwritten. The comment then posts as a
    conversation comment.

### Code anchors

The lens prompt tells the agent to put `data-solus-file` and `data-solus-line`
on elements that show one place in the change. When the user drops a pin, the
client asks the frame what is under that point (`solus-lens-anchor-query`). A
small script that only isolated frames get finds the nearest element with
`data-solus-file` and sends back the path, the line, and its text. This is the
only link between the lens HTML and the code.

The render can forge that answer, so the client treats it as untrusted: it
keeps only a relative path and a positive line, and it checks the line against
the new-side lines of the pull request's diff hunks (`commentableNewLines`)
before it makes a draft line comment. If the check fails, the comment goes out
as a conversation comment.

### Entry points

- The Lens tab (local review and pull-request review).
- Settings → Review → Lenses.
- Keybinding: the local review's view cycle (`review-pane.next-view`,
  `review-pane.prev-view`) reaches Lens.
- **Not built in v1:** command palette entries ("Generate lens…", "Edit
  lens…", "Save lens as work") and an edit-bar focus shortcut. The palette is
  assembled in each client shell (`desktop-palette.svelte.ts`,
  `apps/client/src/App.svelte`), and the review guide has no palette entries
  to follow either. This is the next step.
- **Review Mode** (the triage queue) keeps its Activity · Guide · Diff row. It
  has no Map, and it has no Lens for the same reason.

## Architecture

### Contracts (`packages/contracts/src/review.ts`)

`SavedLens`, `ReviewLens`, `ReviewLensComment`, `ReviewLensVersion`, and
`ReviewLensRecord` are as described above. The wire types:

- `ReviewLensSnapshot` — address (`repoRoot`, `key`), target, the current
  version with its comments, `hasPrevious`, `outdated`, the live job, and
  `revision` (`ReviewLensRecord.updatedAt`).
- `ReviewLensChangedEvent` on the `review.lensChanged` topic — address,
  target, job, and revision. It never carries HTML. A client reads the
  snapshot again only when the revision moves past the one it holds. The
  target lets a client with no pane open name the review: `app-core.ts` calls
  `reviewLensStore.follow()` once, the store keeps the last job per target on
  every host, the PR list row shows it (`pullRequestJobFor`, keyed by the pull
  request without its SHAs), and `onReady` shows the `review_lens_ready` toast
  only for a run the client saw as queued or generating. There is no bulk
  status call: a run that ended before the client connected does not show on
  the list.
- `ReviewLensJob` — `generate` or `edit`, with the guide's status and progress
  steps. There is no separate `editing` step: the job kind says it.
- `REVIEW_LENS_MAX_HTML_CHARS` = 500 000.

RPC methods (`rpc.ts`, `rpc-planes.ts`, `host-api.ts`): `readReviewLens`,
`prLensRevisions` (the saved-lens revision of many listed PRs, for the PR
list's lens filter), `requestReviewLens`, `editReviewLens`, `cancelReviewLens`, `restoreReviewLens`,
`updateReviewLensComments`, `postReviewLensComment`, and
`retractReviewLensComment`. The preload and the WebSocket client are generic,
so they needed no change. Posting uses the code host's existing issue-comment
calls; `addIssueComment` now returns the comment's node id and URL, so a post
can be retracted.

Settings: `savedLenses` in `HostConfig`, closed to agents like the other
instruction keys, and mirrored by the settings context.

### Server (`packages/server/src/review/`)

- `lens-jobs.ts` — `ReviewLensJobs`, one host-owned job per target. A new
  request cancels the running one. Every read-modify-write of one record runs
  in order, so a comment added while a run is working is kept when the run
  commits. Dependencies are injected for tests.
- `lens-store.ts` — the record file and its pure transitions: `commitLens`,
  `restoreLens`, `changeLensComments`, `markLensCommentPosted`. Records live
  under `<data dir>/review-lenses/<hash of repository>/<key>.json`, a root of
  their own so a lens key cannot collide with a guide file.
- `lens-agent.ts` and `review-lens-tool.ts` — the prompt and the
  `submit_review_lens { title, html }` tool.
- Target resolution is shared with the guide: `guide-producer.ts` now exports
  `resolveTarget`, `resolveTargetBase`, and `resolvedGuideHead` instead of the
  lens copying them. A pull-request lens runs in the same host-managed checkout
  as the pull-request guide (`prepareReviewGuidePrContext`) and is stored per
  remote repository (`prGuideRepository`, `prGuideKey`).
- A run that finishes after the working tree moved is still saved. It shows as
  outdated, because it keeps the fingerprint of the change it read. The user
  asked for it, so it is not thrown away.

### Renderer (`packages/workspace-ui/src/`)

- `routing/route-registry.ts` and `contexts/prs/pr-view.svelte.ts`: `lens`
  is a review view and a PR tab.
- `components/review/review-lens.store.svelte.ts` — snapshots per subject,
  event handling, reconnect reloads, and the unread mark.
- `components/review/LensSurface.svelte`, `LensStart.svelte`,
  `LensCommentLayer.svelte`, and `lib/lens-surface.ts`.
- `ReviewSurface.svelte` passes a `lensView` snippet to `DiffPanel`.
  `PrReviewPane.svelte` mounts the lens and hands it `lib/pr-lens.ts`'s
  adapter: the review drafts and the patch the lines are checked against.
  `ReviewDrafts.save` now returns the draft id.
- `settings/SavedLensesSetting.svelte` in Settings → Review → Lenses.

### Security

The agent reads the change. A pull request from another person can contain
prompt-injection text, so the lens HTML is not trusted. `SandboxFrame` has
`allow-scripts allow-popups allow-forms allow-modals allow-downloads`, and I
did not find a `connect-src` policy. A lens could send the diff to a remote
server.

A lens frame is isolated (`SandboxFrame` `isolated`, `wrapSandboxSrcdoc(...,
true)`): the sandbox attribute is `allow-scripts` only, and the CSP is
`default-src 'none'` with inline scripts and styles, `data:`/`blob:` media,
`connect-src 'none'`, `form-action 'none'`, and `base-uri 'none'`. A later
CSP in the lens HTML can only narrow this. Scripts stay on, because a lens can
be interactive.

One channel stays open: a frame can navigate itself to a URL, and no CSP
directive stops that. A lens could put diff text in that URL. Closing it needs
navigation control at the host shell (Electron can refuse a frame
navigation; a browser tab cannot). This is a known limit of v1.

## Clients, providers, and connections

- **Desktop, web, and mobile** all show the Lens tab, the edit bar, and
  comments: the web and mobile client mount the same `ReviewSurface` and
  `PrReviewPane`. On a narrow pane, the header actions wrap and the meta line
  hides. The edit bar and its send button stay visible.
- **Claude and Codex** are both supported.
- **Local and remote hosts:** the lens is RPC data with a size limit. No local
  paths go to the client.

## Reverse states

- Generate → Cancel. A failure keeps the old lens.
- A lens replaces the old lens → confirmation first, then Restore previous.
- Restore previous → Restore previous again.
- Comment → resolve and delete.
- Post to PR → delete the conversation comment, or remove the draft line
  comment from the review draft.
- Saved lens → edit and delete.
- Save as work → the work is a normal Folio work and the user deletes it there.

## Out of scope for v1

- Automatic generation and warming.
- Saved lenses for one project.
- More than one lens for each target.
- Agent, model, or effort settings saved on each lens. (The picker in the
  empty state is for one generation only.)
- A history of more than one previous version.
- Posting lens comments to a code host for a target that is not a pull request.
