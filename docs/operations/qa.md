# Repository QA runbook

This is the canonical setup, test, debug, and review procedure for Solus. Run commands
from the worktree that contains the change. A passed build proves compilation. A passed
behavior assertion proves only the path it exercised. A screenshot records appearance;
it does not prove persistence, provider behavior, or a working action.

## Setup and worktrees

```bash
bun run qa setup --warm
bun run qa doctor
```

Run setup after creating a worktree or changing dependencies. Do not declare a worktree
ready because `node_modules` exists: package resolution can use a parent checkout. Check
the dependency readiness result, resolved package paths, and Chromium availability in
doctor output. Install the
worktree's matching dependencies when they differ. Keep generated caches and build output
local to the worktree. Do not symlink `.env`, credentials, databases, or caches from live
Solus state. Optional integrations require their own explicit test authorization.

Create a new QA worktree and install its matching dependencies in one command:

```bash
bun run qa worktree qa/my-change
```

This creates a new branch from the current committed `HEAD` under Git’s common
`solus/worktrees` directory, then runs `qa setup --warm` in that checkout. It does not
copy uncommitted changes or reuse existing branches. Setup failure retains the new
checkout and prints a retry command; readiness is reported only after setup succeeds.
The command must exist in the committed source used for the new checkout.

`--warm` prepares the web client’s Vite dependency cache without starting a server. It
adds a dependency optimization pass and disk cache to setup; omit it for a minimal
manual install. The worktree helper includes that cost so a new checkout is ready for
iteration. The
first `check`, `start`, or `smoke` command also checks dependency readiness and runs
setup when needed. The helper is repo-owned; it does not execute arbitrary setup hooks
when Solus creates worktrees for other projects.

Doctor reports setup problems before an app launch. A missing mock build is expected on
a fresh checkout: run `bun run build:test` to create it. Resolve required failures first;
record unavailable platform tools as limits on the checks you can run. Setup must not
start an app or open a browser.

## Choose the proof

Start with focused unit tests and the checks that own the changed files. Use the common
check command for the repository baseline, then build the product:

```bash
bun test tests/unit/<feature>.test.ts
bun run qa check
bun run build
```

The QA runner supports mock providers only. It must run without provider credentials.
It does not prove real Claude or Codex authentication, SDK/process integration, or remote
service behavior. A real provider check needs explicit authorization for the integration
and credentials, plus a separate isolated data directory, logs, and a captured process.
Do not use `bun run dev` with default desktop data as an isolated integration test. There
is no real-provider mode in this runner; record that coverage as not exercised unless a
separate authorized test supplied evidence. Both mock provider identities emit deterministic
normalized events; they do not emulate each provider’s wire protocol. Mock forks copy
full history and do not emulate `forkExcludeLatestTurn` cutoffs. Full suites belong in CI or an explicitly requested broad
QA run; a small change does not require every interactive test.

| Change | Required evidence |
|---|---|
| Backend rule or lifecycle | Deterministic behavior test, including error and reverse states |
| RPC contract | Server handler, preload, WebSocket client, typed events and reconnect checks |
| Shared UI | Web desktop and phone viewports, Electron where applicable, keyboard and focus, light/dark |
| Input, navigation, overlays | Editor and Pill modes, mounted tab state, focus return |
| Provider lifecycle | Explicit Claude and Codex coverage; identify unsupported paths |
| Durable domain state | Action through app/RPC, reload, reconnect, second mounted client/tab |
| Native desktop shell | Electron IPC, window, tray or shortcut checks as applicable |
| Native mobile shell | A real native target and device/simulator test; browser emulation is insufficient |

The shared mobile-responsive client lives in `apps/client/`. This repository has no
separate `apps/mobile/` native build entry. Phone browser checks prove the responsive web
client, not iOS or Android native shell behavior. Do not report native coverage without
an actual native target and test.

## Current checks and baseline failures

`qa check` runs TypeScript, Svelte, QA tooling typechecks, lint, and lint-rule tests. It
records each exit code in `.solus-local/checks.json` and fails if any check fails. These
are required results to report, not proof that the existing repository is clean.

