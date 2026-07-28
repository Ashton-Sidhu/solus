# Plan 007: Edit working-tree files inline from the diff

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report it instead of broadening the change.
> When complete, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 3f4ac5a..HEAD -- \
>   src/main/server/handlers/file-handlers.ts \
>   src/preload/index.ts src/shared/rpc.ts src/shared/types.ts \
>   src/renderer/components/artifact/FilePreviewStream.svelte \
>   src/renderer/components/diff src/renderer/lib/diff-state.svelte.ts \
>   src/renderer/lib/keybindings tests/unit tests/e2e
> ```
>
> The diff hydration changes listed in ADR 0003 are already present as
> uncommitted work. Treat those current files, not commit `3f4ac5a`, as the
> baseline. If their behavior differs from the excerpts below, stop.

## Status

- **Priority**: P1
- **Effort**: L (multi-day)
- **Risk**: MED
- **Depends on**: ADR 0003's per-file hydration implementation
- **Category**: direction
- **Planned at**: commit `3f4ac5a`, 2026-07-28

## Why this matters

Solus can already render, hydrate, and edit files with `@pierre/diffs`, but a
reviewer must leave the Diff tab to make a small correction. Inline editing
closes that loop: inspect an agent's working-tree change, correct it in place,
save, and keep reviewing without losing scroll position or context.

The safe first release is intentionally narrow. It edits only the current
working tree, one text file at a time, with explicit **Save** and **Discard**.
Historical turns, session snapshots, PR comparisons, patch overrides, deleted
files, and binary files remain read-only.

## Product decisions already made

1. Show **Edit** only when all are true:
   - `selectedScope.kind === "working-tree"`;
   - `patchOverride === null`;
   - the file is textual and has a live post-image (modified, added, or renamed);
   - the tab/session is not read-only.
2. Only one file can be in edit mode in a Diff panel. Trying to edit another
   dirty file keeps the first editor active and points the user to Save/Discard.
3. Editing a file expands it and turns off format/noise auto-collapse for that
   item. The user must see the complete editable post-image.
4. Saving is explicit. Do not copy the Files pane's 500 ms autosave behavior.
   `⌥S` saves while an inline editor is active.
5. Discard never writes. It exits edit mode, reloads the diff from disk, and
   returns the item to read-only rendering.
6. Saving compares against the exact raw file contents loaded when editing
   began. A mismatch produces a conflict state and keeps the user's draft.
   Never overwrite an agent/user change silently.
7. Pause live and manual diff refresh while an edit is dirty. Refresh after a
   successful Save or Discard.
8. A successful save may remove the file from the diff when the edit restores
   `HEAD`; that is correct.
9. Keep comments and editing mutually exclusive for the active item. Starting
   Edit closes an unsaved empty comment form; a non-empty comment draft must be
   saved or cancelled first.
10. Persistence across app restarts is out of scope. The editor survives
    CodeView virtualization during the mounted session, using CodeView's editor
    ownership, but Solus does not write unsaved source drafts to IndexedDB yet.

## Current state

- `src/renderer/components/diff/DiffStream.svelte` constructs one
  `CodeView<AnnotationMeta>`, builds `CodeViewDiffItem` records, and already
  keeps item identity stable across virtualization.
- `src/renderer/lib/diff-state.svelte.ts` owns scoped diff loading and exposes
  `loadDiffFiles(fileDiff)`, backed by ADR 0003's object-id-validated RPC.
- `src/renderer/components/artifact/FilePreviewStream.svelte` is the existing
  editor exemplar. It imports `Editor` from `@pierre/diffs/edit`, attaches it to
  a Pierre file, tracks dirty/saving/conflict states, and saves with
  `expectedContents`.
- `src/main/server/handlers/file-handlers.ts` already rejects stale writes:

```ts
if (request.expectedContents !== undefined) {
  const currentContents = await readBinaryFile(target, "utf8")
  if (currentContents !== request.expectedContents) {
    return { ok: false, path: target, error: "...", conflict: true }
  }
}
await writeTextFile(target, request.contents, "utf8")
```

- `@pierre/diffs` 1.3.0-rc.1 supports the intended integration:
  `CodeViewDiffItem.edit`, `createEditor`, `onItemEditChange`,
  `onItemEditComplete`, and `getEditor(itemId)`.
- `DiffPanel.svelte` is 1,022 lines and `DiffStream.svelte` is 1,014 lines.
  Both exceed AGENTS.md's hard split threshold. Do not add feature logic inline;
  extract enough existing responsibility that both end below 1,000 lines.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Existing diff tests | `bun test tests/unit/diff-file-loader.test.ts tests/unit/diff-ergonomics.test.ts tests/unit/git-hot-paths.test.ts` | all relevant tests pass; record any pre-existing unrelated failure |
| New editor-state tests | `bun test tests/unit/diff-edit-session.test.ts tests/unit/project-file-write.test.ts` | all pass |
| UI workflow | `bun run playwright test tests/e2e/workflows/diff-inline-edit.spec.ts` | all pass |
| Required compile gate | `bun run build` | exit 0, warnings only |
| Size gate | `wc -l src/renderer/components/diff/DiffPanel.svelte src/renderer/components/diff/DiffStream.svelte` | both are below 1,000 |

There is no separate lint/typecheck script. `bun run build` is the repository's
required compile verification.

## Scope

### In scope

- `src/renderer/components/diff/DiffPanel.svelte`
- `src/renderer/components/diff/DiffStream.svelte`
- `src/renderer/components/diff/DiffEditControls.svelte` (new)
- `src/renderer/components/diff/lib/diff-edit-session.svelte.ts` (new)
- `src/renderer/components/diff/lib/diff-stream-header.ts` (new extraction)
- `src/renderer/lib/diff-state.svelte.ts`
- `src/renderer/lib/keybindings/manifest.ts`
- `src/main/server/handlers/file-handlers.ts`
- `src/main/server/handlers/lib/atomic-project-write.ts` (new)
- focused shared/preload files only if the existing write result needs a
  machine-readable error code rather than string matching
- `tests/unit/diff-edit-session.test.ts` (new)
- `tests/unit/project-file-write.test.ts` (new)
- `tests/e2e/workflows/diff-inline-edit.spec.ts` (new)
- `plans/README.md` (status only during execution)

### Out of scope

- PR, review-guide, historical turn, session snapshot, interdiff, and arbitrary
  `patchOverride` editing
- deleted and binary files
- multi-file simultaneous editing
- autosave
- persistent/IndexedDB unsaved editor state
- merge-conflict resolution, hunk accept/reject, staging, committing, or pushing
- format-on-save, lint fixes, language servers, diagnostics, or autocomplete
- changing `@pierre/diffs` versions
- redesigning the Files pane editor
- changing Git clean/smudge filters or line-ending policy

## Target architecture

```text
DiffPanel (scope + product policy)
  ├── DiffEditSession (one active file, baseline, draft, save state)
  │     ├── DiffState loads a full editable post-image
  │     └── window.solus.writeFile(... expectedContents)
  ├── DiffEditControls (Edit / Save / Discard / conflict UI)
  └── DiffStream
        ├── CodeView item.edit
        ├── createEditor(options) => new Editor(options)
        └── onItemEditChange => DiffEditSession.updateDraft(...)
