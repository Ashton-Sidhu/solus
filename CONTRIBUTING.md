# Contributing to Solus

Thanks for your interest in contributing. Solus provides a keyboard-first workspace on desktop, web, and mobile browsers.

## Getting Started

1. Make sure you have the [requirements](README.md#requirements) installed.
2. Fork and clone the repo:
   ```bash
   git clone https://github.com/<your-username>/solus.git
   cd solus
   ```
3. Install dependencies:
   ```bash
   bun run qa setup
   bun run qa doctor
   ```
4. Copy optional local configuration if you need analytics, Google integration, or release signing:
   ```bash
   cp .env.example .env
   ```
5. Make your changes.
6. Verify your changes build cleanly with warnings/errors only:
   ```bash
   bun run build
   ```

Do not commit `.env`, local worktrees, build output, or test artifacts.

## Development Tips

- **Server and Electron main** changes (`packages/server/src/`, `apps/desktop/src/main/`) require a rebuild or development restart. Stop only a process you started.
- **Shared renderer** changes (`packages/workspace-ui/src/`) hot-reload in the development environment.
- Read structured `dev.log` and raw `dev-console.log` for normal development. Isolated QA runs keep logs in the run manifest’s `logDir`.
- Use the [QA runbook](docs/operations/qa.md) for worktree setup, mock fixtures, browser tests, debug recipes, and review handoff. Mock builds use `dist/test/`; production builds use the normal `dist/` entries.
- The app creates a transparent, click-through window. Use `⌥ + Space` to toggle visibility (fallback: `Cmd+Shift+K`).

## Code Style

- TypeScript and Svelte 5 are used throughout the app.
- Use Tailwind v4 classes and existing Solus theme tokens for UI work.
- Preserve keyboard accessibility. Global shortcuts start with `Option + Shift`; sub-page shortcuts use `Option + letter` unless explicitly documented otherwise.
- Avoid spreading `TabState` or other deeply reactive `$state` objects for small updates. Mutate the specific property so hidden mounted tabs do not recompute unnecessary derived state.
- Prefer editing existing files over creating new ones.

## Pull Requests

1. Create a feature branch from `main`.
2. Keep PRs focused — one concern per PR.
3. Include a brief description of what changed and why.
4. Ensure `bun run build` passes with zero errors.

## Reporting Bugs

Open an issue with:
- macOS version
- Bun version (`bun --version`)
- Claude Code CLI version (`claude --version`), if relevant
- Codex CLI version (`codex --version`), if relevant
- Steps to reproduce
- Expected vs. actual behavior

## Security

If you discover a security vulnerability, please report it privately. See [SECURITY.md](SECURITY.md).
