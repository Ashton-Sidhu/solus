# Plan 006: Split Solus into bounded Bun workspaces without changing product behavior

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This is a multi-PR migration. Keep every step independently
> buildable. Do not perform all file moves in one commit. If anything in the
> "STOP conditions" section occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 64bb1db6..HEAD -- package.json bun.lock tsconfig.json svelte.config.js electron.vite.config.ts client web src/client-core src/shared src/renderer src/preload src/main scripts tests/unit .github/workflows`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> material mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L, split across four or more pull requests
- **Risk**: HIGH
- **Depends on**: none
- **Category**: tech-debt, migration, dx
- **Planned at**: commit `64bb1db6`, 2026-08-19

## Why this matters

Solus already contains three client build roots and two shared source trees, but
they are not package boundaries. The standalone client reaches directly into
`src/renderer`, `src/shared`, and `src/client-core`; its TypeScript project
includes those directories as source; and Tailwind explicitly scans both the
renderer and client trees from one CSS file. This makes Svelte, TypeScript, and
Tailwind treat much of the repository as one overlapping project.

The target is a Bun workspace in which each app has a small entry package and
shared code has explicit package ownership. This must not fork the workspace UI
or change desktop, web, mobile-layout, server, RPC, packaging, or runtime
behavior. The migration is successful when opening a file under an app gives
Helix that app as its nearest project root, while imported workspace packages
remain navigable as separate projects.

This migration is not justified only by editor performance. It is worth doing
only if maintainers also want enforceable package ownership and independent app
verification. If that broader goal is not accepted, keep the current source
layout and use editor configuration instead.

## Target structure

Use this structure as the intended end state for the client code:

```text
apps/
  desktop/
    package.json
    tsconfig.json
    svelte.config.js
    src/
      App.svelte
      main.ts
      index.html
      boot-scene.ts
  client/
    package.json
    tsconfig.json
    svelte.config.js
    src/
  site/
    package.json
    tsconfig.json
    svelte.config.js
    src/

packages/
  contracts/
    package.json
    tsconfig.json
    src/
  client-core/
    package.json
    tsconfig.json
    src/
  workspace-ui/
    package.json
    tsconfig.json
    svelte.config.js
    src/

src/
  main/
  preload/
  cli/