```

`DiffEditSession` owns durable mounted-surface state and stale async guards.
Svelte files contain only thin event handlers and markup. Do not let
`DiffStream` call `window.solus` directly.

## Steps

### Step 1: Characterize loading, conflict, and scope policy

Create `tests/unit/diff-edit-session.test.ts` around a controller with injected
load/save/refresh operations. Cover:

- working-tree modified, added, and renamed text files are eligible;
- deleted, binary, historical, PR, session, turn, and patch-override items are
  ineligible;
- a stale async load cannot replace a newer requested edit;
- only one active edit exists;
- a dirty edit blocks switching files and refresh;
- Discard performs no write and requests refresh;
- Save sends the original raw baseline as `expectedContents`;
- conflict retains the draft and enters `conflict`;
- successful Save clears the session and requests refresh.

Create `tests/unit/project-file-write.test.ts` for the extracted write helper:

- expected content matches and replacement succeeds;
- mismatch returns `conflict` and leaves the file untouched;
- a failed replacement leaves the original file intact and removes its temp
  file;
- file mode is preserved;
- paths outside the validated project root never reach the helper.

**Verify**:

```bash
bun test tests/unit/diff-edit-session.test.ts tests/unit/project-file-write.test.ts
```

Expected: policy tests pass as implementation is introduced; never weaken a
case to fit the implementation.

### Step 2: Make the existing project write atomic

Extract the actual replacement into
`src/main/server/handlers/lib/atomic-project-write.ts`. Keep path resolution and
root-containment validation in `file-handlers.ts`.

The helper must:

1. read and compare `expectedContents` immediately before replacement;
2. create a uniquely named temp file in the target's directory;
3. preserve the target's mode when it exists;
4. write and close the temp file before renaming it over the target;
5. remove the temp file in `finally` on every failure;
6. return a typed conflict result without relying on error-message parsing.

Do not create missing parent directories. Do not follow a symlink that escapes
the already validated real parent. Keep `refreshFinder(root)` after success.

**Verify**:

```bash
bun test tests/unit/project-file-write.test.ts
```

Expected: all cases pass and a simulated failed write leaves the original bytes
unchanged.

### Step 3: Add an edit-session controller beside the diff feature

Create `diff-edit-session.svelte.ts` with one assertion-style state model:

```ts
type DiffEditSaveState =
  | "idle" | "loading" | "clean" | "dirty"
  | "saving" | "conflict" | "error"