The initial rollout found pre-existing broad typecheck and lint failures. For example,
the client-core check reports event-map generic typing and missing standalone window
bridge declarations. Preserve the diagnostics and distinguish a new regression from a
baseline failure using the unchanged base revision. A focused test or successful build
does not turn a failed broad check into a pass. Do not suppress diagnostics, skip failing
tests, or change expected outcomes to obtain a green report. State the failed checks and
unverified scope in the handoff until the underlying findings are resolved.

The current smoke configuration runs two browser journeys for each mock provider on
Desktop Chrome and Pixel 7 touch emulation. It covers authenticated prompt completion,
keyboard focus on desktop, an editable mobile composer, draft/transcript retention when
the desktop browser changes to the phone layout and back, pending-permission reconnect,
approval, reload, follow-up, cancellation, and another prompt. Page errors and unexpected
console output fail these journeys. Mobile does not require forced focus: the existing
coarse-pointer policy avoids opening its soft keyboard through programmatic focus.

The native entry checks hidden Electron windows, no registered summon shortcut, and a
mock prompt through the desktop shell. It does not prove full native window, tray,
global-keybinding, packaging, or native phone behavior. The responsive round trip tests
`.web-frame` and `.mobile-shell`; it does not switch native Editor/Pill windows. Native
mode switching remains unexercised because the test shell keeps its windows hidden.
The full coverage matrix above
still governs the affected feature. Read `playwright.smoke.config.ts` and
`tests/e2e/smoke/` for the exact assertions; a passing suite only covers those assertions.

## Start once and keep the review environment

```bash
bun run build:test
bun run qa start
bun run qa status <run-id>
```

Build the mock target first; the runner rejects missing or stale builds and starts an
isolated mock standalone server. Replace `<run-id>` with the ID printed by start. Mock output is in
`dist/test/{main,client,preload,renderer}`; real builds keep the normal `dist/` entries.
The run manifest records `runId`, `url`, `dataDir`, `projectDir`, `logDir`, `directory`,
`sourceFingerprint`, `verificationFingerprint`, `generationId`, and `pid`. The build
fingerprint identifies compiled inputs; the verification fingerprint records the QA
helpers and tests. The default project is a fresh Git repository in a separate owned
temporary directory, recorded as `projectDir`. Use that exact path for fixture actions.
It stays outside managed-worktree path markers so project-root resolution cannot mistake
it for the Solus source checkout. Data and logs remain under this worktree’s
`.solus-local/runs/`; do not infer the project path from `dataDir`. Use all returned
values, including the assigned port.

The project’s `.solus-qa-owner.json` and the run’s `project-owner.json` record the run,
worktree, and project path. Restart validates these records and reuses the project.
Do not copy, edit, or remove these records to bypass an ownership check.
Never infer a port from another run or use an inherited `SOLUS_DATA_DIR` for QA.

The runner owns its disposable data and process. Source identity includes local changes;
a branch name, commit alone, file age, or successful `/health` response is insufficient.
Check status before each reuse. If source or build identity changed, rebuild and restart
the existing run:

```bash
bun run build:test
bun run qa restart <run-id>
bun run qa status <run-id>
```

Restart verifies the new build, stops only the captured process, and retains the same
data, project, and authentication state. Each startup gets a new `generationId`. Restart
archives the old `run.json`, `validation.json`, `report.json`, and `scenario.json` under
`history/<previous-generationId>/`; new logs use the manifest’s new `logDir`. It tries
the previous port, with an available-port fallback. `previousUrl` and `originChanged`
show whether the origin moved. Read the returned URL before reuse; browser storage
belongs to an origin, so a changed port may require
selecting the new host or pairing again. Do not present an old page or previous
generation’s assertions as proof of a new change. Repeat the affected checks.

Keep a healthy run and authenticated browser context through follow-up review turns.
A reply to the user is not the end of the test loop. Reuse the same fixtures and origin
while they remain valid. If other agents help, give them the manifest and existing URL;
they must not start competing instances for the same check. Record a retained run and its
non-secret URL on the task so a later turn can find it.

