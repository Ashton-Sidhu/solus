# Solus — Operating Manual

> **Before any codebase-wide search (Grep/Glob/Agent over the whole repo), read the Codebase Map below first.**
> It points you at the right region — the RPC chain, which module owns what. Narrow there with `ls`/Grep rather than sweeping the repo blind.

---

## Rules — non-negotiable

1. **Think before coding.** State assumptions. Ask, don't guess. Push back when a simpler path exists. Stop when confused.
2. **Simplicity first.** Minimum code that solves it. Nothing speculative. No abstractions for single-use code.
3. **Surgical changes.** Touch only what the task needs. Don't improve, refactor, or restyle adjacent code. Match existing style.
4. **Surface conflicts, don't average them.** If two patterns contradict, pick one (more recent / more tested), say why, flag the other. Never blend them.
5. **Read before you write.** Read exports, immediate callers, and shared utilities first. If unsure why code is shaped a certain way, ask.
6. **Tests verify intent, not behavior.** A test must encode *why* the behavior matters. If it can't fail when business logic changes, it's wrong.
7. **No pass-through wrappers.** Don't add a function that only forwards args. Inline it. Wrap only to earn it: validation, defaults, error handling, memoization, or a narrower type.
8. **Clean up.** Delete dead/unused code you orphan. Never revert with git — ever, no exceptions.

## Product & UX

- Brand: **clean, intuitive, premium.** Every UI decision serves these.
- Colors must work in **both dark and light mode**. Use Tailwind v4 utilities — not CSS — wherever possible.
- **Editor mode** = focused single-agent UI. **Pill mode** = lightweight, summon-as-needed for multitaskers.
- **Keyboard-first.** Buttons get keybindings where sensible; every UI is keyboard-navigable. Global shortcuts: `opt+shift+<key>`. Sub-page shortcuts: `opt+<key>`.
- After a user clicks/acts, **refocus the active input bar** so they can keep typing.
- `bun run build` to confirm it compiles (keep output to warnings/errors). **Do not start a dev server to verify.**
- For an explicitly requested isolated headless app run, follow `.claude/skills/run-app/SKILL.md` instead of starting the desktop dev server.
- Dev logs live at the repo root, written by the running dev server. If one is already running, **query these instead of starting a new dev server**:
  - **`dev.log`** — structured NDJSON, one entry per line (`ts`, `level`, `tag`, `file`, `msg`, plus data fields; `msg` is a stable snake_case event name). Truncated on each app boot. Query with `jq`, filter by session: `jq -c 'select(.sessionId == "<id>")' dev.log`; errors only: `jq -c 'select(.level == "error")' dev.log`; fast pre-filter big files with `grep '"sessionId":"<id>"' dev.log | jq .`
  - **`dev-console.log`** — raw process output (vite/electron noise, build errors, stray stack traces).
  - When adding logs: `log.info('event_name', { sessionId, ...facts })` — never interpolate ids into the message string. Use `log.child({ sessionId })` to stamp every entry in a session-scoped code path.

## Renderer architecture

Rules for `src/renderer/` — feature folders, stores, Tailwind/shadcn conventions, variable naming, and the Svelte 5 performance contracts — live in **`src/renderer/CLAUDE.md`**, loaded automatically when working under that directory.

---

## Codebase Map

**Read this before searching.** Locate the feature/region, open those files, then narrow with Grep.

### Architecture (Electron + Svelte 5; also serves a web client)

```
renderer  →  window.solus.<method>()        (src/preload/index.ts wraps as RPC envelope)
          →  SolusServer.handle()           (src/main/server/server.ts)
          →  handler in server/handlers/*   (one file per domain)
          →  ControlPlane / managers        (src/main/control-plane.ts = session+tab orchestrator)
events    ←  broadcast over RPC topics       (back to renderer)
```
Add an RPC method/topic in `src/shared/rpc.ts`, then register a handler on `SolusServer` and expose it in `src/preload/index.ts`.

### `src/main/` — Electron main (backend)
Folder names say what they own; these three don't:
| Path | Owns |
|------|------|
| `control-plane.ts` | **Central orchestrator** — sessions, tabs, prompts, event normalization (large) |
| `agents/` | Agent backends: `claude/`, `codex/`; `backend-registry.ts`, `run-input.ts`, `text-generator.ts` |
| `server/` | HTTP/WS server (`server.ts`, `http.ts`, `index.ts`) + `handlers/` (one file per domain) |

### `src/renderer/` — Svelte 5 UI
- **Entry:** `App.svelte`, `main.ts`
- **`contexts/`** — state stores, foldered by domain. **Public surface = `contexts/index.ts`** (curated barrel); import authoritative stores from it. `workspace/` contents are private organs — deep-import them only from boot files or for organ-local types.

### `src/renderer/components/<feature>/`
One folder per feature; `ui/` holds shared primitives. See `src/renderer/CLAUDE.md` for the rules that govern them.