```

Store active path, full editable metadata, original raw contents, latest draft,
and error. Use a monotonically increasing generation for load/save staleness.

Add one `DiffState` method that loads an editable file:

- call `readProjectFile` for the raw live post-image and baseline;
- for partial changed/renamed metadata, call the existing scoped
  `loadDiffFiles`, replace its new-file contents with the raw baseline, and use
  `hydratePartialDiff("clone", ...)`;
- for already complete additions, clone metadata and preserve its full
  post-image;
- give edited content a fresh cache key;
- reject if the file disappeared, became binary, or no longer matches the
  displayed object identity.

Do not mutate `DiffState.fileDiffs` while an edit is active. The controller owns
the editable clone until Save/Discard refreshes the canonical diff.

**Verify**:

```bash
bun test tests/unit/diff-edit-session.test.ts tests/unit/diff-file-loader.test.ts
```

Expected: all pass, including CRLF baseline and stale-load cases.

### Step 4: Integrate CodeView-managed editing

In `DiffStream.svelte`:

- import `Editor` from `@pierre/diffs/edit`;
- expose props describing the active edit and callbacks, without importing the
  controller itself;
- set `item.edit = true` only for the active item and supply its full cloned
  metadata;
- pass `createEditor: options => new Editor({ ...options })`;
- forward `onItemEditChange` to the controller callback;
- expose `focusEditor(path)` and `getEditor(path)` only if controls need them;
- on edit start, expand the item and keep it out of auto-collapse;
- do not commit in `onItemEditComplete`; Solus's explicit Save owns writes.

Extract the existing header DOM construction into
`lib/diff-stream-header.ts`, parameterized by narrow callbacks. This is a
required size correction, not an invitation to redesign the header.

Do not attach the shared worker pool to an editable instance if it omits
`useTokenTransformer`; follow the working `FilePreviewStream.svelte` behavior.
If CodeView cannot mix its current shared pool with editable items, STOP instead
of disabling off-main-thread rendering for the entire diff.

**Verify**:

```bash
bun run build
wc -l src/renderer/components/diff/DiffStream.svelte
```

Expected: build succeeds and `DiffStream.svelte` is below 1,000 lines.

### Step 5: Add explicit controls and refresh protection

Create `DiffEditControls.svelte` for the active file's header actions:

- read-only: **Edit** button;
- clean edit: **Save** disabled, **Discard** available;
- dirty: **Save**, **Discard**, and “Unsaved” status;
- saving: disabled controls and progress label;
- conflict: retain editor plus “Changed on disk” status, **Reload & discard**
  and **Keep editing**;
- error: retain editor and allow retry.

In `DiffPanel.svelte`, instantiate the controller, pass thin props to
`DiffStream`, and:

- skip the 600 ms live refresh while dirty/saving/conflict;
- disable manual refresh with an explanatory tooltip while dirty;
- clear line selection/comment state before entering edit mode;
- register `diff-panel.save-edit` as `⌥S`, enabled only while dirty/conflict;
- make Escape leave a clean edit, but never silently discard a dirty edit;
- refresh once after Save or Discard.

Move the edit orchestration out of `DiffPanel.svelte` so the file ends below
1,000 lines.

**Verify**:

```bash
bun run build
wc -l src/renderer/components/diff/DiffPanel.svelte
```

Expected: build succeeds and `DiffPanel.svelte` is below 1,000 lines.

### Step 6: Add the end-to-end workflow

Create `tests/e2e/workflows/diff-inline-edit.spec.ts` covering:

- Edit appears only for a working-tree text file;
- clicking Edit expands the file and focuses the editor;
- typing marks the file Unsaved but does not write;
- `⌥S` saves and the refreshed diff shows the new change;
- Discard restores disk content and read-only rendering;
- an external write after edit start causes conflict and preserves typed text;
- live refresh does not erase a dirty draft;
- deleted/binary/historical/PR surfaces have no Edit action;
- editing back to `HEAD` removes the file from the diff cleanly.

**Verify**:

```bash
bun run playwright test tests/e2e/workflows/diff-inline-edit.spec.ts
bun test tests/unit/diff-edit-session.test.ts \
  tests/unit/project-file-write.test.ts \
  tests/unit/diff-file-loader.test.ts \
  tests/unit/diff-ergonomics.test.ts
