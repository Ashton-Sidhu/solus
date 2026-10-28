---
name: run-app
description: Run this worktree's Solus app headlessly (standalone server + headless Chromium), drive it with Playwright, capture screenshots/video, read its logs. Use when asked to run, demo, screenshot, or visually verify the app.
---

# Run Solus headlessly

Use the existing standalone server and Playwright entry points. Never launch the desktop dev app for this workflow, and never point a run at `~/.solus`.

## Build

Choose one flavor. Both write to `dist/`, so switching flavors requires rebuilding.

```bash
bun run build       # real agent backends
bun run build:test  # deterministic mock backends; no API keys or real sessions
```

## Launch once and reuse

Start the server from the worktree root as a background Bash task. Keep the captured task/PID for the whole verification loop; do not relaunch it every turn.

```bash
SOLUS_DATA_DIR="$PWD/.solus-local" SOLUS_PORT=0 SOLUS_NO_LAN_DISCOVERY=1 \
  node dist/main/standalone.js --data-dir "$PWD/.solus-local"
```

Wait for the lock, discover the OS-assigned port, and verify health:

```bash
until test -f .solus-local/server.lock; do sleep 0.1; done
PORT=$(jq -r .port .solus-local/server.lock)
curl -fs "http://127.0.0.1:$PORT/health"
```

Before later verification turns, check this instance's lock PID and health and reuse it. Subagents must use the same running instance; they must not launch competing instances.

## Drive with Playwright

Write a short disposable TypeScript script that imports `openApp` from `scripts/agent/open-app.ts`, then run it with `bun <script>`. The helper seeds the saved loopback server before page boot so the web client connects to it immediately instead of booting hostless.

```ts
import { mkdir } from 'node:fs/promises'
import { openApp } from './scripts/agent/open-app'

const port = process.env.PORT
if (!port) throw new Error('PORT is required')

await mkdir('.solus-local/artifacts', { recursive: true })
const { browser, page } = await openApp(`http://127.0.0.1:${port}`)
try {
  await page.screenshot({ path: '.solus-local/artifacts/workspace.png', fullPage: true })
} finally {
  await browser.close()
}
```

Reusable selectors and interaction patterns live in `tests/e2e/helpers/*.page.ts`.

For video, pass `{ videoDir: '.solus-local/artifacts/video' }`. Capture `const video = page.video()`, then `await context.close()` before calling `await video?.path()`; closing the context finalizes the WebM. Close the browser afterward. Only convert WebM to MP4/GIF when the artifact must be shared, using Playwright's bundled ffmpeg rather than a screen recorder. A headless page has no desktop screen to capture.

## Watch a turn without paying for one

Real agent turns cost money. Both build flavors offer the **Replay (dev)** provider on this server: it replays recorded turns, streamed, through the real session runtime and clients (`docs/replay-provider.md`). Use a real provider only when the change depends on its behavior, and then its cheapest model.

1. In the composer, open the agent and model picker (`[data-slot="session-chip"]`).
2. Pick the agent **Replay (dev)** and the model **Showcase** (or another scenario).
3. Send any prompt. Each prompt plays the scenario's next turn; the first showcase turn stops at an Edit permission card, and the second asks a question.

The same picker is on the web client, the desktop app run from source, and the mobile app, so the steps are the same on each. Headless, drive those steps with Playwright through `openApp`:

```ts
const { browser, page } = await openApp(`http://127.0.0.1:${port}`)
await page.locator('[data-slot="session-chip"]').first().click()
await page.getByText('Replay (dev)', { exact: true }).click()
await page.getByText('Showcase', { exact: true }).click()
await page.keyboard.press('Escape')
await page.locator('[contenteditable="true"]').first().fill('go')
await page.keyboard.press('Enter')
await page.getByText('Allow Once').click() // the showcase's Edit permission
```

The selectors are a starting point; check them against the current picker with a snapshot before you rely on them. The replay keeps each session's history under `.solus-local/replay-sessions/`, so a reopened replay session shows its earlier turns.

## Logs and artifacts

- Main-process NDJSON: `<worktree>/dev.log`. Query it with the `jq` recipes in `CLAUDE.md`/`AGENTS.md`.
- Boot output: the background task's stdout.
- Screenshots and video: `.solus-local/artifacts/`.
- `.solus-local/` is disposable and gitignored. Never copy its SQLite files while the server is running because WAL state may be active.

## Teardown

When the verification work is complete, stop only the PID recorded by this instance:

```bash
kill "$(jq -r .pid .solus-local/server.lock)"
```

Wait for graceful shutdown and confirm `.solus-local/server.lock` is removed. Never use `pkill`, `killall`, or a PID discovered only by process-name matching.

## Electron-only checks

For window, tray, or IPC-specific behavior only, follow `tests/e2e/fixtures/electron-app.ts` with Playwright `_electron.launch`, `SOLUS_TEST_MODE=1`, a fresh `mkdtemp` `--user-data-dir`, and a `SOLUS_DATA_DIR` inside that temporary directory. Electron windows are created but never shown. Use this secondary path only when the standalone web client cannot exercise the behavior.
