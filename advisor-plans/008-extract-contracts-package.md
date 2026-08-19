# Plan 008: Extract the shared contracts package

> **Executor instructions**: Move contracts before any consumer package.
> Preserve focused modules and RPC identity. Do not create a large barrel.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- src/shared src/preload src/renderer/main.ts src/main tests scripts package.json tsconfig.json`
> Stop on material contract or generator drift.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 007
- **Category**: migration, tech-debt
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

Contracts are the lowest shared dependency across server, preload, desktop, and
remote clients. Extracting them first gives every later package a stable import
boundary and prevents RPC declarations from being copied.

## Current state

- `src/shared/rpc.ts` declares the typed RPC surface.
- `src/shared/types.ts` and focused files such as `task-types.ts`, `review.ts`,
  and `git-types.ts` define cross-process domain types.
- `src/renderer/main.ts:8` imports renderer-safe preload types through
  `../preload`.
- `client/tsconfig.json:13-17` aliases and includes `src/shared`.
- Scripts and tests import `src/shared` by relative path.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install workspace | `bun install` | exit 0 |
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `src/shared/` to `packages/contracts/src/`
- `packages/contracts/package.json` (new)
- `packages/contracts/tsconfig.json` (new)
- Shared renderer-safe interface types currently owned by `src/preload`
- Imports under `src/`, `client/`, `tests/`, and `scripts/`
- Root aliases and workspace dependencies
- `tests/unit/workspace-boundaries.test.ts`
- `bun.lock`

**Out of scope**:

- Runtime behavior
- RPC method or event shape changes
- Generated provider type edits
- Server, client-core, or renderer moves
- One aggregate export that imports every contract

## Steps

### Step 1: Define the contracts package

Create private ESM package `@solus/contracts`. Add explicit subpath exports that
preserve focused imports:

```text
@solus/contracts/rpc
@solus/contracts/types
@solus/contracts/task-types
@solus/contracts/review
```

Include every current shared module through an explicit export or a controlled
subpath pattern. Add a package-local TypeScript check.

**Verify**: the package-local check exits 0 before consumer imports change.

### Step 2: Move renderer-safe preload contracts

Identify only interfaces and data shapes that cross preload into the renderer.
Move those types to contracts. Keep Electron objects and preload
implementation in preload.

Update preload and renderer to import the same contract types.

**Verify**: `bun test tests/unit/workspace-boundaries.test.ts` passes.

### Step 3: Move shared source and consumers

Use `git mv src/shared packages/contracts/src`. Update authored imports to
`@solus/contracts/<module>`. Update scripts and tests. Do not edit generated
provider files manually.

Remove the `@shared` alias and direct source includes after the final caller
moves.

**Verify**:

- Search for imports from `src/shared`, relative `shared`, or `@shared` returns
  no authored-code matches.
- `bun run lint` exits 0.
- `bun run test:unit` exits 0.
- `bun run build` exits 0.

### Step 4: Tighten boundary tests

Remove the current `src/shared` compatibility rule. Assert that contracts have
no imports from another workspace package, app, Electron, or Node-only module.

**Verify**: `bun test tests/unit/workspace-boundaries.test.ts` passes.

## Test plan

- Preserve all existing contract behavior tests.
- Add boundary cases for package subpath imports.
- Verify the RPC registry remains one module used by server and clients.
- Do not add tests that only assert moved file paths without ownership intent.

## Done criteria

- [ ] `@solus/contracts` owns all shared RPC and domain contracts.
- [ ] Renderer-safe preload types are transport-neutral.
- [ ] No authored import points to `src/shared` or `@shared`.
- [ ] Contracts import no app or other package.
- [ ] Package-local check, unit tests, lint, and build pass.

## STOP conditions

- A contract requires an Electron object or local filesystem assumption.
- A generated file needs manual editing.
- Consumers require two physical copies of the RPC module.
- The package must be published or prebuilt for local builds.

## Maintenance notes

New cross-process data starts in contracts. Provider-native events must stay at
the adapter boundary unless intentionally normalized.