bun run build
```

Expected: every command exits 0, apart from explicitly recorded unrelated
baseline failures.

## Done criteria

- [ ] Only eligible working-tree text post-images expose Edit.
- [ ] Exactly one file can be edited per Diff panel.
- [ ] Save is explicit; no source file changes before Save.
- [ ] Save uses the raw load baseline as `expectedContents`.
- [ ] Conflict never overwrites disk and never loses the editor draft.
- [ ] Discard performs no write.
- [ ] Dirty edits survive CodeView virtualization and suppress diff refresh.
- [ ] Save/Discard refreshes the diff once.
- [ ] Existing comments, find, hydration, collapse, and file navigation still
      pass their focused tests.
- [ ] Project writes replace files atomically after containment validation.
- [ ] `DiffPanel.svelte` and `DiffStream.svelte` are each below 1,000 lines.
- [ ] `bun run build` exits 0.

## STOP conditions

- CodeView editing requires changing the displayed comparison endpoints.
- A partial modified/renamed file cannot be hydrated to the exact raw
  working-tree post-image without losing line-ending fidelity.
- Supporting editable items requires disabling the worker pool for all
  read-only items rather than only the active item.
- Saving would require allowing paths outside the current project/worktree.
- A stale write can only be handled by overwriting or dropping the draft.
- The feature requires editing historical, PR, interdiff, deleted, or binary
  content to provide a coherent first release.
- A focused verification command fails twice after a reasonable correction.

## Maintenance notes

- Inline editing and the Files pane now share the same write safety contract.
  Future save surfaces must use the atomic helper and `expectedContents`.
- Treat `DiffEditSession` as mounted UI state, not a source-of-truth copy of the
  repository. Save/Discard always returns to a freshly loaded Git diff.
- If persisted editing is added later, key state by repository identity,
  worktree path, and file path—not file path alone—and invalidate it when the
  raw baseline changes.
- Hunk accept/revert can reuse the same save controller later, but must remain a
  separate product action with its own tests and undo behavior.