Starting a new interactive environment needs task authorization. A request to implement
and verify this QA workflow supplies that authorization. Focused checks and `browser_*`
verification on discovered servers are allowed without another approval. Do not launch a
system browser or computer control unless already authorized.

## Exercise behavior and populated states

```bash
bun run qa smoke
```

Use deterministic synthetic fixtures for long conversations, pending permissions, large
task lists, empty/error states, and reconnect scenarios. Keep their IDs and data local to
the run. An empty workspace is useful for onboarding; it is not a substitute for populated
state when testing scroll, truncation, loading cost, or mounted tabs.

Populate an owned running review sandbox with a named scenario:

```bash
bun scripts/agent/populate-qa.ts <run-id> populated-conversation
```

The names in `tests/e2e/fixtures/scenarios.ts` are:

| Scenario | State for visual review |
|---|---|
| `populated-conversation` | A conversation with several responses and formatted content |
| `permission-waiting` | A pending mock permission request |
| `busy-session` | A mock session held in progress |
| `provider-error` | A deterministic mock provider error |
| `many-tasks` | 20 synthetic tasks across statuses; existing fixture titles are reused |

The helper uses the manifest's `projectDir` and product actions/RPC to populate state.
It saves `<generationId>-<scenario>.png`, `scenario.json`, and private `browser-state.json` in the run
directory. The browser state contains authentication data: do not publish it or attach
it to a task. A later Playwright review can restore that state in the same origin.
The scenario metadata identifies visual preparation, not a passed behavior test.

Use application actions or typed RPC commands for behavioral assertions. A direct database
seed can show a visual state but cannot prove that the application can create or update it.
Do not edit authentication tables. Do not use live tokens or copy production settings into
the fixture. If a special visual seed needs direct database access, stop its owned server
first and use only its disposable data directory. Prefer fixture builders over copied SQL
that can go stale after a migration.

For a change to session flow, assert start, streaming, completion, stop, resume, permissions,
and errors where applicable. For persistence, create state through the API, reload, and
reconnect before asserting it. Use conditions and events with deadlines rather than
arbitrary sleeps. Record which tests ran; the smoke suite is not the full matrix above.
The current smoke configuration does not run separate light and dark appearances. Check
both appearances explicitly for affected UI changes and record that evidence separately.

## Browser evidence and phone handoff

Use `browser_status` to find a running target, then `browser_open` on its reported URL.
Check the source identity in the run manifest before testing. Capture before/after images
on the task or requested PR using `browser_snapshot`. Resize to the affected phone and
desktop viewports. Exercise keys and focus using browser input tools. Save a short video
for timing or motion changes. Inspect console and network errors as well as appearance.

For scripted Playwright access, `scripts/agent/open-app.ts` provides `openApp`. It prepares
the loopback host before page boot. Close the context to finalize recorded video, then
close the browser. Do not use that helper as proof that external pairing works.

```bash
bun run qa handoff <run-id> <device-label>
```

Handoff uses the existing pairing command to print a fresh private, single-use pairing
link. The device label identifies the intended recipient for this handoff; the client
supplies its own label when it pairs. The token is not stored in the report. Handoff
does not authorize publishing a public tunnel.
The runner binds loopback by default. For an authorized LAN phone check, start with
`bun run qa start --host 0.0.0.0`, then use the host’s reachable LAN address and the
reported port. An explicitly configured SSH port forward or approved tunnel is another
option; the runner does not publish a tunnel. Loopback on a phone refers to the phone
itself. Do not hardcode client
origins or disable authentication to make a remote check pass.

Check the selected origin's `/health` endpoint without credentials, and open the bare origin
in a browser to confirm that the browser accepts it. Do not open the reviewer's complete
pairing URL during this reachability check: the token is single-use. If you need your own
authenticated browser, create a separate pair code for it. Generate another fresh code for
each reviewer or phone.

Solus's existing UI offers **Connections → Generate pair code** for the selected host.
The repository CLI also supports the following command with the manifest's exact data
path (replace the placeholder):

