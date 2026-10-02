# Page composer

Documents, artifacts, diagrams, and pull requests have a docked composer. Use
it to start an agent on the page you are reading.

## Behavior

- At rest, the composer is one chat glyph at the bottom right of the page.
- Click the glyph to open the composer. It scales out from the glyph's
  corner; with reduced motion it appears at once. It is the same composer a new session
  gets: project, host, model, permission mode, attachments, and voice.
- Press Escape, or click the page, to fold an empty composer back to the glyph.
  A folded composer that still has text shows a dot on the glyph.
- Press Enter to start a new session. The conversation opens in the companion
  pane beside the page, and the page stays where it was. On a phone there is no
  companion pane, so the conversation replaces the page.
- A session started from a work is bound to that work. It runs in the work's
  project folder, so the composer shows no project or host choice; a work with
  no project folder lets you choose one.
- A session started from a pull request runs in the pull request's worktree.
  Enter opens the conversation at once. A setup card in it shows the checkout
  steps, and the prompt is sent when the worktree is ready. If the checkout
  fails, the card shows why and the text goes back into the conversation's
  composer. Stop during the checkout withdraws the send the same way.
- If you close the page while the composer has text, the text stays as a draft
  in the session sidebar.

## Implementation

- `components/page-composer/PageComposer.svelte` renders the glyph and the
  composer. Its draft comes from `SessionDrafts.openDockedDraft`.
- The composer is `session-draft/DraftComposer.svelte`, the same block the
  draft pane renders: the project and host strip, the seat notice, the input
  bar, and the toolbar. The shell's attach, screenshot, and design-mode
  handlers, and the phone's `composerActions`, reach it through the pane
  surface props, as they reach the draft pane.
- `DraftComposer`'s `floating` mode is for a composer over a page: the strip
  has no background of its own, and the card casts a shadow.
- `destinationFixed` hides the project and host strip when the page decides
  where the session runs: a work with a project folder runs there, and a pull
  request runs in its worktree. A work with no project folder shows the strip.
- A docked draft counts as being composed (`composingDraftIds`). No pane and no
  sidebar row can take it while the page holds it. `undockDraft` drops an
  empty draft and keeps a draft that has text.
- `WorkPane` mounts the composer for every work type. `PrReviewPane` mounts it
  with `sendFirstPrompt`, which calls `PrReviewActions.sendAfterPrCheckout`:
  the session waits as `connecting` behind `buildPrCheckoutCard`, runs
  `ensureCheckout`, is re-aimed with `aimAtPrCheckout`, and then sends.
- Each new session always starts fresh. To continue the session that wrote a
  work, open that session from the sidebar.
