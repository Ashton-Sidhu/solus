# Changelog

## [Unreleased] — 2026-03-17

### Architecture & Docs

- **`docs/ARCHITECTURE.md`** — Full rewrite of architecture documentation. Replaced the flat single-diagram overview with a layered three-tier ASCII diagram (External → Main Process → Renderer), added explicit data-flow sections for Prompt→Response and Tool Permission flows, and documented ControlPlane, RunManager, EventNormalizer, StreamParser, PermissionServer, and Marketplace Catalog components.

### Build / Package Manager

- **`package-lock.json`** — Deleted. Project migrated from npm to Bun.
- **`bun.lock`** — Added (Bun lockfile, untracked).
- **`package.json`** — `dev` script changed from `electron-vite dev` to `bun run electron-vite dev`.
- **`.npmrc`** — Added (untracked).

### Main Process

- **`src/main/index.ts`**
  - `BAR_WIDTH` increased from 1040 → 1560 px (wider native Electron window).
  - `SELECT_DIRECTORY` IPC handler simplified: removed macOS-specific `app.focus()` call and platform-conditional dialog branching; always uses parented `dialog.showOpenDialog`.
  - `ATTACH_FILES` IPC handler simplified the same way, with an added TypeScript cast for the `properties` array.

- **`src/main/claude/run-manager.ts`**
  - Claude CLI permission flag changed from `--permission-mode default` → `--dangerously-skip-permissions`. Tool calls now run without interactive confirmation prompts.

- **`src/main/claude/control-plane.ts`**
  - Commented out the per-run permission token lifecycle block (`permissionServer.registerRun()`, `runTokens.set()`, `permissionServer.generateSettingsFile()`). Permission hook settings files are no longer generated per run.

### Renderer — Layout

- **`src/renderer/theme.ts`** — `spacing.contentWidth` increased from 460 → 960 px (base collapsed-mode width).

- **`src/renderer/App.tsx`**
  - Layout dimensions widened significantly:
    - `contentWidth` (expanded): 700 → 1170 px
    - `cardExpandedWidth`: 700 → 1170 px
    - `cardCollapsedWidth`: 670 → 885 px (collapsed: 460 → 885)
    - `bodyMaxHeight` (expanded): 520 → 780 px (collapsed: 400 → 600)
    - Root UI container width: 720 → 1080 px
  - Input area redesigned: replaced the floating "stacked circle buttons" (that popped out left of the input pill) with a unified `glass-surface` container holding inline Attach + Screenshot icon buttons, a vertical divider, and the `InputBar`. `StatusBar` moved below the input row inside the same container.
  - `HeadCircuit` (Skills) button removed from the input area.

- **`src/renderer/index.css`** — Removed the entire "Stacking circle buttons" CSS block (~45 lines): `.circles-out`, `.btn-stack`, `.stack-btn`, `.stack-btn-1/2/3`, and all hover-expanded spread rules.

### Renderer — Keyboard Shortcuts

- **`src/renderer/App.tsx`** — Added three new `⌥⇧` keyboard shortcuts:
  - `⌥⇧D` — Open directory picker and set base directory (disabled while a run is active).
  - `⌥⇧N` — Create a new tab.
  - `⌥⇧S` — Take a screenshot.

### Renderer — Components

- **`src/renderer/components/InputBar.tsx`**
  - Textarea font size bumped from 14 → 15 px.
  - Textarea line height bumped from 20 → 22 px.

- **`src/renderer/components/ConversationView.tsx`**
  - `EmptyState` simplified: removed the "Choose folder" button and `handleChooseFolder` logic. Empty state now only shows the `⌥ + Space` shortcut hint. Directory selection moved to `⌥⇧D` global shortcut.

- **`src/renderer/components/StatusBar.tsx`**
  - Directory popover removed; directory button now directly calls `setBaseDirectory` via a native dialog on click.
  - `compactPath()` helper removed; full `tab.workingDirectory` path is always displayed.
  - Directory button tooltip updated to include the `⌥⇧D` shortcut hint.
  - Font sizes bumped: model picker, permission mode picker, separator, and "Open in CLI" text all increased from 10–11 → 12 px.
  - `SettingsPopover` relocated here from `TabStrip`.
  - StatusBar height reduced: `minHeight` 28 → 26 px; padding reduced from `px-4 py-1.5` → `px-3 py-1`.
  - Removed `Plus` and `X` icon imports; kept `FolderOpen` and `ShieldCheck`.

- **`src/renderer/components/SettingsPopover.tsx`**
  - Removed dependency on `isExpanded` state from `useSessionStore`.
  - Positioning simplified to always open left of the trigger button, vertically aligned (no longer conditional on expansion state).
  - Animation changed from vertical (`y: ±4`) to horizontal (`x: 4`) slide-in/out.
  - Removed `maxHeight` and `overflowY: auto` constraints.

- **`src/renderer/components/TabStrip.tsx`**
  - `SettingsPopover` import and rendering removed (moved to `StatusBar`).

### Renderer — State

- **`src/renderer/stores/sessionStore.ts`**
  - Default `permissionMode` changed from `'ask'` → `'auto'`. Combined with `--dangerously-skip-permissions`, tool calls are auto-approved by default.
