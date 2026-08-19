# Plan 007: Enforce workspace dependency boundaries before moving code

> **Executor instructions**: Add tests and empty workspace scaffolding only.
> Do not move production source in this plan. Run every verification gate.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- package.json bun.lock tests/unit/electron-import-allowlist.test.ts`
> Stop if the package manager or boundary-test pattern changed.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 006
- **Category**: tests, dx
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

File moves without dependency checks can preserve the current coupling under
new aliases. This plan encodes the target graph before extraction and adds the
Bun workspace declaration required by later plans.

## Current state

- Root `package.json` has no `workspaces` field.
- `tests/unit/electron-import-allowlist.test.ts:16-42` recursively reads source
  files and reports imports outside an allowlist.
- `client/tsconfig.json:17` directly includes three external source trees.
- There is no test that prevents package-to-app or app-to-app imports.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install links | `bun install` | exit 0 |
| Focused tests | `bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `package.json`
- `bun.lock`
- `tests/unit/workspace-boundaries.test.ts` (new)
- `tests/unit/electron-import-allowlist.test.ts` only if shared traversal code
  is extracted without changing its assertions

**Out of scope**:

- Production source moves
- New runtime dependencies
- Task orchestrators
- TypeScript project references
- Product behavior

## Steps

### Step 1: Add Bun workspace discovery

Add:

```json
"workspaces": ["apps/*", "packages/*"]
```

Do not add empty package manifests. Bun may discover zero workspaces until Plan
008 creates the first package.

**Verify**: `bun install` exits 0 and changes only expected lockfile metadata.

### Step 2: Add a boundary-test harness

Create `tests/unit/workspace-boundaries.test.ts`, following
`tests/unit/electron-import-allowlist.test.ts`.

The test must inspect `.ts`, `.svelte.ts`, and `.svelte` files. It must detect
static imports, literal dynamic imports, and re-exports. Keep rules represented
as exact directory/package relationships, not one broad regular expression.

During migration, support both current and target roots explicitly. The
temporary old-root entries must be removed by Plan 014.

Encode these rules:

- contracts cannot import apps or other packages;
- server cannot import apps, client packages, renderer code, or Electron;
- client-core cannot import apps, server, or workspace-ui;
- workspace-ui cannot import apps, server, preload implementation, or Electron;
- one app cannot import another app's source;
- extracted packages cannot use relative imports that escape package source.

**Verify**:
`bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts`
passes.

### Step 3: Establish the baseline

Run the full focused baseline without changing production files.

**Verify**:

```bash
bun run test:unit
bun run build
```

Both commands exit 0.

## Test plan

- Test one allowed edge and every forbidden edge with fixture import strings.
- Test `.ts`, `.svelte.ts`, and `.svelte` discovery.
- Test static import, dynamic import, and re-export detection.
- Test that offender output contains the source and imported path.

## Done criteria

- [ ] Root package declares `apps/*` and `packages/*` workspaces.
- [ ] Boundary tests describe the Plan 006 graph.
- [ ] Temporary current-path rules are explicit and removable.
- [ ] Focused and full unit tests pass.
- [ ] The build passes.
- [ ] No production source moved.

## STOP conditions

- Reliable import detection requires adding a large parser dependency.
- Existing tests or build fail before this plan's changes.
- The root package is no longer managed by Bun.

## Maintenance notes

Every later extraction plan must tighten this test. Never leave a completed
package covered by a temporary old-root exception.
