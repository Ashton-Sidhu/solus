# Lane report — server-correctness (2026-10-19, revision 3)

Four separate changes: #21366, #20449, #20446, #20440. No commit, no PR, no
build, no dev server, no live data. The baseline was the dirty tree at
`14eec2300`. Before my edits, none of the files I changed had local changes,
except where this report says so. Revision 2 answers the parent review: Git
guard coverage, a visible and stoppable detached child, rename aliases, and
typed child inputs.

## #21366 — a Codex native child that outlives its root turn

**Defect:** at the end of the root turn, `finishCompletedTurn` deleted the
child-thread routing. Output and the report of a child that still worked were
dropped, after completed and failed roots.

**Lifecycle now (existing contracts only):**

- The root run ends at once: same exit code, `activeRuns` removal, and queue
  drain. A child still working becomes a background task of the session:
  `background_task_started { taskId: child thread, toolUseId: spawn card }`,
  announced before the turn's result, as a command left running is.
- `hasBackgroundTasks` includes detached children, so the exit settles the
  session in `background`. Desktop and web show the background row with Stop.
  Mobile shows the background pill with Stop. Clients need no change: they
  already tag the spawn card from `toolUseId` and say "Waiting on a subagent…".
- A **failed** root with work still running now also waits in `background`
  (`provider-events.ts`). The failure is reported at exit as before: the error
  is emitted once, and the terminal is recorded as an error. The wait ends as
  `failed`, once (`failedBeforeBackground`). This also applies to a Codex
  command left by a failed turn: before, it ran on with no Stop. A completed
  root ends its wait as `completed`, as before.
- The child keeps the root run's normalizer, so its events go to its card and
  never to a later root run. Only card events pass.
- The task settles once: when the child's turn ends (`completed`/`failed`),
  when Stop interrupts it (`stopped`), when a later root links it again (old
  card `completed`), or when the app-server exits (`killed`, with a failure
  report). Shutdown drops all. A repeated end reports and settles nothing.
- Stop: `stopBackgroundTask` (background row, mobile) and `cancelSession`
  (session Stop) send `turn/interrupt` to the child turn. Stop during the root
  turn also interrupts its children; an interrupted root keeps none.
- **Revision 3 — Stop settles only from Codex's own state.** An error answer
  to `turn/interrupt` no longer counts as proof that the turn ended. After an
  error answer, or when the turn id is not known, the host reads the child
  thread (`thread/read`, `includeTurns`). A turn in progress is interrupted
  (when Codex just refused that same turn, Stop answers false). A turn that
  already ended settles the task from that turn's real status and report.
  With no turn yet, the stop intent is kept, and the child's `turn/started`
  sends the interrupt. With no answer to the interrupt or to the read, the
  task stays visible and Stop answers false. A failed Stop is forgotten, so
  the child's own end later settles as it really ended.
- **Revision 3 — spawn replay.** A repeated or replayed spawn record
  (`item/started` and `item/completed` for the same spawn) no longer makes an
  ended child work again. Only a new `turn/started` does, so a root end
  creates no phantom background task.
- **Notification order.** In the local log, each spawn record came before the
  child's `turn/started` (3 of 3, 11 to 17 ms apart). Stop covers both
  orders: with the spawn first, the kept stop intent interrupts the turn when
  it starts; with `turn/started` first (not observed), the thread read finds
  the running turn.
- When a child ends on its own and nothing else runs, the backend emits the
  new server-internal event `background-work-ended`. `ProviderEvents` ends the
  wait. A stopped or killed task ends the wait through its own settle, as
  before. No wake prompt is queued.

**Wake decision — evidence and what stays open.** I did not add a wake. These
facts are from read-only checks:

- The generated app-server protocol has no event that says a child finished
  for a parent with no turn. `turn/started` has no trigger or source field.
  `SubAgentActivityKind` lists `started | interacted | interrupted`.