```

Package roles:

- `@solus/contracts` owns the current `src/shared` RPC and domain contracts.
  It must not import from an app, `client-core`, `workspace-ui`, Electron, or
  Node-only server code.
- `@solus/client-core` owns host connections, transport, connection state, and
  client-side host supervision. It may depend on `@solus/contracts`; it must
  not depend on an app or `@solus/workspace-ui`.
- `@solus/workspace-ui` owns reusable Svelte components, contexts, stores,
  hooks, shared styles, and renderer utilities. It may depend on contracts and
  client-core. It must not import Electron or an app entry.
- `@solus/desktop` owns the Electron renderer bootstrap and desktop-specific
  `App.svelte` composition. It may depend on all three shared packages.
- `@solus/client` owns the standalone responsive web client, including its
  mobile layout. It may depend on all three shared packages.
- `@solus/site` owns the existing SvelteKit site under `web/`. It must remain
  independent from the product client unless an explicit product decision says
  otherwise.
- The root package continues to own `src/main`, `src/preload`, `src/cli`,
  Electron packaging, the standalone server build, tests, and repository-level
  commands during this migration. Moving the host/server backend into a package
  is explicitly deferred.

## Current state

- `package.json:8-34` owns desktop, server, client, tests, and build scripts in
  one manifest. It has no `workspaces` declaration.
- `package.json:11-16` builds the Electron app and then changes directory into
  `client/`.
- `package.json:125-131` packages `dist/main`, `dist/preload`,
  `dist/renderer`, and `dist/client`; these output paths are release contracts.
- `tsconfig.json:20-21` includes all of `src/**/*`, so renderer, preload, main,
  client-core, and contracts share one TypeScript project.
- `client/tsconfig.json:11-18` maps aliases outside the package and directly
  includes `../src/renderer`, `../src/shared`, and `../src/client-core`.
- `client/vite.config.ts:11-16` states that the standalone client mounts the
  Electron renderer directly.
- `client/vite.config.ts:23-27` aliases three package-like names to source
  directories outside `client/`.
- `client/vite.config.ts:45-48` allows Vite to serve the entire repository root
  because of those cross-root imports.
- `client/src/App.svelte:4-60` imports workspace stores, hooks, components, and
  utilities directly from `@renderer`. At the planned commit, 18 files under
  `client/src` contain 77 imports from `@renderer`.
- At the planned commit, at least 100 renderer/client-core files contain 125
  imports from `src/shared` or `@shared`. These imports must become package
  imports before the source directories move.
- `src/renderer/main.ts:8` imports preload types through a relative path. The
  native bootstrap contract must move to `@solus/contracts` before
  `workspace-ui` can be independent.
- `src/renderer/index.css:5-10` explicitly scans both `src/renderer` and
  `client/src`:

  ```css
  @source ".";
  @source "../../client/src";
  ```

- `electron.vite.config.ts:99-105` treats `src/renderer` as the desktop root and
  aliases `src/client-core` and `src/renderer`.
- `electron.vite.config.ts:123-139` owns Svelte/Tailwind plugins and desktop
  renderer output at `dist/renderer`.
- `client/vite.config.ts:50-57` owns standalone client output at `dist/client`.
- `scripts/vite-icon-collections.ts:5-7`,
  `scripts/generate-app-icons.ts:16-20`, `scripts/perf-benchmark.ts:15-20`, and
  `scripts/capture-demo-fixtures.ts:8-22` import current source paths directly.
- `tests/unit/electron-import-allowlist.test.ts:16-42` is the repository's
  existing pattern for a source-boundary test: recursively list files, inspect
  imports, and assert an empty offender list.
- `tests/unit/electron-import-allowlist.test.ts:7-14` also shows that
  `src/main` is mostly transport-neutral but still has an intentional Electron
  allowlist. Do not combine backend extraction with this client migration.
- `web/package.json:1-31` is a SvelteKit/Cloudflare site with different Svelte
  and Vite versions from the product client. Treat it as `apps/site`, not as
  the standalone Solus client.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install workspace links | `bun install` | exit 0; `bun.lock` contains the workspace manifests |
| Focused unit tests | `bun test tests/unit/workspace-boundaries.test.ts` | all boundary tests pass |
| Unit suite | `bun run test:unit` | exit 0; all unit tests pass |
| Lint | `bun run lint` | exit 0; no lint errors |
| Desktop and standalone client build | `bun run build` | exit 0; `dist/main`, `dist/preload`, `dist/renderer`, and `dist/client` are produced |
| SvelteKit site check | `bun run --cwd apps/site check` | exit 0; no Svelte or TypeScript errors |
| SvelteKit site build | `bun run --cwd apps/site build:site` | exit 0; site build completes |

Do not start a development server, open a browser, run the full Playwright
suite, package/sign the Electron app, or use live Solus data during this
migration unless the developer explicitly requests that verification.

## Scope

**In scope**:

- Root workspace and build ownership:
  - `package.json`
  - `bun.lock`
  - `tsconfig.json`
  - `svelte.config.js`
  - `electron.vite.config.ts`
  - `playwright.config.ts`
  - `.github/workflows/test.yml`
  - `.github/workflows/release.yml`
  - `.github/workflows/release-server.yml`
- App directories:
  - `client/` to `apps/client/`
  - `web/` to `apps/site/`
  - desktop renderer entry files from `src/renderer/` to `apps/desktop/`
- Shared package directories:
  - `src/shared/` to `packages/contracts/src/`
  - `src/client-core/` to `packages/client-core/src/`
  - reusable `src/renderer/` code to `packages/workspace-ui/src/`
- Direct path consumers under:
  - `src/main/`
  - `src/preload/`
  - `scripts/`
  - `tests/`
  - `packaging/`
- New package manifests, package-local TypeScript configs, Svelte configs, and
  `tests/unit/workspace-boundaries.test.ts`.
- A new ADR under `docs/adr/` that records package ownership and dependency
  direction after the boundaries have been proven.

**Out of scope**:

- No product behavior, UI, styles, RPC methods, event topics, persistence, or
  connection semantics may change.
- Do not split components into new design-system packages.
- Do not duplicate or fork renderer components for desktop and web.
- Do not extract `src/main`, the Solus server, provider adapters, or domain
  managers into packages.
- Do not migrate from Bun, Electron Vite, Vite, Svelte, Tailwind, Playwright,
  Electron Builder, or Electron Forge.
- Do not standardize dependency versions between `apps/site` and the product
  apps as part of file movement.
- Do not change output directories consumed by packaging.
- Do not introduce a task orchestrator such as Turborepo, Nx, Lage, or Moon.
  Bun workspaces and explicit root scripts are sufficient.
- Do not add TypeScript project references until package-local typechecks work
  without them. They are not required for the language-server boundary.

## Git workflow

- Use one branch per independently shippable stage:
  - `refactor/workspace-contracts`
  - `refactor/workspace-client-core`
  - `refactor/workspace-ui`
  - `refactor/workspace-app-shells`
- Use conventional commit titles, for example:
  `refactor(workspaces): extract shared contracts`.
- Preserve file history with `git mv` for deliberate moves. Do not use git to
  discard unrelated work, and never use `git stash`.
- Do not push or open a pull request unless the developer explicitly asks.

## Steps

### Step 1: Add characterization checks before moving files

Create `tests/unit/workspace-boundaries.test.ts`, modeled on
`tests/unit/electron-import-allowlist.test.ts`.

Before any move, encode these target dependency rules in a way that can run
during the migration:

1. Contracts cannot import from `client-core`, renderer/workspace UI, apps,
   Electron, or Node-only main code.
2. Client-core cannot import from renderer/workspace UI or apps.
3. Workspace UI cannot import from apps, preload implementation files, main, or
   Electron.
4. Apps may import packages but no app may import another app's `src`.
5. After each package is extracted, reject relative imports that escape that
   package's `src` directory.

The test may temporarily accept both old and new directory names while a stage
is in progress, but each stage must remove its old-path allowance before it
lands. Do not add a permanent broad allowlist.

Also add focused build-output assertions only if an existing test already owns
that concern. Do not make a unit test invoke Vite.

**Verify**:
`bun test tests/unit/workspace-boundaries.test.ts tests/unit/electron-import-allowlist.test.ts`
must exit 0.

### Step 2: Declare Bun workspaces without moving runtime code

Add root workspace globs:

```json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

