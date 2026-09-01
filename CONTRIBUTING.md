# Contributing to Solus

Thanks for your interest in contributing. Solus is a native macOS desktop app for working with coding agents from a keyboard-first UI.

## Getting Started

1. Make sure you have the [requirements](README.md#requirements) installed.
2. Fork and clone the repo:
   ```bash
   git clone https://github.com/<your-username>/solus.git
   cd solus
   ```
3. Install dependencies:
   ```bash
   bun install
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

- **Main process** changes (`src/main/`) require a full restart (`Ctrl+C` then `bun run dev`).
- **Renderer** changes (`src/renderer/`) hot-reload automatically.
- Set `SOLUS_DEBUG=1` to enable verbose main-process logging to `~/.solus-debug.log`.
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
