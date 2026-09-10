---
name: run-app
description: Start, reuse, inspect, and stop an isolated Solus QA run with mock agents and a standalone web client. Use when asked to run, demo, screenshot, or visually verify Solus.
---

# Run Solus for QA

Read [the canonical QA runbook](../../../docs/operations/qa.md) before launching a run.
It owns setup, isolation, identity checks, fixtures, pairing, evidence, and cleanup.

Run from the worktree containing the change:

```bash
bun run qa doctor
bun run build:test
bun run qa start
bun run qa status <run-id>
bun run qa smoke
bun run qa report <run-id>
```

Run `bun run qa setup` if doctor reports missing or incompatible dependencies. The mock
build uses `dist/test/` and cannot replace the production build. Read the returned run
manifest for its actual URL, data directory, logs, source fingerprint, and captured PID.
Do not start development code against live Solus state. The default project is a fresh
Git repository in its own temporary directory, recorded as `projectDir`; use that exact
path, not a path derived from `dataDir`. This runner
uses mock providers only; it cannot prove a real provider integration.

Keep the healthy run and browser context for the full review loop. Check status before
reuse. After source changes, run `bun run build:test` and `bun run qa restart <run-id>`
to keep the sandbox and project while replacing the tested process. Read the new URL
and repeat the affected checks; prior evidence does not cover the new build. Give helpers the existing manifest; do not launch another server per agent or turn.
Use `browser_*` tools on the reported target or `scripts/agent/open-app.ts` for scripted
Playwright checks. Record assertions as well as images. Phone browser emulation does not
prove native mobile behavior.

Use `bun run qa handoff <run-id> <device-label>` and the runbook's existing Solus pairing flow when a person needs
to connect. Probe the bare origin without consuming their single-use pairing token. Create
separate pairing credentials for each browser or device. Do not publish a tunnel by default.

When the review loop ends, run `bun run qa stop <run-id>`. This retains the project and
evidence. Use `bun run qa dispose-project <run-id>` only when its owned temporary
project is no longer needed; the command checks ownership and keeps run evidence. Never stop a PID
found only by name or path. Native Electron checks use the isolated fixture in
`tests/e2e/fixtures/electron-app.ts`; they apply to IPC and native shell behavior that the
standalone web client cannot exercise.