Create package directories and manifests only when their source is ready to
move; do not create empty placeholder packages that cannot typecheck. Root
scripts must continue to be the canonical commands. Add scoped scripts only
when the corresponding package exists.

Use private package names:

- `@solus/desktop`
- `@solus/client`
- `@solus/site`
- `@solus/contracts`
- `@solus/client-core`
- `@solus/workspace-ui`

Set every package to `"private": true` and `"type": "module"` unless an existing
CommonJS entry requires otherwise. Use `"workspace:*"` for internal
dependencies. Keep third-party dependencies in the package that imports them;
do not move all root dependencies speculatively.

**Verify**:

1. `bun install` exits 0.
2. `bun run test:unit` exits 0.
3. `bun run build` exits 0.

### Step 3: Extract contracts first

Move `src/shared/` to `packages/contracts/src/`. Give
`@solus/contracts` explicit subpath exports that preserve focused imports such
as `@solus/contracts/rpc`, `@solus/contracts/types`, and
`@solus/contracts/task-types`. Do not replace the focused modules with one
large barrel.

Before moving, relocate renderer-safe preload interface types that are imported
by `src/renderer/main.ts` into the contracts package. Keep Electron objects and
preload implementation details in `src/preload`.

Change importers to `@solus/contracts/...`. Update test and script imports too.
Remove `@shared` path aliases after no source file uses them. The RPC contract
must still be one physical module shared by server, preload, desktop, and
standalone client.

Do not move generated provider types by hand. If a generated file imports a
shared contract, update the generator or an allowed surrounding module instead.

**Verify**:

1. `bun test tests/unit/workspace-boundaries.test.ts` exits 0.
2. A repository search for imports from `src/shared`, `../shared`, or
   `@shared` returns no authored-code matches.
3. `bun run test:unit` exits 0.
4. `bun run lint` exits 0.
5. `bun run build` exits 0.

Land this stage independently before continuing.

### Step 4: Extract client-core second

Move `src/client-core/` to `packages/client-core/src/`. Add explicit package
exports for the existing focused modules. Declare `@solus/contracts` as a
workspace dependency.

Update desktop and standalone-client importers from `@client-core` to
`@solus/client-core`. Remove the old alias only after all callers have moved.
Preserve transport behavior and avoid wrappers that only forward calls.

The package must not read Electron APIs. Native behavior must remain behind the
existing renderer-safe interface and overlay boundaries.

**Verify**:

1. `bun test tests/unit/workspace-boundaries.test.ts` exits 0.
2. A repository search for imports from `src/client-core` or `@client-core`
   returns no authored-code matches.
