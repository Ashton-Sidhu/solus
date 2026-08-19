# Plan 011: Extract client connection behavior into client-core

> **Executor instructions**: Move transport and host connection behavior
> without changing reconnect or host-selection semantics.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- src/client-core src/renderer client/src tests/unit package.json tsconfig.json`
> Stop on material connection-lifecycle drift.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 010
- **Category**: migration, architecture
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

Desktop and remote clients share host connections, WebSocket transport,
supervision, and API selection. Those behaviors need one renderer-safe package
that does not depend on either app or the workspace UI.

## Current state

- `src/client-core/` owns host API, WebSocket transport, connection state,
  server registry, supervision, pairing, and snapshots.
- `electron.vite.config.ts:103` aliases `@client-core`.
- `client/vite.config.ts:26` aliases the same source directory.
- `client/tsconfig.json:14-17` directly includes client-core source.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `src/client-core` to `packages/client-core/src`
- Package manifest, exports, and TypeScript config
- Desktop, renderer, and standalone-client imports
- Vite and TypeScript aliases/includes
- Existing client-core tests
- Boundary tests

**Out of scope**:

- Reconnect behavior changes
- API widening casts
- Workspace UI moves
- App moves
- New transport abstraction

## Steps

### Step 1: Create `@solus/client-core`

Create a private ESM package depending on `@solus/contracts`. Export focused
modules rather than one eager barrel. Add a package-local check.

**Verify**: package-local check exits 0.

### Step 2: Move source and imports

Use `git mv`. Replace `@client-core` and direct source imports with
`@solus/client-core/<module>`. Update desktop and client manifests.

Remove old Vite aliases and TypeScript includes after the final caller moves.

**Verify**: search finds no authored `@client-core` or `src/client-core` import.

### Step 3: Enforce ownership

Reject client-core imports from apps, server, workspace-ui, Electron, or preload
implementation.

**Verify**:

```bash
bun test tests/unit/workspace-boundaries.test.ts
bun run test:unit
bun run lint
bun run build
```

All pass.

## Test plan

- Preserve existing transport, reconnect, receipt, registry, and supervision
  tests.
- Test package boundary rules.
- Do not replace deterministic lifecycle assertions with timeouts.

## Done criteria

- [ ] `@solus/client-core` owns shared client connection behavior.
- [ ] It depends only on contracts and direct third-party dependencies.
- [ ] No old alias or direct include remains.
- [ ] Boundary tests, unit tests, lint, and build pass.

## STOP conditions

- Client-core requires a Svelte component or app store.
- Desktop and web require different connection implementations.
- The move changes reconnect or host selection semantics.

## Maintenance notes

Keep durable renderer state in feature stores. Client-core owns connections, not
workspace UI state.
