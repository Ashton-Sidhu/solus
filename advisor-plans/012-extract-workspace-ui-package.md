# Plan 012: Extract the shared Svelte workspace UI

> **Executor instructions**: Separate shared UI from desktop and client app
> composition. Do not fork components or refactor unrelated features.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- src/renderer client/src electron.vite.config.ts client/vite.config.ts svelte.config.js`
> Stop on material renderer-entry or mode ownership drift.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 011
- **Category**: migration, architecture, dx
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

Desktop and standalone clients share one large Svelte workspace, but the client
currently reaches into desktop renderer source. A workspace-ui package provides
one implementation with an explicit Svelte and Tailwind project boundary.

## Current state

- `client/vite.config.ts:11-16` describes direct renderer reuse.
- `client/src/App.svelte:4-60` imports shared renderer contexts, hooks,
  components, and utilities.
- `src/renderer/main.ts` is desktop bootstrap and must remain app-owned.
- `src/renderer/index.css:5-10` scans renderer and client source together.
- Editor and Pill modes stay mounted independently and must keep that behavior.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- Shared components, contexts, stores, hooks, utilities, and styles from
  `src/renderer` to `packages/workspace-ui/src`
- Desktop renderer app composition under `apps/desktop`
- Standalone client composition imports
- `@solus/workspace-ui` manifest, TypeScript config, and Svelte config
- Tailwind source declarations
- Vite aliases and scripts that import renderer utilities
- Boundary tests

**Out of scope**:

- UI redesign or restyling
- Component refactors unrelated to ownership
- Mode lifecycle changes
- New shared primitive packages
- Desktop or client feature differences

## Steps

### Step 1: Classify renderer files

List each top-level renderer entry and feature root as desktop-owned or shared.
Desktop-owned files include bootstrap, native readiness, and desktop
composition. Shared files include reusable features and stores.

Split a file only where native bootstrap and shared UI are concretely mixed.

**Verify**: every current renderer file has one target owner.

### Step 2: Create `@solus/workspace-ui`

Create a private source-exported Svelte package depending on contracts and
client-core. Add package-local `tsconfig.json` and `svelte.config.js`.

Do not require publication or a generated package build for local Vite use.

**Verify**: package-local Svelte/TypeScript check exits 0.

### Step 3: Move shared source

Use `git mv` for shared features. Update desktop and client imports to focused
`@solus/workspace-ui/<feature>` paths. Do not create an eager app-wide barrel.

Update scripts such as icon collection and performance benchmarks.

**Verify**: no workspace-ui source imports apps, server, Electron, or preload
implementation.

### Step 4: Make Tailwind ownership explicit

Move shared CSS ownership into workspace-ui or a clearly documented app import.
Each product app must scan:

- its own source;
- `@solus/workspace-ui` source.

It must not scan the other app or the complete repository. Preserve light,
dark, responsive, and mobile utilities.

**Verify**: desktop and client builds both complete and Tailwind no longer uses
the old `../../client/src` cross-root source.

### Step 5: Tighten project scope

Remove renderer source includes from client `tsconfig.json` and broad Vite
filesystem access that is no longer required. Tighten boundary tests.

**Verify**:

```bash
bun test tests/unit/workspace-boundaries.test.ts
bun run test:unit
bun run lint
bun run build
```

All pass.

## Test plan

- Preserve existing mode mounting, focus, store, and UI standard tests.
- Add boundary tests for forbidden app/native imports.
- Keep desktop and responsive client builds as the integrated proof.
- Do not start a dev server without permission.

## Done criteria

- [ ] Desktop and client import one workspace-ui package.
- [ ] Workspace UI imports no app, server, Electron, or preload implementation.
- [ ] App TypeScript configs do not include workspace-ui source directly.
- [ ] Tailwind scans only each app and workspace-ui.
- [ ] Editor and Pill mode behavior is unchanged.
- [ ] Tests, lint, and build pass.

## STOP conditions

- Desktop and client require duplicated components.
- Shared UI requires Electron objects.
- The move requires changing mounted-mode behavior.
- Tailwind cannot consume package source without scanning unrelated apps.

## Maintenance notes

Promote code to workspace-ui only when both product clients use it. App-specific
composition stays in the app.
