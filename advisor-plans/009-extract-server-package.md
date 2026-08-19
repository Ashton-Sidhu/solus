# Plan 009: Extract an Electron-free Solus server package

> **Executor instructions**: Separate runtime-neutral backend behavior from
> Electron without changing RPC or lifecycle behavior. Do not move desktop
> entry files yet.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- src/main src/preload electron.vite.config.ts packaging scripts tests/unit/electron-import-allowlist.test.ts`
> Stop if main-process ownership changed materially.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 008
- **Category**: architecture, migration
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

`src/main` currently contains both Electron shell code and the server used by
local and standalone operation. A correct app boundary requires one
Electron-free server implementation that both process entries compose.

## Current state

- `src/main/control-plane.ts` owns session orchestration.
- `src/main/server/` owns HTTP, WebSocket, and domain handlers.
- `src/main/standalone.ts` is the standalone entry.
- `electron.vite.config.ts:63-66` builds desktop main, standalone server, and a
  worker from `src/main`.
- `tests/unit/electron-import-allowlist.test.ts:7-14` lists static Electron
  imports, including:
  - `src/main/index.ts`
  - `src/main/desktop-notifications.ts`
  - `src/main/updater.ts`
  - `src/main/server/handlers/file-handlers.ts`
  - `src/main/server/handlers/theme-handlers.ts`
  - `src/main/transcription/index.ts`

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- Transport-neutral modules under `src/main/` to `packages/server/src/`
- `packages/server/package.json` and `tsconfig.json`
- Imports from main, preload, tests, scripts, and packaging
- Narrow host-service inputs required by two existing runtimes
- Electron-dependent server handlers
- Boundary and Electron allowlist tests
- Build configuration required to consume the package

**Out of scope**:

- Moving Electron shell files to `apps/desktop`
- Moving standalone entry to `apps/standalone-server`
- RPC behavior changes
- Provider protocol changes
- New speculative platform framework
- Packaging output changes

## Steps

### Step 1: Classify `src/main`

Write a temporary migration inventory in the plan's implementation notes or PR
description with three groups:

1. server package;
2. desktop shell;
3. process entry or worker requiring a separate decision.

Use Electron imports, process lifecycle, and direct callers as evidence. Do not
classify by folder name alone.

**Verify**: every tracked file under `src/main` appears exactly once in the
inventory.

### Step 2: Resolve Electron-dependent handlers

For `file-handlers.ts`, `theme-handlers.ts`, notifications, transcription, and
any other Electron import found by the allowlist:

- move desktop-shell capability to local API if remote clients do not need it;
- otherwise inject the smallest existing host capability needed by both
  desktop and standalone runtimes;
- keep native implementation outside the server package.

An injected capability must perform work or enforce a boundary. Do not add
pass-through wrappers.

**Verify**: focused tests for each affected handler pass and contract shapes do
not change unintentionally.

### Step 3: Create `@solus/server`

Create a private ESM package depending on `@solus/contracts`. Move
transport-neutral control plane, agent, server, transport, git, task,
automation, Folio, plan, review, session, provider, Google, project-config, and
platform-neutral behavior with `git mv`.

Keep package exports narrow. Most consumers should use one server construction
entry and focused test-only exports, not backend internals.

**Verify**: package-local TypeScript check exits 0.

### Step 4: Keep current entries as temporary composition roots

Update existing desktop and standalone entries to construct the package.
Preserve current input options, data paths, logging, shutdown, and output
locations. Do not move entries until Plan 010.

**Verify**:

```bash
bun run test:unit
bun run lint
bun run build
```

All exit 0.

### Step 5: Enforce Electron freedom

Tighten boundary tests so `packages/server/src` cannot import Electron,
desktop, preload, renderer, client-core, or workspace-ui. Update the Electron
allowlist to point only at files that remain outside the server package.

**Verify**:
`bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts`
passes.

## Test plan

- Add characterization tests before changing Electron-dependent handlers.
- Assert desktop and standalone composition receive equivalent server behavior.
- Keep deterministic event and lifecycle assertions; do not add arbitrary
  sleeps.
- Use temporary data directories only.

## Done criteria

- [ ] `@solus/server` owns transport-neutral backend behavior.
- [ ] The package has no Electron import.
- [ ] Existing desktop and standalone entries construct the same package.
- [ ] RPC, persistence, provider, and lifecycle tests pass.
- [ ] Unit tests, lint, and build pass.

## STOP conditions

- Desktop and standalone need different server implementations.
- Extraction requires changing RPC behavior.
- A handler's local-versus-remote ownership is ambiguous.
- A test requires live Solus data.
- Generated provider code needs manual edits.

## Maintenance notes

The server package is reusable runtime behavior, not a generic framework.
Create host-service inputs only where two existing process implementations
prove the need.
