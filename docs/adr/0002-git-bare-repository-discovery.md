# ADR 0002 — Solus Git commands do not discover bare repositories

Status: ACCEPTED, 2026-10-19 (T3 review item #20440).

## Context

Git finds a repository in two ways. It follows a `.git` entry (a folder or a
`.git` file), or it treats the working directory, or a folder above it, as a
bare repository. The second way also reads that folder's config, and config
can run commands (`core.fsmonitor`, hooks, aliases). A project or an agent can
write such a folder, for example a vendored `*.git` folder in a cloned
project. If Solus then runs Git with its working directory inside that folder,
Git reads config that the folder's author wrote.

The review found no option-injection or command-execution path in Solus. Git
arguments go to `execFile` without a shell. The checkout RPC checks a branch
against `listBranches`, and `gitCommitExists` gets stored or provider SHAs.
This is a hardening decision, not the fix of a reported exploit.

## Decision

Every Git process the Solus server starts gets
`-c safe.bareRepository=explicit` before its own arguments. One function owns
the policy, `withBareRepositoryGuard` in
`packages/server/src/git/bare-repository-guard.ts`. These spawn paths use it:

- `git()` and `runAsync('git', …)` in `git/exec.ts`: worktrees, status,
  diffs, session snapshots, commits, pull request checkouts, and reviews.
- The setup handlers (`transport/handlers/setup-handlers.ts`): the readiness
  and checkout probes, the `git config` writes, and the clone.
- The device runs: `runDeviceCommand` in `devices/device-process.ts`, which
  prepares a run's owned checkout, and the build spawner in
  `devices/device-run.ts`. A test that injects its own runner or spawner gets
  the arguments it asked for.

With the guard:

- Git reads a bare repository only when Solus names it with `--git-dir` or
  `GIT_DIR`.
- A checkout, its `.git` folder, a linked worktree, a worktree of a bare
  repository (its `.git` file names the repository), the `.bare` layout with a
  `.git` file, and a submodule work as before.
- Command-line config is protected configuration. A repository cannot turn the
  guard off, and neither can inherited `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_PARAMETERS`, or a global `safe.bareRepository = all`.
- Hooks inherit the guard through `GIT_CONFIG_PARAMETERS`. A hook that runs Git
  inside a bare repository must name it with `--git-dir`.
- Git before 2.38 ignores the key, so the guard has no effect there and breaks
  nothing.

## Consequences

- A project folder that is itself a bare repository has no Git features in
  Solus. Before this decision it had none that worked either: `git status`
  needs a work tree, and `resolveRepoRoot` answered the parent folder.
- The agents' own Git commands are not changed. Claude and Codex run Git in
  their own shells, outside these spawn paths.
- A device run's checkout fetches from the project with its own upload-pack.
  The guard reaches that process too; it names the project explicitly, so the
  fetch works.

`tests/unit/git-bare-discovery-guard.test.ts` checks the refused and the
preserved cases with real Git and isolated config.
`tests/unit/git-bare-guard-callers.test.ts` drives the setup handlers and the
device runners. Run both with
`plans/t3-performance-review-2026-10-19/run-server-git-tests.sh` while test
files in this checkout cannot read the output of a child process.
