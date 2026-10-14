---
name: verify-multiplayer
description: Verify any Solus multiplayer or cloud feature end to end with the Lab — real hosts, real clients, personas (owner, members, guest, other organization), and optionally a real local Solus cloud. Covers sign-in and identity, host registration, link/unlink, sharing and guests, presence, seats, ownership, organization work, settings and profile sync, account reads (MCP connections from the account), cloud machines, and sign-out. No Docker, no production, no human, no Electron build. Use after changing anything that involves more than one person, device, or host, or the cloud; or when asked to "test it end to end".
---

# Verify Solus multiplayer and cloud features

The Lab (`packages/lab`) boots real Solus hosts (the standalone server, built light) and drives them through the real admission path with personas: `alice` (owner), `bob`, `cara`, `dan` (members), `maya` (a guest with a share link), `carol` (another organization). It has two modes:

| Mode | Issuer | Use it for | Command |
|---|---|---|---|
| **Lab issuer** | the Lab mints the grants itself (fast, no cloud) | what happens on a host between people: sharing, guests, presence, seats, ownership, admission, organization work on a Solus API | `bun lab run <scenario>` |
| **Cloud** | a real local Solus cloud (`../solus-cloud`, `vite dev` on embedded PGlite) | anything that touches accounts or the cloud: sign-in, registration, link, account reads, settings and profile sync, cloud machines, sign-out | `bun lab up --cloud`, then `bun lab run <scenario> --cloud` |

Read `features/README.md` before driving anything. It is the map: every feature, its scenario, its mode, its current status, and the end state that proves it. Pick the mode the feature's file names. If a change touches both (for example host sharing between two signed-in accounts), use cloud mode.

## Safety (read first)

- Never deploy, never point anything at `app.solus.sh`, never read or write `.env.production`. The doctor refuses a non-local cloud origin.
- Never run `bun run build` or `bun run build:test` (CLAUDE.md). The Lab has its own light build: `bun lab build`, under 1 s, into `.solus-local/lab-build/`.
- Never touch `~/.solus`, the desktop app's Electron `userData`, the developer's `dev.log`, or port 34118: the developer's own Solus may be running here. Lab hosts get temp data dirs, their own `HOME`/`CODEX_HOME`, their own log, and a free tunnel port.
- Kill only what the Lab started: the Lab stops its own hosts when it exits, and `bun lab down` stops exactly the PIDs in `.solus-local/lab-cloud/stack.json`. Never `pkill`/`killall`.
- One cloud stack per checkout. If the doctor says the stack is healthy, reuse it. Several agents may run scenarios against one stack: each scenario boots its own hosts and undoes its own account changes.

## Launch

From the `solus` checkout:

```bash
bun lab build            # < 1 s; again after any change in packages/server, contracts, or client-core
bun lab up --cloud       # cloud mode only: ~10 s — PGlite, migrations, cloud vite dev, Solus API, personas, one host
```

Lab-issuer mode needs only the build: each `bun lab run` boots and stops its own hosts. Cloud mode is ready when `up` prints the stack facts and the doctor prints `DOCTOR OK (cloud mode)`. A change in `../solus-cloud` needs no rebuild (`vite dev` reloads it); a cloud migration needs `bun lab down && bun lab up --cloud`.

## Doctor

```bash
.claude/skills/verify-multiplayer/scripts/doctor.sh           # Lab-issuer mode
.claude/skills/verify-multiplayer/scripts/doctor.sh --cloud   # cloud mode
```

Read-only. It checks that the Lab build exists and is newer than every server, contract, and client-core source; in cloud mode also that the stack's processes are alive, the cloud origin is local and answers OIDC discovery, the Lab host answers `/health`, and the host is isolated from `~/.solus` and the developer's `dev.log`. Run it first, and again whenever anything looks wrong.

## Drive

Run mapped scenarios:

```bash
bun lab run all                              # every Lab-issuer scenario, personal and managed hosts
bun lab run share-matrix --host managed      # one scenario, one host flavor
bun lab run all --cloud                      # every cloud scenario; one PASS/FAIL table
bun lab run account-reads --cloud            # one cloud scenario
bun lab run guest-revoke --keep              # keep the data dir and logs for diagnosis
```