3. `bun run test:unit` exits 0.
4. `bun run lint` exits 0.
5. `bun run build` exits 0.

Land this stage independently before continuing.

### Step 5: Separate shared workspace UI from app composition

Classify current `src/renderer` files before moving them:

- Desktop-owned entry files include `main.ts`, `index.html`, desktop bootstrap
  code, and the desktop-specific app composition.
- Shared workspace UI includes feature components, contexts, stores, hooks,
  renderer utilities, and shared styles used by both desktop and standalone
  clients.
- If a file mixes native bootstrap behavior and reusable UI, split only at that
  concrete boundary. Do not perform unrelated component refactors.

Move reusable code to `packages/workspace-ui/src/` and add a package-local
`svelte.config.js` and `tsconfig.json`. Keep Svelte source available to Vite;
do not add a prepublish build or generated declaration output unless the
existing bundlers require it.

Move desktop entry code to `apps/desktop/src/`. Create a small desktop
`package.json`, `tsconfig.json`, and `svelte.config.js`. Its dependencies should
include contracts, client-core, and workspace-ui.

Rewrite imports to `@solus/workspace-ui/...`. Preserve focused feature imports;
do not create a single barrel that eagerly imports the mounted application.

Move the shared CSS into workspace-ui. Replace the current cross-directory
Tailwind scan:

```css
@source ".";
@source "../../client/src";
```

with package-aware source declarations owned by each app. Desktop and client
must each scan workspace-ui plus their own local source. Confirm that both
light and dark utilities still compile; do not restyle any surface.

Update `electron.vite.config.ts` so its renderer root points at
`apps/desktop/src` while its output remains `dist/renderer`. Update icon
collection and performance scripts to use package paths.

**Verify**:

1. `bun test tests/unit/workspace-boundaries.test.ts` exits 0.
2. No file under `packages/workspace-ui/src` imports from `apps/`, `src/main`,
   or `src/preload`.
3. `bun run test:unit` exits 0.
4. `bun run lint` exits 0.
5. `bun run build` exits 0 and still produces all four release output roots.

Land this stage independently before continuing.

### Step 6: Move the standalone client and site as path-only app migrations

Move `client/` to `apps/client/` and `web/` to `apps/site/`. Use `git mv`.
Do not change their product roles.

For `apps/client`:

- Replace aliases to repository source directories with workspace package
  imports.
- Reduce `tsconfig.json` to local `src/**/*` plus standard generated types.
- Remove the Vite `server.fs.allow` access to the repository root if no asset
  requires it.
- Keep output at the root `dist/client`.
- Keep the current responsive desktop/mobile layouts and remote WebSocket
  behavior.

For `apps/site`:

- Update only paths affected by the move.
- Keep Cloudflare, SvelteKit, and its current dependency versions.
- Keep the demo build dependency explicit in root scripts.

Update root scripts, CI paths, Playwright setup paths, packaging references,
demo fixture scripts, and documentation. Do not change release output
directories.

**Verify**:

1. `bun run --cwd apps/site check` exits 0.
2. `bun run --cwd apps/site build:site` exits 0.
3. `bun run test:unit` exits 0.
4. `bun run lint` exits 0.
5. `bun run build` exits 0.
6. Searches for authored references to the old `client/`, `web/`,
   `src/renderer`, `src/client-core`, and `src/shared` source paths return no
   stale matches, excluding historical docs that explicitly describe the old
   layout.

### Step 7: Add package-local typecheck commands and enforce the graph

Each workspace package must have a command that checks only that package.
Add root scripts that run them explicitly. Avoid a tool orchestrator.

At minimum, prove:

- contracts typecheck without app globals;
- client-core typechecks with contracts but without renderer globals;
- workspace-ui passes Svelte/TypeScript checks without an app source include;
- desktop checks only its entry source plus imported package declarations;
- standalone client checks only its source plus imported package declarations;
- site continues to pass `svelte-kit sync` and `svelte-check`.

If source-exported Svelte packages cause `svelte-check` to inspect dependencies,
that is acceptable. The important rule is that app `include` arrays do not
claim package source as app-owned source.

**Verify**:

1. Every package-local check command exits 0.
2. Root aggregate check exits 0.
3. `bun run test:unit`, `bun run lint`, and `bun run build` exit 0.

### Step 8: Record and document the accepted package ownership

Add an ADR under `docs/adr/` after the migration proves the target graph. Match
the format of `docs/adr/0013-type-is-declared-on-surfaces.md`: context,
decision, and consequences.

