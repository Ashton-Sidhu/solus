# ADR-0014 — Apps compose bounded packages

**Status**: accepted

## Context

Solus had deployable applications and shared code in broad source roots. The
desktop app, standalone server, web client, site, and CLI could depend on source
by path. This made ownership unclear and let process-specific code cross a
transport or client boundary.

## Decision

- Deployable entries live in `apps/`:
  - `apps/desktop` owns Electron main, preload, and desktop renderer bootstrap.
  - `apps/standalone-server` owns the headless server entry.
  - `apps/client` owns the standalone web and mobile-responsive client shell.
  - `apps/site` owns the SvelteKit marketing site.
  - `apps/cli` owns the installed command-line process.
- Shared code lives in `packages/`:
  - `packages/contracts` owns RPC, events, and shared domain contracts.
  - `packages/server` owns provider adapters, server handlers, and domain services.
  - `packages/client-core` owns transport-neutral host connections and local API
    selection.
  - `packages/workspace-ui` owns the Svelte workspace, stores, feature
    components, and Tailwind source.
- Packages can depend only in this direction:
  `contracts` → `server` or `client-core` → `workspace-ui`.
  `server` and `client-core` do not depend on each other.
- Apps can compose packages, but one app cannot import another app's source.
- Desktop and standalone entries compose the same `server` package. Desktop
  injects Electron platform services and optional file handlers. The standalone
  entry uses server platform services without Electron.
- Desktop and web client entries compose the same `workspace-ui` package.
  Client shells own theme and other client-local behavior.
- RPC belongs to `contracts`. The desktop preload implements the local native
  API. `client-core` selects a host-bound RPC API or a client-local API. Shared
  UI does not call Electron directly.
- Tailwind scans and tokens for product workspace components belong to
  `workspace-ui`. App shells add only app-specific sources.

## Consequences

- `tests/unit/workspace-boundaries.test.ts` enforces the package graph and blocks
  app-to-app imports.
- `tests/unit/electron-import-allowlist.test.ts` confines Electron imports to
  `apps/desktop`.
- Shared changes can affect desktop, web, and mobile-responsive surfaces. Each
  app still owns its bootstrap, transport, and deployment configuration.
- New packages need a real second owner or process boundary. Directory size
  alone is not sufficient.
