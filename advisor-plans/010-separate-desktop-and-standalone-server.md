# Plan 010: Create desktop and standalone-server app composition roots

> **Executor instructions**: Move process entry and shell ownership after the
> server package exists. Preserve release outputs and process behavior.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- src/main src/preload src/renderer electron.vite.config.ts package.json packaging scripts .github/workflows`
> Stop if packaging or entry ownership changed.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 009
- **Category**: migration, architecture
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

Deployable processes need explicit composition roots. Desktop should own
Electron and local server hosting. Standalone server should own Node process
lifecycle. Neither app should own backend domain logic.

## Current state

- `electron.vite.config.ts:63-66` builds desktop and standalone entries from
  `src/main`.
- `src/preload/index.ts` exposes the desktop renderer-safe API.
- Root `package.json:125-131` packages fixed `dist` outputs.
- `forge.config.js:117-166` owns Electron packaging and native dependencies.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 with existing `dist/*` outputs |

## Scope

**In scope**:

- Electron-specific `src/main` files to `apps/desktop/src/main`
- `src/preload` to `apps/desktop/src/preload`
- Desktop renderer entry-only files to `apps/desktop/src/renderer`
- Standalone entry to `apps/standalone-server/src`
- App manifests and TypeScript configs
- Electron Vite, packaging, scripts, and CI paths
- Boundary tests

**Out of scope**:

- Shared renderer feature moves
- Client-core moves
- Server domain changes
- Output directory changes
- UI changes

## Steps

### Step 1: Create app manifests

Create private ESM packages `@solus/desktop` and
`@solus/standalone-server`. Both depend on `@solus/server` and
`@solus/contracts`. Put only directly imported third-party dependencies in each
manifest.

**Verify**: both package-local TypeScript checks resolve workspace dependencies.

### Step 2: Move standalone composition

Move the standalone entry and process-only helpers to
`apps/standalone-server/src`. It owns environment, arguments, signals, process
exit, and Node host-service implementations. It constructs `@solus/server`.

**Verify**: the standalone build output remains `dist/main/standalone.js` or the
existing equivalent expected by release scripts.

### Step 3: Move Electron composition

Move Electron lifecycle, windows, tray, shortcuts, updater, native services,
and preload under `apps/desktop`. Move only desktop renderer entry files; shared
features remain at their temporary location until Plan 012.

Update imports to `@solus/server` and contracts. Desktop starts and stops the
local server through one composition path.

**Verify**: Electron static imports are confined to `apps/desktop`.

### Step 4: Update build and packaging paths

Update `electron.vite.config.ts`, root scripts, Forge/Builder configuration,
release workflows, and scripts. Keep:

```text
dist/main
dist/preload
dist/renderer
dist/client
```

**Verify**: `bun run build` exits 0 and produces all expected output roots.

### Step 5: Tighten boundaries

Reject imports from `packages/server` into either app and imports between the
two apps.

**Verify**:

```bash
bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts
bun run test:unit
bun run lint
```

All pass.

## Test plan

- Update Electron allowlist paths without weakening its rule.
- Add composition tests that inject fake host services.
- Verify shutdown and failed-start cleanup without real data.
- Keep existing packaging assertions where present.

## Done criteria

- [ ] Desktop owns every Electron import.
- [ ] Standalone server owns Node process lifecycle.
- [ ] Both apps construct `@solus/server`.
- [ ] Apps do not import each other.
- [ ] Release output paths do not change.
- [ ] Boundary tests, unit tests, lint, and build pass.

## STOP conditions

- Packaging requires copying workspace source manually.
- Desktop requires a private server fork.
- Standalone operation depends on Electron.
- Release output paths must change.

## Maintenance notes

Native shell behavior belongs in desktop local API. Remote product behavior
belongs in contracts and server.