- The local `dev.log` (real Codex traffic, read only, method/id/time fields
  only): 3 children spawned, 6 child turn ends, 55 `interacted` items, and 6
  `subAgentActivity` items of kind `completed` on the parent. That kind is not
  in the generated types. Each `completed` item arrived under the parent's
  active turn, just before the child's `turn/completed`. All 6 child turns
  ended while their parent turn was active. No child outlived a parent turn in
  the log. The parent turn that started 2 s after another ended was a Solus
  queued prompt (`queued_request_processing` at 17:04:00.673).
- So it is not established whether Codex starts a parent turn by itself when a
  detached child ends. If it does, Solus does not see that turn (no run owns
  the root thread), and the session settles when the child's task settles.
  To decide, a live run is necessary in which a child outlives a completed
  root and a failed root. If Codex does not wake the parent, Solus needs a
  product decision: queue a "sub-agent finished" wake like the command wake,
  or keep no wake.

**Seen in the log, not changed:** a later root turn that re-engages an
existing child (`interacted`, not a new spawn) does not route that child's
events. `codexSpawnedThreadLinks` links only `started`. This existing limit is
documented in `docs/background-work.md`.

**Tests added in revision 3** (`codex-native-child-lifetime.test.ts`, all
through `onNotification`, `finishCompletedTurn` and `stopBackgroundTask`):
spawn record replayed after the child's end (no background task), an
unrelated RPC error with the turn still running (false, visible, later
natural end settles `completed`), a no-turn error with the turn already ended
(settles from the read: report and `completed`), no answer to the interrupt
or the read (false, visible), Stop between the spawn record and
`turn/started` (interrupt sent when the turn starts, settles `stopped`), and
`turn/started` before the spawn record (the read finds the turn; settles
`stopped`). The file has 23 tests; all pass.

