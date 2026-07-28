# Plan 008: Reuse diff comments in the file editor

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Category**: renderer UX
- **Status**: DONE
- **Decision**: Reuse the Diff panel comment system without presets or a
  separate selection-action UI.

## Product outcome

The editable file surface now follows the same review loop as the Diff panel:

```text
select line numbers
  → write an inline comment
  → save it beneath the selected lines
  → keep it in the session's existing diff-comment queue
```

This makes the file editor a review-and-instruct surface without creating a
second comment model or delivery path.

## Features added

### Line-anchored comments in editable files

- Line-number dragging and the gutter utility open the existing
  `DiffCommentForm`.
- The shared form is focused after Pierre finishes its annotation render, and
  its input events are isolated from the surrounding editable code surface.
- Comments use the existing `DiffComment` shape and always target the editable
  post-image (`side: "new"`).
- The captured `selectedCode` comes from the editor's latest in-memory contents,
  so an autosave delay does not make the prompt stale.
- Existing comments render with the same `DiffInlineComment` component and keep
  the same edit/delete behavior.
- Deletion remains recoverable through the existing Undo toast.

### Comment anchors follow edits

`@pierre/diffs@1.3.0-rc.1` remaps line annotations through editor document
changes. Solus consumes the remapped annotation anchors and updates:

- the comment's start/end line;
- an open draft's start/end line;
- the selected-code snapshot sent to the agent.

The selected range's line span is preserved around the remapped end-line anchor.
This is intentionally small and predictable; it does not attempt semantic
symbol tracking.

### Queue ownership without a second composer

- Saved file-editor comments use the session's existing `diffComments` array.
- They remain visible inline in the file editor after saving.
- The Files pane does not embed `DiffActionBar`, `DiffCommentsPopover`, or a
  `PromptComposer`; editing space is reserved for the file and its annotations.
- Existing Diff panel delivery remains available when the user wants to send
  the session's queued comments.

### Correct split-pane session ownership

The shared Diff comment APIs now accept an optional target tab id. Existing
callers still default to the active tab, while file panes explicitly use their
own `ctx.session.tabId`.

This matters because Solus panes can remain mounted against a source or
secondary conversation while another tab is active. Without explicit targeting,
a file-editor comment could otherwise be stored, edited, or cleared on the
wrong conversation.

Fresh-session delivery now also:

- reads comments and working-directory context from the source tab;
- sends the composed prompt directly to the newly created tab.

## Reused components and state

| Concern | Existing system reused |
|---|---|
| Draft model | `InlineCommentDraft` |
| Inline editor | `DiffCommentForm` |
| Saved card | `DiffInlineComment` |
| Stored comment shape | `DiffComment` on `TabState` |
| Prompt formatting | `formatDiffInlineComments` |

No presets, action toolbar, new RPC, new persisted comment type, or direct
composer-injection path was added.

## Solus implications

### Benefits

- Review feedback can be authored while editing, without switching to a diff.
- Multiple file-level instructions stay batched and structured for the agent.
- The agent receives path, line range, selected code, and free-form intent using
  the same prompt contract it already understands.
- Split panes are safe: feedback follows the pane's session rather than global
  focus.
- Comments remain useful as edits shift surrounding lines.

### Tradeoffs

- Comments are session-local UI state, just like Diff panel comments; they are
  not durable code-review records.
- Anchor remapping is line-based. Large rewrites can preserve location but
  cannot guarantee semantic attachment to the same symbol.
- All queued comments on the owning tab are sent as one batch, including
  comments created from another file or Diff surface.

### Follow-up boundaries

Future work may add durable comment persistence or semantic anchors, but those
would require an explicit product/data-model decision. Presets and a separate
selection action system remain intentionally out of scope.

## Implementation surface

- `src/renderer/components/artifact/FilePreviewStream.svelte`
- `src/renderer/components/files/FilesPane.svelte`
- `src/renderer/components/artifact/lib/file-comments.ts`
- `src/renderer/contexts/workspace/session-diff-feedback.ts`
- `src/renderer/contexts/workspace/workspace.context.svelte.ts`
- `tests/unit/file-comments.test.ts`
- `tests/unit/session-diff-feedback.test.ts`

## Verification

```bash
bun test tests/unit/file-comments.test.ts \
  tests/unit/session-diff-feedback.test.ts \
  tests/unit/session-utils.test.ts

bun run build
```

Expected: focused tests pass and the production build exits 0 with only known
worktree warnings.
