# 003 — Selective-file and manual-message commit options

## Objective

Add an advanced commit composer without changing the existing automatic commit and automatic commit-and-push fast paths.

## Product behavior

- Keep the current **Commit** and **Commit and push** actions unchanged: stage all changes and generate the message automatically.
- Add **Commit with options…** and **Commit and push with options…**.
- The composer lists changed files with status and diff totals, supports select all/none and individual files, and accepts an optional commit message.
- An empty message uses the existing message generator.
- At least one file must be selected. Block unresolved conflicts.
- Scope is file-level selection only; do not add hunk staging.
- Selected deleted and untracked files must work.
- Unselected files and their staged/unstaged state must remain unchanged.

## Implementation outline

1. Read `git-types.ts`, `git-action-manager.ts`, `worktree-handlers.ts`, `git-actions.svelte.ts`, `GitSection.svelte`, git status types, and immediate callers.
2. Extend the typed request with optional `commitMessage` and `filePaths`. Absence means current stage-all behavior. An empty array is invalid.
3. Validate every path as a normalized repository-relative path and reject traversal, duplicates after normalization, and paths outside the repository.
4. For selective commits, do not use `git add -A` globally. Stage only selected paths while preserving excluded index state. Use a temporary-index or equivalent safe Git strategy if that is required to commit only the chosen files without disturbing pre-existing staged changes. Restore the real index on success and failure.
5. Apply the supplied nonblank subject after validation; otherwise use the existing generated subject. Do not change push/feature-branch behavior.
6. Reject commit-only fields for actions that do not create a commit.
7. Add a colocated composer component and thin handlers in `GitSection.svelte`. Keep durable git status in its store. Preserve keyboard navigation, cancellation, focus return, loading, and errors.
8. Make the same capability available on desktop, web, and mobile surfaces that expose Git actions. Use the existing host API path.

## Acceptance criteria

- Existing one-click actions have identical requests and behavior.
- Advanced commit can commit only selected files and leave all excluded working-tree and index changes intact.
- Empty optional message invokes the existing generator; nonblank text is used as the commit subject.
- Invalid/empty selection, traversal, conflicts, and failures are clear and safe.
- Commit-and-push options push only after the selective commit succeeds.

## Verification

- Add temporary-repository tests for mixed staged/unstaged files, untracked/deleted files, excluded staged files, failures, path validation, generated/manual messages, and commit-and-push sequencing.
- Add focused composer tests where practical.
- Run the focused tests, `bun run lint:types`, `bun run lint:hosts`, and `bun run build`.

