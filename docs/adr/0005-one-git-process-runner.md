# ADR 0005 — One Git process runner, with a project policy and a storage policy

Status: ACCEPTED, 2026-11-20.

## Context

The server started Git processes in three places. Each had its own copy of the
launch, the time limit, the stop signal, the output limit, and the error.

| | `git/exec.ts` | `sync/git-storage/git-repository.ts` | `apps/app-repository.ts` |
| --- | --- | --- | --- |
| Repository | A checkout of a person | A bare repository of works or sessions that Solus owns | A bare repository of an app that Solus owns |
| Runs as | The acting identity (plans/019) | The host | The host |
| Configuration | The system, global, and repository config of the person | No system config, no global config, hooks off, no prompt | The same as storage |
| Names the repository with | The working directory | `--git-dir` | `--git-dir` |
| Bare repository guard (ADR 0002) | Yes | No | No |
| Metrics | Yes (`git_command_duration`, `git_commands_total`) | No | No |
| Input and output | Text out only | Text or a stream in, text or a stream out | Bytes in, bytes out |
| Node function | `execFile`, `execFileSync`, `spawn` | `spawn` | `execFile` |
| Error | The Node error of `execFile` | Words with no command and no diagnostics | Other words with no command |

ADR 0004 made one layer for the storage repositories of works and sessions and
left the app repositories for a later change. The Solus work "Git process
sites and the one runner" lists each place that starts Git, with file and line.

## Decision

One module starts each Git process of these three places:
`packages/server/src/git/git-process.ts`. It is in `git/` because `sync/` may
import `git/` (`tests/unit/server-module-boundaries.test.ts`) and `git/` must
not depend on `sync/`.

### The runner

`runGit(policy, args, run)` starts one Git process and answers its output as
bytes. `runGitSync(policy, args, run)` is the form for a caller that cannot
wait; it gives text. The runner owns these items, one time:

- **The launch.** The policy names the identity (`launchOptions`); the runner
  makes the command line with `launchedProcess`, so a member's process starts
  through the member switch.
- **The bare repository guard** (ADR 0002). Each process gets
  `-c safe.bareRepository=explicit` first. See "The guard and storage Git".
- **The metric.** One measurement for each process: the policy, the
  subcommand, the outcome, and the duration.
- **The time limit and the stop signal.** The runner stops the process,
  closes its output so that a hook or a helper that continues cannot hold it
  open, and records why. A stop from the caller answers at once.
- **The input and the output.** Text, bytes, or a stream in. The output is the
  answer, or it goes to a stream. The diagnostics can go to a line reader.
- **The output limit**, in bytes.
- **The error.** `GitProcessError` has a typed `reason` (`failed`, `stopped`,
  `timeout`, `output-limit`, `not-started`), the exit `code` of a process
  that failed by itself (null for each other reason), the `signal`, and the
  output that the policy lets it keep. The policy gives the words
  (`failureMessage`).

### The policies

A `GitPolicy` says who runs Git on a repository and with which configuration.
It has a name, the arguments that go before each command, the launch options
of its identity, whether an error keeps the output of the process, and the
words of a failure.

- **Project policy** (`git/exec.ts`): the checkout of a person. It uses the
  Git configuration, the credential helpers, and the signing of the person,
  and it runs as the acting identity. It adds `-c diff.relative=false` and
  `GIT_OPTIONAL_LOCKS=0`, and it refuses to start when Git is not installed.
  An error keeps the output and has the words of Node (`Command failed: …`
  and the diagnostics). `git()`, `runAsync('git', …)`, `runStreamed(…)`, and
  `gitCommitExists` keep their interface.
- **Storage policy** (`sync/git-storage/git-repository.ts`): a repository that
  Solus owns. It runs as the host, with `--git-dir`, no system config, no
  global config, no prompt, no trace variables, and hooks off. Nothing reads
  the diagnostics, because they can contain the credential of a remote, and an
  error keeps no output. `GitRepository` is the only user of this policy.

`apps/app-repository.ts` has no runner and no commit builder now. An app
repository is a `GitRepository`. The differences are parameters, as in
ADR 0004:

| Parameter | Values | Why |
| --- | --- | --- |
| `GitRepositoryOptions.author` | `storage@solus.invalid` for works and sessions; `apps@solus.invalid` for apps | A person can clone an app repository. Its new commits keep the author that the older commits have. |
| `GitRepositoryOptions.fileNames` | `plain` for works and sessions; `any` for apps | Solus makes each path of a work or a session from ids. A person names the files of an app. Each rule refuses a path that leaves the repository. |
| `GitFileContent` with bytes | Apps only | An app file can be an image. |
| `timeoutMs`, `outputLimitBytes` | 60 seconds and 32 MiB for apps | The same limits as before. |
| `GitRepositoryOptions.env` | `core.autocrlf=false` for apps | A checkout of an app revision writes each file byte for byte. |

