---
name: deploy
description: Take a project to a verified deploy-ready state for Cloudflare's free tier. Use when the user says "deploy", "publish", "ship it", "make this public", "put this online", "get this on the internet", "share this with someone", or "host this".
---

# Deploy-ready for Cloudflare

Follow this staged pipeline to prepare a project for Cloudflare's free tier.

> **Hard boundary:** This pipeline ends at **deploy-ready**. Perform **zero credentialed Cloudflare operations**: do not create resources, run `wrangler deploy`, run `wrangler d1 create`, or otherwise talk to a Cloudflare account. Do local work only. Never overwrite an existing `wrangler.jsonc` or `wrangler.toml`. Never ask the user to paste an API token into chat; tokens must never enter the conversation transcript.

Skip a stage when it is already satisfied. Prefer free-tier-shaped designs: avoid heavy Queues fan-out and more than 10ms of CPU crunching when a free-shaped alternative exists.

## 1. Audit

Start with the runtime-fit gate, then map the project's capabilities. If a Wrangler config already exists, skip this stage.

### Runtime fit

- Static build output from any generator (Vite, Hugo, Jekyll, MkDocs, Astro, and similar) fits, regardless of implementation language.
- JavaScript and TypeScript run natively on Workers.
- Python may fit through Python Workers (beta), but inspect the project's actual imports against supported Python Workers packages before claiming it fits.
- Other server runtimes — Go, JVM, PHP, Ruby, or Rust without WASM work — do **not** fit the free tier as-is. Say plainly: **"This doesn't fit because X."** You may offer to keep the frontend and rewrite a thin API layer in TypeScript as an explicitly sized option; never assume it.
- Cloudflare Containers are paid and out of scope.

### Capability mapping

Map capabilities, not particular libraries (the parenthetical names are only examples):

| Capability | Maps to | Port work |
|---|---|---|
| static site / build output | Workers static assets | none |
| HTTP server / API routes (Express, Hono, Flask, FastAPI…) | Worker fetch handler | adapter |
| SQL database (SQLite file, local Postgres) | D1 | same SQL shape, swap client |
| local file writes / uploads dir | R2 | swap read/write calls |
| in-memory sessions/cache | KV | swap store |
| WebSocket server / stateful rooms | Durable Objects | the real work when present |
| env-based secrets | Worker secrets | list in secrets manifest (names only) |
| scheduled jobs (node-cron, APScheduler, crontab…) | Cron Triggers | move handler, register schedule |
| LLM calls without a user API key | Workers AI (offer, optional) | swap client |

The filtered table is the port plan. Report either that plan, **"deployable as-is"**, or the honest **"doesn't fit"** result.

## 2. Port

When the audit has port work, present the plan and obtain confirmation **before changing code**. Apply only the mapped changes, then demonstrate that the app still works locally: run the project's tests and/or a `wrangler dev` smoke check. `wrangler dev` needs no Cloudflare account; D1, KV, and R2 use local simulations. End only with a demonstrated working local app.

Skip this stage when the audit says deployable as-is.

## 3. Connect

This is a status check, not an authentication flow. Call the `cloudflare_status` agent tool. It returns `{ connected, accountName?, source }` and never exposes a token. `CLOUDFLARE_API_TOKEN` in the environment also counts as connected.

If disconnected, the check itself displays a **Connect Cloudflare** card in the Solus conversation UI. **End the turn** and tell the user to connect through that card (or **Settings → Providers → Cloudflare**), that it is free with no credit card, and that the token is pasted into the card — **not** into chat. Do not attempt a workaround. When the user resumes, re-check and continue. After the first successful connection, skip this stage forever.

## 4. Provision

Write IaC only; create **no** cloud assets. Show the generated IaC and obtain confirmation before writing because it is a durable repository change. Skip when a Wrangler config already exists.

- Create `wrangler.jsonc` with a worker name derived by slugifying the project folder name (confirm that name in the plan), the entry point and/or static-assets directory, and a binding block for every mapped capability: D1, KV, R2, Durable Objects, Cron Triggers, and Workers AI.
- Where Wrangler needs a resource ID, use an explicit placeholder such as `"TBD-created-at-deploy"` for D1 `database_id` and KV `id`. Deploy-time resource creation resolves these; `wrangler dev` needs no real IDs.
- Add D1 schema or migration files compatible with `wrangler d1 migrations apply`.
- Add a repository secrets manifest containing required secret **names** from ported environment usage — never values.

## End: deploy-ready

Summarize what was ported, what the IaC declares, and that everything runs locally under `wrangler dev`. State that the design fits Cloudflare's free tier: Workers 100k requests/day, D1 5 GB, R2 10 GB with zero egress, KV 1 GB, and Durable Objects on the free plan.

Be explicit: **nothing is live and no cloud resources exist yet.** Publishing is a separate step that ships the prepared project.