```bash
bun apps/cli/src/index.ts pair --data-dir <run-data-directory>
```

This uses the host's authenticated `/pair/open` flow and prints a short-lived link/code.
Use the link once in the intended browser context. If it expired or was consumed, generate
a new one. Preserve the browser context across turns. Confirm the host and client build
before testing; an app window alone does not identify the backend it uses. Keep pairing
links out of screenshots, committed files, and durable reports. Give a link directly only
when the user has asked to connect that device.

## Debug recipes

Mock test builds emit source maps for the web client, Electron renderer, main process,
and preload. `qa start` and `qa restart` launch Node with `--enable-source-maps`, so
standalone exceptions can name the original TypeScript source. Keep the `.map` files
beside their exact test build outputs. In browser developer tools, use mapped sources
and stack frames from that same generation; compare its fingerprint before trusting
line numbers. Playwright failure traces and page errors complement the server stack.

Production builds do not enable these test-only source maps. Do not copy maps from a
previous test build onto production output or publish a test bundle as a release.

Use the run manifest's `logDir`, not another worktree's root logs. The QA runner separates
structured logs and boot output by run. Normal `bun run dev` continues to use `dev.log`
and `dev-console.log` at the repository root. Inspect the boot output first when the server
never reached health; inspect structured events when an action failed after startup.

Set `QA_LOG` to `<logDir>/solus.log` from the manifest. Boot output is
`<logDir>/console.log`. These files belong to one run:

```bash
jq -c 'select(.level == "error")' "$QA_LOG"
jq -c 'select(.sessionId == "SESSION_ID")' "$QA_LOG"
jq -c 'select(.msg == "worktree_created")' "$QA_LOG"
jq -c 'select(.taskId == "TASK_ID")' "$QA_LOG"
```

For a failed prompt, find its session and follow the turn through dispatch, provider events,
and the final state. Check pending permission or question state before treating silence
as a stalled provider. For a failed RPC, compare the browser network/console record with
server events at the same time. For a slow action, separate server and provider duration
from transport delay and rendering. Browser snapshot Web Vitals do not measure the entire
interaction; use a trace or recording for typing, scrolling, and tab changes.

Solus Insights can correlate `turns`, `events`, `internal_events`, and `log_events` through
trace/span IDs. Use read-only `query_insights` when it refers to the host that ran the
failing action. The directing Solus instance's Insights database is not automatically the
isolated QA run's database. Check database scope and time range first. Discover columns
before writing a query, for example:

```sql
SELECT name, type FROM pragma_table_info('events')
```

Keep structured logs searchable: stable `snake_case` event names in `msg`, IDs as separate
fields, and `log.child({ sessionId })` for session-scoped work. Do not add an external
telemetry service just to investigate a local run.

## Save results and clean up

```bash
bun run qa report <run-id>
bun run qa stop <run-id>
```

Generate a report before cleanup. The report reads `validation.json` in the run directory
when supplied, checks its `generationId` and `sourceFingerprint`, and marks mismatches
as stale. Without evidence it labels behavior, visual, and native checks as not run. The
separate smoke invocation does not by itself prove that the retained review run was tested.
Add the assertions and outcomes, source/build identity,
fixture, client/provider/connection mode, screenshots, logs, traces, and any untested
surfaces. Keep failed runs' evidence, including startup failures. A generated report is
an evidence index; it is not a pass declaration without successful assertions.

Stop when the review loop ends or the user asks. The runner stops only its captured and
verified process. Never kill by process-name/path matching, use `pkill` or `killall`, or
stop another developer's server. Preserve the run directory for a useful reproduction.
Stop retains both the temporary project and run evidence for review. When the project
is no longer needed, remove it through the ownership-checked command:

```bash
bun run qa dispose-project <run-id>
```

This requires a stopped run and matching ownership records, rejects symlinked or
mismatched paths, and removes only the owned project. Data, logs, and reports remain in
the run directory. A disposed project cannot be reused by restart; start a new run.
Remove other evidence only after checking the exact disposable directory you own.
Never reset live `~/.solus`, desktop userData, or another worktree to clean up QA.
