# ADR-0014 — Apps compose bounded packages

**Status**: accepted

## Context

Solus had deployable applications and shared code in broad source roots. The
desktop app, standalone server, web client, site, and CLI could depend on source
by path. This made ownership unclear and let process-specific code cross a
transport or client boundary.

## Decision

- Deployable entries live in `apps/`:
  - `apps/desktop` owns Electron main, preload, desktop renderer bootstrap,
    and native shell composition in `src/renderer/App.svelte` and `shell/`.
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

### Shared features and client shells

The package graph alone does not establish ownership within the renderer.
Apply these three boundaries:

1. **Shared feature state** owns product rules, host/project identity, loading,
   cache state, retries, and feature commands. A mobile task action calls the
   same completion command as the desktop sidebar. A mobile PR header and a
   desktop git panel use the same project PR store; neither owns a second
   request guard.
2. **Shared feature UI** owns reusable rendering and component interactions.
   Conversation, input, editor, diff, task, and work components remain in
   `packages/workspace-ui`. Components adapt to their container and input
   capabilities. Their parent supplies activation and presentation choices.
   A touch fix in a shared component belongs here.
3. **Client shells** own navigation composition and client lifecycle. Browser
   composition lives in `apps/client/src/shell/`, with `mobile/` and `desktop/`
   layouts. Mobile sheets and browser back handling belong to this app. Native
   Pill composition, the tab strip used by that window, click-through behavior,
   and Electron webview mounting live in `apps/desktop/src/renderer/shell/`.

`createAppCore(shell)` receives a `ClientShellContext` supplied by the app.
It does not construct a native-aware window context. The shared contract
declares facts such as visible content, companion-pane availability, titlebar
insets, and attachment capabilities, plus optional window actions. Desktop
implements it with `DesktopWindow`; the browser implements it with `WebShell`.
Native visibility listeners belong to the desktop adapter. Shared DOM resize
handling is kept in `ClientViewport` and removes its listeners on destruction.

Desktop window mode, browser layout, and input capabilities are independent:

- Desktop mode is fixed to Pill or Editor for each native window.
- Browser layout selects mobile or wide composition and retains mounted
  layouts across changes.
- Touch and pointer capabilities determine interaction. They do not determine
  which native window is active.

Shared composers receive an explicit `active` input. Inactive mounted
composers must not consume pending text, focus requests, or shortcuts. A shell
can supply `onSent` when sending should expand its conversation. Shared
workspace visibility checks use shell visibility and the displayed route;
a stored companion pane is not visible when the mobile shell does not render it.

The existing RPC `window.viewMode` field remains compatible at the adapter
boundary. Web maps its layout to the legacy wire value only there; shared
rendering and activation do not use that value. Tool-input deferral retains
its current policy, now supplied by the shell. Changing that policy is a
separate performance decision.

## Consequences

- `tests/unit/workspace-boundaries.test.ts` enforces the package graph and blocks
  app-to-app imports.
- `tests/unit/electron-import-allowlist.test.ts` confines Electron imports to
  `apps/desktop`.
- Shared changes can affect desktop, web, and mobile-responsive surfaces. Each
  app still owns its bootstrap, transport, and deployment configuration.
- New packages need a real second owner or process boundary. Directory size
  alone is not sufficient.
- Shared UI must not import an app's shell to recover a client capability.
  Supply the capability through the client contract or the component's inputs.
- Native-only composition is held to the same ownership rule as mobile-only
  composition. The shared package is not the default home for desktop code.
