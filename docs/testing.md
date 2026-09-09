# Tests that protect app behavior

A test belongs in the app suite when it drives production behavior and checks
an outcome that matters to a user. State changes, saved data, permissions,
provider requests, navigation, error recovery, and resource use all qualify.
A small function test qualifies when its result controls one of these outcomes.

Do not test source spelling, import style, component structure, Tailwind classes,
fixed pixel values, copied registries, dependency exports, or instructional prose.
These checks can pass while the feature is broken. Keep development lint rules
and their own tests separate from the app suite.

Use real production logic with small fixtures. Mock external boundaries, then
assert the resulting state, output, or request. A test that only confirms what
its own mock returned provides no app coverage. Compiling and executing a real
Svelte controller is useful; searching its source for an effect is not.

Keep distinct failure paths and boundary cases. Remove repeated assertions of
the same outcome when another test already covers them. Update stale fixtures
for useful tests. Keep a failing test when it exposes a current app defect.

## Run the suite

```sh
bun run test:unit
bun run test:unit task-store.test.ts
bun run test:unit browser-inspect.test.ts log-file-path.test.ts
```

The runner starts a fresh Bun process for each file, with at most four files
running at once. Each file gets a temporary `SOLUS_DATA_DIR` and a 30-second
deadline. Bun's runtime transpiler cache is disabled for these processes because
cached modules on Bun 1.3.14 intermittently fail to resolve the SQLite mock.
Failures include the file's output and make the command fail. Optional
arguments select paths by substring. A selection with no matches fails.

On macOS and Linux, the runner owns a process group for each test file and stops
its remaining descendants when the file exits, times out, or is cancelled.
Windows uses Bun's `--no-orphans` and direct child termination; descendant
cleanup on Windows has not been verified. Tests must still close their own
resources and remove their fixtures.

Use temporary data for all tests. Never start a test against live Solus data.
Run browser and Electron workflows only with the required app fixtures and
explicit approval for interactive verification. Listing Playwright tests does
not execute those workflows.

## September 2026 audit

The audit removed 37 test files and 333 static test declarations, with about
5,400 net lines removed from test files. Parameterized cases can expand one
declaration into several executions. Counts compare the audit's initial file
copies with its edits; unrelated workspace changes are excluded.

| Removed checks | Examples and reason |
| --- | --- |
| Source and layout assertions | Browser, task and PR surfaces, picker styles, sidebar sizing, focus wiring, and workspace import allowlists. They searched code instead of driving the feature. |
| Constants, copied catalogs and dependencies | Magic schema versions and pixel offsets, a copied metrics registry, CodeMirror availability, and the updater package getter. They did not establish app behavior. |
| Retired APIs and unusable fixtures | The old checks-activity store API, skipped diff workflows that injected the old `window.solus.diff` API, and an unseeded plan-menu placeholder. |
| Duplicate and empty workflow checks | Repeated document-page opening checks, repeated status-card presence checks, and a navigation probe that only printed results. |

Mixed files retain their executable behavior tests. Fixtures were updated for
the current Insights paging API, saved prompts API, GitHub client metadata,
repository scopes, document lifecycle, and SQLite test setup. The unused source
import scanner helper was removed.

The shared Bun worker run reproduced a high-CPU hang. Its parent timed out, but
a worker survived despite `--no-orphans`. The replacement runner completed all
585 unit files in 18.4 seconds: 583 passed and two failed. This final run
also included behavior tests added by other work during the audit. A
temporary blocked test verified both deadline and cancellation cleanup,
including termination of its child process. The probe was then removed.

The following behavior failures were retained:

- `session-config-default-model.test.ts`: selecting an external worktree keeps
  the draft's working directory but replaces its Git repository root with the
  worktree path. `gitCheckoutFromState` derives the root from that path even
  when the supplied Git state names the original repository.
- `task-sync-engine.test.ts`: two merge-completion cases fail. PR links store a
  canonical repository scope, while `completeTasksForMergedPullRequest` queries
  by the local path supplied by the merge handler. The task remains unfinished.

The desktop and web build passed. Playwright discovered 221 tests in 42 files;
the workflows were not executed. Full diff interaction and plan-menu coverage
need current fixtures before new end-to-end tests can provide proof. Existing
diff parsing, review, annotation, navigation, and persistence tests remain.

This change does not alter product behavior on desktop, web, or mobile. The
retained suite covers shared behavior and provider boundaries; it does not
replace visual verification of either mounted desktop mode or mobile layouts.

## Second pass

The second pass removed 40 more test declarations and two test files. It used
an assertion and duplicate-body scan across the remaining suite, followed by
manual inspection of selected test bodies in layout, onboarding, Insights,
models, goals, tool adapters, tasks, PRs, navigation, editor utilities, and
Electron workflows. This is not a claim that every remaining test body received
an individual manual review.

Removed cases pinned constant values or CSS tokens, copied a production decision
into the test, proved test-local arithmetic, or repeated an existing scenario.
Permission, completion, and rate-limit assertions now run inside their existing
transition and recovery workflows, avoiding repeated app launches. Small
function tests remain when they protect an actual product rule.

Four retained checks now give stronger evidence:

- Column search ranks competing exact, prefix, and description matches.
- A one-sided PR change produces blocks; an empty result can no longer pass.
- Rebinding and resetting a shortcut must change the sidebar through key presses.
- Separate tabs must retain different session states at the same time.

Onboarding bindings also require a nonempty result. Misleading test names were
corrected. The split-pane fixture uses the existing keyboard mode switch instead
of the retired `window.solus` bridge. The obsolete background-session injection
was removed from the input-focus workflow; that scenario still needs a current
session fixture. Opening and switching tabs still check input focus.

Validation: all 583 unit files passed in 18.1 seconds. The onboarding file passed
again after its final nonempty assertion. The desktop and web build passed with
existing warnings. Playwright discovered 210 tests in 42 files; these interactive
workflows were not executed. No product implementation was changed in this pass.
Concurrent workspace fixes resolved the behavior failures recorded in the first
pass; the cleanup did not delete those failing assertions.
