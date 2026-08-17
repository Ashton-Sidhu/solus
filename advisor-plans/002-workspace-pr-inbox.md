# 002 — Workspace-wide pull request inbox

## Objective

Make the existing PR inbox workspace-wide across the canonical opened-project catalog and session-sidebar projects. Keep a project filter for focused work.

## Dependency

Implement after plan 001 in the same branch.

## Product behavior

- The default project scope is **All projects**.
- The inbox and global PR views use the same project scope. Switching views does not reset it.
- Selecting one project filters the current view to that project.
- Aggregate GitHub pull requests only. Other providers stay out of scope.
- Each row and action is qualified by `serverId`, `projectRoot`, repository context, and PR number.
- Preserve existing review-need, checks, authored/attention, effort, stack, keyboard navigation, comments, guide, review, merge, and conflict features.
- Stack grouping never crosses repository boundaries.
- One failed or disconnected project does not hide successful projects. Show a per-project error and retain its last good snapshot when safe.

## Implementation outline

1. Read `prs.store.svelte.ts`, `PrsPage.svelte`, PR row/detail components, lifecycle event subscriptions, and all number-only selection/review-mode callers.
2. Add exact qualified types such as `WorkspacePullRequest` and `PullRequestTarget`. Do not use PR number as a workspace identity.
3. Keep per-project cache, pagination cursor, loading, error, and refresh state keyed by `(serverId, projectRoot, context)`.
4. Add an aggregate loader with bounded parallel requests. Route each request through the API for that project host. Preserve stale guards when scope or refresh generation changes.
5. Convert selection, J/K navigation, detail opening, checks/effort maps, lifecycle updates, and row keys to the qualified identity.
6. Change Review Mode targets from numbers plus one context to qualified targets. Resolve the correct host API and repository context for every active target.
7. Make pagination explicit per project. A workspace load-more operation should fetch only projects that have another page and should not discard other results.
8. Use the plan 001 project-option union in the PR page picker. Add **All projects** as the initial value.
9. Keep the aggregate in the renderer because projects can be on different Solus hosts. Do not add a server endpoint that assumes one host can see all projects.
10. Ensure events update only the matching qualified row. A PR number collision across repositories or hosts must not cross-update.

## Likely files

- `src/renderer/contexts/prs/prs.store.svelte.ts`
- `src/renderer/components/prs/PrsPage.svelte`
- PR list, row, detail, review-mode, checks, effort, and stack helpers under `src/renderer/components/prs/`
- focused PR store and component unit tests

## Acceptance criteria

- The inbox initially shows PRs from all known workspace projects.
- The project picker can select All projects or one qualified project.
- Identical PR numbers in different repositories behave independently.
- Actions and Review Mode always use the correct host and repository.
- Partial failure is visible and does not remove successful or safe cached rows.
- Refresh, reconnect, pagination, and project removal do not leave contradictory rows.

## Verification

- Add focused tests for aggregation, qualified identity collisions, partial failure, stale response rejection, per-project pagination, event routing, and Review Mode targets.
- Run the focused tests, `bun run lint:types`, `bun run lint:hosts`, and `bun run build`.