To verify something the map does not cover, write a scenario and add it to the map:

- **Lab issuer:** `packages/lab/scenarios/<name>.ts`, `scenario(name, async (ctx) => { ... })`. `ctx.as('bob')` is a connected client; `ctx.client(...)` a fresh one; `expectOk`/`expectRefused` record checks; `src/oracle.ts` holds invariants to call between steps.
- **Cloud:** `packages/lab/scenarios/cloud/<name>.ts`, `cloudModeScenario(name, async (ctx) => { ... })`. `ctx.signIn('alice')` (or `'solus-mobile'` for a second client) is a real `OAuthSession` (`accessToken({ kind: 'host' | 'account' | 'api' })`, `state()`); `ctx.bootHost(...)`, `ctx.restartHost(host)`, `host.log()`; `registerHost`, `hostClient`, `localRpc` (`src/cloud-sign-in.ts`); `accountApi`, `directory`, `removeHost`, `accountMcpServer`, `pullAndRead` (`src/cloud-fixtures.ts`); `ctx.check`, `ctx.until`, `ctx.defer` (undo an account change at the end).

Assert what a user would see or what another surface reads back: an RPC answer a client gets, a host event another person receives, a cloud answer (`/v1/hosts`, `/oauth2/userinfo`, the token endpoint), or a host log event. Prove multiplayer effects from the other person's side: what bob sees after alice acts. Never reach a state through an internal setter.

Details of every helper and mode: `packages/lab/README.md`.

## Evidence

- **Cloud mode:** every `bun lab run … --cloud` writes `.solus-local/lab-cloud/evidence/run-<time>/` — `summary.json` (checks, failures, clean-up failures, time per scenario), `lab.log` (NDJSON timeline), `<scenario>/host-<n>/` (each host's log), `cloud.log`.
- **Lab-issuer mode:** each run prints every check and a report, and the exit code is non-zero on any failure. With `--keep`, the timeline is `<dataDir>/lab/lab.log`, the host log `<dataDir>/dev.log`, and its stdout `<dataDir>/lab/host.log`. Copy what you cite into `.solus-local/lab-cloud/evidence/` before cleanup.

Proof standards:

- Report the PASS/FAIL table and where the evidence is. A claim without evidence is not proof.
- Prove the action and the resulting state, read back from a second surface or a second persona.
- Verify side effects, not only answers: the event the other person received, the request that reached the fake server, the key the token endpoint now refuses.
- Never weaken a check to make it pass. A failed precondition is a FAIL with its reason, and the reason goes in that feature's `Gotchas`.
- The only fakes are at real external boundaries: the Lab issuer (in Lab-issuer mode only), the agent backends (mocks), MCP servers, the tunnel (development stub), and the managed-host provider (development in-memory). Everything inside Solus is real.

## Cleanup

```bash
bun lab down        # cloud mode: stops the stack's PIDs, keeps .solus-local/lab-cloud/evidence/
```

Lab-issuer runs stop their own hosts when they exit and delete their temp data dirs unless `--keep` (then delete the kept dir after you have copied the evidence). Never delete `.solus-local/lab-cloud/evidence/` during cleanup. Delete a scratch scenario written only for one run. After a failed run, still clean up.

## Helpers

- `scripts/doctor.sh [--cloud]` — the read-only health check above.
- `bun lab build | up --cloud | run <scenario|all> [--cloud] [--host personal|managed] [--keep] | down` — `scripts/lab.ts`; details in `packages/lab/README.md`.

## Not covered here

- Client UIs (desktop window, web, mobile app): the Lab drives the same RPCs and cloud routes the UIs call, not the screens. Desktop-only parts (`LocalClient`, the loopback sign-in, the keychain store) and mobile-only parts are covered by unit tests (`tests/unit/local-client.test.ts`, `desktop-local-host-client.test.ts`, `loopback-authorizer.test.ts`, `native-mobile-*`).
- Production and real third-party providers (real Cloudflare tunnels and containers, real MCP servers such as PlanetScale, real agent providers): only a deploy proves them.
