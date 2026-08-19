# Plan 013: Move remaining deployable entries into apps

> **Executor instructions**: Perform path-only app moves after package imports
> are stable. Do not change product behavior or dependency versions.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- client web src/cli package.json scripts tests .github/workflows packaging`
> Stop if an app's product role changed.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 012
- **Category**: migration
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

After shared dependencies are packages, the remaining deployable roots can move
without cross-root source aliases. This completes the visible app/package
structure and gives Helix a local config for each app.

## Current state

- `client/` is the standalone product client.
- `web/` is the SvelteKit and Cloudflare site.
- `src/cli/` is the CLI entry region.
- Root scripts and demo fixture scripts use these paths directly.
- `package.json:125-131` requires stable release output paths.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Client checks | package-local check | exit 0 |
| Site check | `bun run --cwd apps/site check` | exit 0 |
| Site build | `bun run --cwd apps/site build:site` | exit 0 |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `client/` to `apps/client/`
- `web/` to `apps/site/`
- `src/cli/` to `apps/cli/src/` if CLI is independently deployable
- App manifests and local configs
- Root scripts, CI, tests, scripts, docs, and packaging paths
- Boundary tests

**Out of scope**:

- Dependency upgrades or version alignment
- SvelteKit, Cloudflare, Electron, or Vite migrations
- UI or server changes
- Output path changes

## Steps

### Step 1: Move standalone client

Use `git mv client apps/client`. Update root scripts, Vite config paths, demo
fixtures, service worker paths, tests, and CI.

The app must consume contracts, client-core, and workspace-ui as workspace
dependencies. Its TypeScript include must own only local app source and
generated local types.

**Verify**: client-local check and `bun run build` pass.

### Step 2: Move site

Use `git mv web apps/site`. Update root scripts and workflows. Preserve its
current SvelteKit, Cloudflare, Svelte, and Vite versions.

**Verify**:

```bash
bun run --cwd apps/site check
bun run --cwd apps/site build:site
```

Both pass.

### Step 3: Decide and move CLI

Confirm whether `src/cli` is an independently deployable process. If yes, move
it to `apps/cli/src` with a private manifest and local config. If it is only a
library used by another app, STOP and update Plan 006 ownership rather than
forcing an app boundary.

**Verify**: existing CLI tests and packaging commands pass.

### Step 4: Update all path consumers

Update scripts, tests, packaging, docs, and CI. Search for stale current roots.
Keep release outputs unchanged.

**Verify**:

```bash
bun test tests/unit/workspace-boundaries.test.ts
bun run test:unit
bun run lint
bun run build
```

All pass.

## Test plan

- Preserve standalone client, site, and CLI tests.
- Add path boundary assertions only where they encode app ownership.
- Verify site separately because it has its own SvelteKit check.

## Done criteria

- [ ] Product client is under `apps/client`.
- [ ] Site is under `apps/site`.
- [ ] CLI ownership is explicitly decided.
- [ ] Each app has local project configuration.
- [ ] No app imports another app's source.
- [ ] Release outputs remain unchanged.
- [ ] Checks, tests, lint, and builds pass.

## STOP conditions

- CLI is not independently deployable.
- A path move requires a behavior or dependency-version change.
- Packaging output must change.
- Site imports product internals unexpectedly.

## Maintenance notes

The site and product client are different apps. Do not merge them because both
use Svelte.