**Typed inputs (#4 of the review):** `codex-native-children.ts` takes the
generated `CodexServerNotification` union and narrows on `method`. It reads
`ThreadItem`, `TurnStartedNotification` and `TurnCompletedNotification`
fields. Synthetic turn ends are complete typed `turn/completed` messages.
There is no `any`, no zod, and no `typeof` in the module.

## #20449 — containment of project-relative file mutations

- Resolved-parent containment, as in revision 1. A link in the middle that goes
  outside, or that is dangling, is refused. A final link is the entry itself.
- **Rename occupancy (revision 2):** `isNameTaken` compares entries with
  `lstat` and never follows a link. Two links to one target, a file and a link
  to it, and a hard link are distinct names, so the rename is refused. A
  case-only rename is allowed only when both names are the same entry
  (`dev`/`ino`) in the same folder and the folder does not list the new name.
  A rename to the name it has changes nothing and succeeds.
- Tests: `project-file-mutation-links.test.ts` has 17 tests: links in the
  middle, final links, dangling links, links inside the project, a root given
  through a link, two links to one target, a file and a link to it, a hard
  link, the same name, and a case-only rename. The case-only test runs on this
  case-insensitive filesystem. Together with `project-file-mutations`: 27 pass.

## #20446 — masked browser values

Unchanged from revision 1. `type=password` and computed
`-webkit-text-security` values are left out of the snapshot. 2 tests pass.

## #20440 — explicit bare-repository discovery

- One policy source: `withBareRepositoryGuard(command, args)` in
  `packages/server/src/git/bare-repository-guard.ts`.
- Covered spawn paths: `git()` and `runAsync()` (`git/exec.ts`). The setup
  handlers: `runProbe`, `probeSucceeds`, the three `git config` writes, and the
  clone spec (its display text is unchanged). `runDeviceCommand`, the
  production device runner that `DeviceRuns` and `DeviceRunSources` use. The
  build spawner `defaultSpawn` (it runs `git check-ignore`; it is now exported
  for its test). Injected test runners and spawners are not wrapped, so their
  behavior and identity stay the same.
- No other production Git spawn was found in `packages/server/src`, `apps/standalone-server/src` or
  `apps/desktop/src/main` (search for `'git'` as a process command). The
  agents' own Git commands are outside Solus spawns and are not changed.
- Tests: `git-bare-discovery-guard.test.ts` (10) and
  `git-bare-guard-callers.test.ts` (5). The callers test drives
  `runDeviceCommand`, `DeviceRunSources.prepare` through the real runner
  (clone, upload-pack fetch, checkout), `defaultSpawn`, `setupAdoptProject`
  (refused fixture and adopted checkout), and `setupCloneProject` (the
  spawned arguments). Its fixture is a Git folder whose own config names
  another work tree and an origin. Without the guard Git follows it; the
  fixture asserts this before the tests.
- ADR updated: `docs/adr/0002-git-bare-repository-discovery.md`.

**Runner:** under `bun test`, a test file below this checkout's `tests/`
cannot read child-process output (the parent confirmed this with
`scripts/test-unit.ts`). Use
`sh plans/t3-performance-review-2026-10-19/run-server-git-tests.sh`. It copies
each Git test to a new temporary folder with absolute imports and runs it from
the repository root, so `bunfig.toml` and `tests/preload.ts` apply. It covers
`git-bare-discovery-guard`, `git-bare-guard-callers`, `git-optional-locks`,
`device-run-source` and `create-project`. Result: 10 + 5 + 2 + 5 + 6 pass,
0 fail. The script does not change the runner or the Git probe.

## Checks run (revision 2)

| Check | Result |
|---|---|
| Codex set (child lifetime and 8 existing Codex suites, one run) | 83 pass |
| Session consumers (`provider-events-background-outcome`, `stale-background-status`, `cross-provider-subagent-session-runtime`, `session-event-subagent`, `background-session-title`) | 49 pass |
| Files and browser (`project-file-mutation-links`, `project-file-mutations`, `browser-snapshot-masked-values`) | 29 pass |
| Device and setup suites in the repository runner (`device-run`, `-app`, `-build`, `-log`, `-network`, `-profiles`, `setup-readiness-seats`, `repository-checkout`) | 54 pass |
| Git script above | 28 pass |
| `tsc -p packages/server/tsconfig.json --noEmit` | No error in new files or on changed lines. Existing errors elsewhere are the same; two in unchanged `provider-events.ts` branches (plan link, permission resolved). |
| `oxlint` | New files clean. Changed files have the same rule findings as HEAD. Complexity: `onNotification` 68 → 70; the exit handler 36 → 35. |

Existing failures this lane did not cause: `codex-subagent-completion` and
`codex-event-normalizer` fail when run alone. Their import chain needs a
`node:sqlite` mock, and they import no file I changed; with the set above they
pass. `session-runtime-background-status` fails at `session_init_without_session`
in other dirty launcher work. `codex-compact`, `codex-steering` and
`codex-idle-thread-unload` fail the same with the HEAD backend.
`browser-link-host` needs a missing `workspace-ui` export.

## Files

New: `codex-native-children.ts`, `git/bare-repository-guard.ts`,
`docs/adr/0002-git-bare-repository-discovery.md`, tests
`codex-native-child-lifetime`, `provider-events-background-outcome`,
`project-file-mutation-links`, `browser-snapshot-masked-values`,
`git-bare-discovery-guard`, `git-bare-guard-callers`, and
`run-server-git-tests.sh` in this folder.
Changed: `codex-backend.ts`, `agent-backend.ts` (event type),
`sessions/provider-events.ts`, `files/project-mutations.ts`,
`browser/page-script.ts`, `git/exec.ts`, `transport/handlers/setup-handlers.ts`,
`devices/device-process.ts`, `devices/device-run.ts`, and the docs
`background-work.md`, `projects.md`, `solus-tools.md`.

## Not run

No live Codex app-server, browser, simulator, or device. Still to do: a live
Codex run in which a native child outlives a completed root and a failed root,
with Stop from the background row and from mobile. Also file-tree link checks
on Linux and on Windows (junctions), and Git on Linux and Windows.