Document:

- the package dependency direction;
- why workspace UI is not a desktop-only package;
- why the responsive standalone client owns mobile layout;
- why the SvelteKit site is separate;
- why server/backend extraction is deferred;
- how app-local Tailwind sources are declared;
- the canonical root build, check, lint, and test commands.

Update the Codebase Map in `AGENTS.md` only after paths have moved. Do not leave
agent instructions pointing at old paths.

**Verify**:

1. All paths in the ADR and Codebase Map exist.
2. `bun run test:unit`, `bun run lint`, and `bun run build` exit 0.

## Test plan

- Add `tests/unit/workspace-boundaries.test.ts` before the first move.
- Model its recursive source inspection and empty-offender assertion on
  `tests/unit/electron-import-allowlist.test.ts`.
- Test each forbidden dependency edge separately so a failure names the broken
  package rule.
- Include `.ts`, `.svelte.ts`, and `.svelte` source files.
- Detect static imports, dynamic imports with literal module names, and
  re-exports. Do not try to build a full TypeScript parser with regular
  expressions; use an existing parser dependency if the current import forms
  cannot be checked reliably.
- Keep `tests/unit/electron-import-allowlist.test.ts` passing and update only its
  source root/allowlist paths when files actually move.
- Existing domain unit tests remain the behavior regression suite.
- The required integrated proof is `bun run build`, not a development server.

## Done criteria

- [ ] Root `package.json` declares Bun workspaces for `apps/*` and `packages/*`.
- [ ] Desktop, standalone client, and site each have a local manifest,
      TypeScript config, and applicable Svelte config.
- [ ] Contracts, client-core, and workspace-ui each have explicit package
      ownership and package-local checks.
- [ ] No app TypeScript config directly includes another package's source
      directory.
- [ ] No app imports another app's `src`.
- [ ] No package uses a relative import that escapes its own source tree.
- [ ] Workspace-ui contains no Electron, preload implementation, or main-process
      imports.
- [ ] Desktop and client consume one shared workspace UI implementation.
- [ ] Tailwind source declarations are app-local and do not require a broad
      repository-root scan.
- [ ] `dist/main`, `dist/preload`, `dist/renderer`, and `dist/client` remain the
      release output paths.
- [ ] `bun test tests/unit/workspace-boundaries.test.ts` passes.
- [ ] Every package-local typecheck passes.
- [ ] `bun run test:unit` passes.
- [ ] `bun run lint` passes.
- [ ] `bun run build` passes.
- [ ] `bun run --cwd apps/site check` passes.
- [ ] `bun run --cwd apps/site build:site` passes.
- [ ] The accepted dependency graph is recorded in an ADR.
- [ ] The `AGENTS.md` Codebase Map names the new paths.
- [ ] The status row for this plan in `advisor-plans/README.md` is updated.

## STOP conditions

Stop and report instead of improvising if:

- Maintainers do not want package ownership and independent app checks beyond
  the Helix performance benefit. In that case this migration is not worth its
  risk.
- Current source no longer matches the ownership facts in this plan.
- Extracting contracts requires sending Electron objects, local filesystem
  assumptions, or provider-native events through the shared client boundary.
- A generated provider file would need a manual edit.
- Workspace packages would need to be published to a registry or prebuilt only
  to make local Vite/Electron builds work.
- A stage changes runtime behavior or release output paths.
- Desktop and standalone client would require duplicate workspace UI source.
- The site turns out to import product renderer internals despite its current
  independent configuration.
- A stage's focused verification fails twice after a reasonable correction.
- Unrelated developer changes are present in a file that must move.

## Maintenance notes

- Reviewers must reject new app-to-app source imports even if Vite can resolve
  them.
- A workspace package may be indexed when an app imports it; that is expected.
  The goal is separate ownership, not making dependencies invisible.
- Opening Helix at the repository root will still show the whole repository in
  the file picker. A file under `apps/desktop` should resolve the desktop app as
  its nearest app project, while files under `packages/workspace-ui` resolve
  the UI package.
- Tailwind can still inspect workspace-ui when building an app because those
  classes are part of that app. It must not inspect unrelated apps.
- Consider extracting the server/backend only in a later ADR and plan. It has
  different release, native dependency, and process-boundary risks.
- After the migration, inspect package dependency versions for intentional
  centralization. Do not mix that cleanup into file-move pull requests.
