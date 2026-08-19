# Plan 014: Remove migration compatibility paths and finalize ownership

> **Executor instructions**: Remove only migration scaffolding that is no
> longer needed. Do not perform new architecture work in this plan.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- package.json tsconfig.json apps packages src client web tests/unit docs AGENTS.md`
> Compare the final tree with Plan 006 before cleanup.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 007–013
- **Category**: migration, docs, dx
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

A migration is incomplete while old aliases, source roots, allowlists, or broad
TypeScript includes remain. This plan makes the package graph authoritative and
records the final ownership for maintainers and agents.

## Current state

The exact current state depends on Plans 007–013. Expected temporary elements
include old path aliases, dual-root boundary-test support, redirecting scripts,
and docs that still name pre-migration paths.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Boundary tests | `bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts` | all pass |
| Unit tests | `bun run test:unit` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |
| Site check | `bun run --cwd apps/site check` | exit 0 |
| Site build | `bun run --cwd apps/site build:site` | exit 0 |

## Scope

**In scope**:

- Temporary aliases, includes, compatibility scripts, and boundary exceptions
- Empty old directories
- Root and package scripts
- `tests/unit/workspace-boundaries.test.ts`
- `tests/unit/electron-import-allowlist.test.ts`
- New architecture ADR
- `AGENTS.md` Codebase Map
- User and developer docs with active old paths

**Out of scope**:

- New package extraction
- Dependency upgrades
- Behavior changes
- Historical documentation that clearly describes an old release

## Steps

### Step 1: Remove old roots and aliases

Delete empty old roots and all aliases/includes that point to:

```text
src/shared
src/client-core
src/renderer
src/main
client
web
```

Only remove `src/main` after Plans 009 and 010 account for every file. Do not
delete a nonempty directory without identifying every remaining owner.

**Verify**: searches find no active import, build, test, packaging, or CI
reference to old roots.

### Step 2: Make boundary tests final

Remove dual-root migration support and temporary exceptions. Enforce only the
Plan 006 app/package graph. Keep the Electron allowlist confined to desktop.

**Verify**:
`bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts`
passes.

### Step 3: Normalize root commands

Ensure root scripts provide canonical install, check, lint, unit-test, desktop
build, client build, standalone-server build, and site check/build commands.
Use Bun workspace commands or explicit `--cwd`; do not add an orchestrator.

**Verify**: every documented command exits 0.

### Step 4: Record the architecture

Add an ADR under `docs/adr/`, matching the repository's Context, Decision, and
Consequences format. Record:

- app and package ownership;
- allowed dependency graph;
- desktop and standalone server composition;
- desktop and client workspace UI composition;
- local API versus RPC ownership;
- Tailwind source ownership;
- why apps do not import apps.

Update the `AGENTS.md` Codebase Map and active docs to exact current paths.

**Verify**: every path named in the ADR and Codebase Map exists.

### Step 5: Run final gates

Run:

```bash
bun run test:unit
bun run lint
bun run build
bun run --cwd apps/site check
bun run --cwd apps/site build:site
```

All commands exit 0.

## Test plan

- Boundary tests are the primary new architecture proof.
- Existing unit and build suites prove behavior and output compatibility.
- Do not start a dev server or run Playwright without explicit approval.

## Done criteria

- [ ] No old source root remains active.
- [ ] No compatibility alias or broad cross-package include remains.
- [ ] Boundary tests enforce only the final graph.
- [ ] Desktop owns all Electron imports.
- [ ] Server is Electron-free.
- [ ] Apps import packages, never apps.
- [ ] Every package has a local check.
- [ ] ADR and Codebase Map match the final tree.
- [ ] Unit tests, lint, all builds, and site check pass.

## STOP conditions

- An old root still contains owned source.
- A compatibility alias has an unexplained active caller.
- Final verification exposes a behavior change from an earlier plan.
- Documentation and source disagree about ownership.

## Maintenance notes

Future package proposals must identify a second real owner or a process
boundary. Do not create packages only to reduce directory size.