### The guard and storage Git

The guard applies to storage Git also. A storage process names its repository
with `--git-dir` in each command, and the guard permits a named bare
repository, so no storage command changes. The guard is in the runner and not
in a policy, so a new policy cannot omit it, and ADR 0002 ("every Git process
the Solus server starts") is now true for works, sessions, and apps. A process
that storage Git starts (the upload-pack of a file remote, for example) gets
the guard through `GIT_CONFIG_PARAMETERS`; it names its repository also.

### Metrics

A project command records the same series as before: `git_command_duration`
with the label `operation`, and `git_commands_total` with the labels
`operation` and `outcome`. A storage command records
`git_storage_command_duration` and `git_storage_commands_total` with the same
labels. The series are separate so that the project numbers count what they
counted before. `gitCommandSeries` in `git/git-metrics.ts` owns the names and
the labels, and `tests/unit/git-metrics.test.ts` holds them.

### What does not change

For project Git: the identity, the environment, the arguments and their order,
the config that Git reads, the time limits, the output limit, and the metric
names and labels. For storage Git: the host identity, the environment, the
repository names, the storage formats (a test holds the commit id of an app
revision), the RPC contract, the Solus API, and the database.

## Consequences

- A change to the launch, the limits, the metric, or the error of a Git
  process is one change in one file.
- **A stopped process has a typed result.** A process that Solus stops (the
  stop signal, the time limit, or the output limit) gives a `reason` and the
  `code` null in each caller. The code is not 1, because 1 is an answer of
  Git ("no such ref") that callers read. After ADR 0004 the words of a
  storage failure showed `(null)`; the storage policy writes `(1)` for a
  process with no code, as `GitRemote` did before.
- A project command that fails gives a `GitProcessError` and not the Node
  error. The words are the same (`Command failed: <command line>` and the
  diagnostics), and `code` (the exit code), `signal`, `stdout`, and `stderr`
  are on the error as before. The Node fields `killed` and `cmd` are gone; no
  caller read them. `code` is never a text now: `pull-request-authoring.ts`
  and `worktree-manager.ts` read `reason === 'output-limit'` and not the Node
  codes `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and `ENOBUFS`. A stopped command
  gave an `AbortError`; it now gives the reason `stopped`.
- A project command gets the end of input on its standard input. Before,
  `runAsync` left the pipe open with no writer, so a command that read its
  input stopped only at its time limit. No project command reads its input.
- `runStreamed` has no `bin` parameter. Each caller ran Git. It records a
  metric now, as each other Git process does. Its error has the full command
  line, as the error of `runAsync` has.
- Storage Git and app Git record metrics and get the guard.
- A failure of an app repository has the words of the storage layer: "The app
  repository Git `<operation>` operation failed (`<code>`)." Before: "The app
  repository's git `<operation>` failed."
- A work or session commit is built with `update-index -z`. The tree and the
  commit are the same objects.
- `tools/oxlint/solus/rules/acting-identity.ts` names one file that runs Git as
  the host (`sync/git-storage/git-repository.ts`). `apps/app-repository.ts`
  is no longer in the list.

### Git process sites that this decision does not move

- `transport/handlers/setup-handlers.ts`, the clone (`attemptClone` through
  `runSetupProcess`): a setup step with a log that a client reads line by
  line, a stop from the client, and a process starter that tests replace. It
  runs as the acting identity and has the guard.
- `transport/handlers/setup-handlers.ts`, the probes (`runProbe`) and the
  `git config` writes: they start through the launch point of the acting
  identity and have the guard, so their identity rule is that of the project
  policy. They are synchronous. `git()` writes the diagnostics of Git to the
  server's own standard error, and these probes fail in normal use (a folder
  that is not a checkout). The right move is to make them wait
  (`runAsync('git', …)`), which changes the dispatch checkout path. The tests
  of that path (`dispatch-checkout-admission`, `dispatch-partial-checkout`,
  `dispatch-repository-run`) fail on `main` now, so that move needs its own
  change after they pass.
- `devices/device-process.ts` (`runDeviceCommand`), `devices/device-run.ts`,
  `devices/device-run-source.ts`, and `devices/device-run-setup.ts`: the device
  domain runs each tool (`xcrun`, `adb`, Git) through one command runner that
  its tests replace, with the device environment of the host. To move its Git
  commands changes who runs them. That is a product decision of the device
  domain. They have the guard.
- `packages/lab/`: the Lab is a test tool outside the server process. It
  reads fixture repositories with plain Git.
