# 001 — Workspace project catalog

## Objective

Create one canonical renderer-side catalog of projects that the user opened on a host. Use it in every page-level project picker. Keep session-sidebar grouping unchanged.

## Product behavior

- A project identity is `(serverId, projectRoot)`. The same path on two hosts is two projects.
- Record a project when the user opens, clones, adopts, initializes, publishes, or runs a session in it.
- Keep the record after its last tab closes. Restore it after an app restart.
- Seed the catalog from restored tabs so existing users do not start with an empty catalog.
- Provide an explicit remove action. Removing a catalog entry must not delete files, sessions, or sidebar groups.
- Page-level project pickers show the deduplicated union of:
  1. catalog projects,
  2. projects represented by session-sidebar summaries,
  3. domain items already shown by that page, when applicable.
- Prefer the catalog label, then the sidebar/domain label, then the directory basename.
- Do not change session-sidebar project tracking or grouping.

## Implementation outline

1. Read the exports and callers of `workspace.context.svelte.ts`, `session-sidebar.store.svelte.ts`, `task-list.ts`, the page switchers, and client-shell persistence before editing.
2. Add a focused `workspace-projects` feature store with an exact project type. Persist only stable fields such as `serverId`, normalized `projectRoot`, label, and last-opened time. Do not use a broad unknown record.
3. Keep persistence in the client shell. Do not assume that the renderer and server share a filesystem. If the current client settings persistence cannot own this state cleanly, add the smallest typed RPC/local-shell contract needed.
4. Add narrow commands such as `rememberProject`, `removeProject`, and `projectOptionsFor(...)`. Mutate reactive maps/arrays in place.
5. Wire all project-open completion paths and restored tabs to `rememberProject`.
6. Update page-level project pickers in Tasks, PRs, Workspace, Automations, and other page scopes found through a narrow search in `src/renderer/components/`. Do not change conversation/session navigation pickers.
7. Dedupe by qualified identity, not path alone. Ensure selection state also carries `serverId`.
8. Add empty, stale-host, and removed-project handling. A disconnected host entry stays visible and disabled or clearly marked; it must not silently select another host.

## Likely files

- `src/renderer/contexts/workspace/workspace.context.svelte.ts`
- `src/renderer/contexts/session-sidebar.store.svelte.ts`
- new files under `src/renderer/contexts/workspace-projects/` or the nearest existing feature folder
- `src/renderer/components/tasks/TasksPage.svelte`
- `src/renderer/components/prs/PrsPage.svelte`
- `src/renderer/components/workspace/WorkspacePage.svelte`
- `src/renderer/components/automations/AutomationsPage.svelte`
- shared page-level project switchers
- exact persistence contract/handler files, only if required

## Acceptance criteria

- Opening a project makes it available in every page-level project picker.
- Closing all project tabs does not remove it.
- Sidebar-only projects also appear, without duplicates.
- Equal paths on different hosts remain separate and route to the correct host.
- Removing an entry only removes catalog history.
- Desktop-local, desktop-hosted, and remote web/mobile selections use the correct host API.

## Verification

- Add focused unit tests for union, dedupe, persistence hydration, removal, and same-path/different-host identity.
- Run the focused tests, `bun run lint:types`, `bun run lint:hosts`, and `bun run build`.

