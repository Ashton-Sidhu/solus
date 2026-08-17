# 005 — Explicit pull request checkout

## Objective

Add a visible PR checkout action with two deliberate destinations: an isolated worktree or the current repository.

## Product behavior

- Opening a PR remains read-only and does not check it out.
- **Check out in separate worktree** is the recommended option.
  - Reuse an existing checkout for the same PR/head when safe.
  - Otherwise create the existing PR worktree and branch convention.
  - Open or activate a conversation rooted in that worktree.
  - Never move the current repository checkout.
- **Check out in current repository** is an explicit, confirmed option.
  - Fetch the exact PR head.
  - Block dirty or conflicted repositories.
  - Block a branch that is already checked out in another worktree.
  - Explain that active provider sessions cannot be moved safely; after confirmation, open a fresh draft/session rooted in the switched repository.
- Both paths use a stale-head guard and show the current state plus a clear way to retry.

## Implementation outline

1. Read `worktree-manager.ts`, `PrReviewStore.ensureCheckout`, PR actions, session/tab creation APIs, Git branch-switch helpers, and typed RPC paths before editing.
2. Reuse the existing PR worktree operation for the isolated option. Add only the missing orchestration to open/activate the correct conversation.
3. Add an exact typed request/result for current-repository checkout. It must include `serverId` routing at the renderer boundary, repository root/context, PR number, and expected head SHA.
4. On the server, re-read PR metadata, compare the expected head SHA, fetch the exact head ref, verify clean/conflict/worktree constraints, and switch/create the local branch with existing branch semantics.
5. Never reset, stash, discard, or rewrite user changes. Never use implicit provider-session migration.
6. Add a checkout menu/dialog in the PR action surface with the isolated option first and recommended. Include loading, existing-checkout, stale-head, dirty, branch-in-use, disconnected-host, and generic error states.
7. After success, activate an existing matching tab or open a fresh draft rooted in the checkout. Restore focus to the prompt input when typing is the next step.
8. Qualify all action routing by host and project. The feature must work through Electron IPC and WebSocket transports.

## Acceptance criteria

- The user can choose isolated or current-repository checkout.
- The isolated action never changes the current repository branch.
- The current-repository action cannot lose dirty changes and requires confirmation.
- A changed PR head is detected before checkout.
- Fork PRs use the existing safe local branch convention.
- Success opens the correct project/worktree conversation on desktop, web, and mobile.

## Verification

- Add temporary-repository tests for clean/dirty/conflicted state, stale heads, forks, branch-in-other-worktree, existing checkout reuse, and exact-head fetch.
- Add focused UI/store tests for option routing and successful conversation activation.
- Run the focused tests, `bun run lint:types`, `bun run lint:hosts`, and `bun run build`.
