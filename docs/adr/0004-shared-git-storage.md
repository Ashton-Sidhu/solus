# ADR 0004 — Works and sessions use one Git storage layer

Status: ACCEPTED, 2026-11-20.

## Context

Two features keep their history in private bare Git repositories, on a host
and in cloud storage (Cloudflare Artifacts, or a folder of bare repositories
that stands in for it on one machine):

- **Works** (Folio): `data/works/` and `sync/works/`. One repository
  `work-<48 hex>` for each work.
- **Portable sessions**: `sync/sessions/` (docs/plans/portable-sessions.md).
  One repository `session-<48 hex>` for each session.

Each feature had its own copy of the same Git rules. Before this decision
there were:

- four Git process runners (`SessionRepository.git`, `LocalWorkRepositories.git`,
  `GitRemote.git`, and the two `launchProcess('git', …)` calls of the local
  session provider), each with its own copy of the environment rules
  (no system or global config, no prompt, no hooks, no trace variables), its
  own time limit, and its own output limit;
- six places that made a bare repository with `init --bare --initial-branch=main`;
- two commit builders that write Git objects with no checkout
  (`SessionRepository.commit` with a temporary index, and `buildArchiveCommit`
  with `mktree`);
- three blob reads (`cat-file blob`, and `show` in two places);
- two local Git stand-ins for cloud storage (`LocalWorkRepositories`, and the
  `local-git` branch of `sessionRemoteProvider`);
- one Cloudflare Artifacts client, named for works and used by sessions;
- three copies of the repository name rule and four copies of its check;
- two copies of the Artifacts environment read.

`GitRemote` and `checkedPush` were already common. The full list, with file
and line for each pair, is in the Solus work "Git storage: duplicates and
design".

## Decision

One layer, `packages/server/src/sync/git-storage/`, owns each Git command, each
Cloudflare Artifacts call, and each local Git remote rule. The name rule is in
`packages/server/src/data/storage-repository-name.ts`, because `data/` must not
import `sync/` and the name is a value that records keep.

### The primitives

- **`storageRepositoryName(kind, owner, id)`** and
  **`isStorageRepositoryName(name, kind?)`**: the one name rule,
  `<kind>-<first 48 hex of sha256(JSON([owner, id]))>`. The rule is the same
  as before for each feature; a test holds fixed names.
- **`GitRepository`**: one bare repository on disk. It is the only code that
  runs Git for storage. Since ADR 0005 the process itself starts in the one
  Git process runner (`git/git-process.ts`), and `GitRepository` owns the
  storage policy of that runner. `git(args, io)` runs one command
  (always `--git-dir`, the host environment with no system config, no global
  config, no prompt, no trace variables, hooks off, text or a stream as input,
  the output as the answer or sent to a stream). On top of it: `init`, `head`,
  `setHead`, `isAncestor`, `fetchMain`, `borrowObjects`, `readText`,
  `appendFiles`, `writeBlob`, and `writeCommit`. `repositoryPath(root, kind,
  name)` is the one rule for where a named repository is in a folder.
- **`GitRemote`**: the remote of one `GitRepository`, with a token that only
  an askpass file holds. `repository`, `remoteHead`, `checkedPush`, `close`.
- **`RepositoryProvider`**: the place that holds the remote copies. `remote(name,
  access)` gives a URL and a token, `readFile(name, commit, path, maxBytes?)`
  reads one file without a clone, `remove(name)` deletes a repository, and
  `storageScope` identifies the place. Two adapters:
  `ArtifactsRepositoryProvider` (Cloudflare Artifacts) and
  `LocalGitRepositoryProvider` (a folder of bare repositories).

### What a feature owns

A feature gives only what is its own:

- **Works**: the name `work-…` for an organization and a work, the archive
  layout (`manifest.json`, `bodies/<content hash>`, `content.<extension>`),
  the rules of an archive push (`GitWorkTransport`: the same operation is not
  written twice, an archive belongs to one work, a body never changes), the
  durable batches (`WorkArchiveWriter`), and the choice of the provider
  (`SOLUS_WORK_STORAGE`, `startWorkStorage`).
- **Sessions**: the names `session-…` for a local copy and for a cloud copy,
  the repository layout (`manifest.json`, `rows/`, `diff/`, `code/`,
  `threads/`), the rules of a turn commit and of a bundle between hosts
  (`SessionRepository`, which extends `GitRepository`), the push queue, the
  Solus API routes and their admission, the choice of the provider
  (`SOLUS_SESSION_STORAGE`, `sessionRemoteProvider`), and `SessionCloudReader`.

### Differences that stay as parameters

Each of these is a real difference between the callers, so it is an input of
the shared layer and not a second copy of the code:

| Parameter | Values | Why |
| --- | --- | --- |
| `GitRepositoryOptions.timeoutMs` (one process) | 10 minutes for a local session copy; 30 seconds for a local provider | A session blob can be a large transcript or a code bundle. A provider read is one small file. |
| `GitRepositoryOptions.deadline` (all processes of one remote) | 120 seconds for a work push; 10 minutes for a session fetch; 60 minutes for a session push | A remote operation is many processes with one limit. The process that the deadline stops answers "The Git operation timed out.", which `checkedPush` reports as `timeout`. |
| `GitRepositoryOptions.outputLimitBytes` | 16 MiB by default; 1 MiB for a session fetch | The fetch reads only commit ids. |
| `readText(…, maxBytes)` | 1 MiB, 4 MiB, and 2 MiB in `SessionCloudReader`; none for a work body | The Solus API holds a session file in memory for a client. A larger file gives `RepositoryFileTooLargeError`. |
| `GitRepositoryOptions.subject` | `session repository` for a local session copy | The sync card shows the words of a failed Git process to a person. They stay the same. |
| `GitCommit.keepParentFiles` | `true` for a turn commit; `false` for a work archive | A session adds the files of a turn to its history. A work archive writes its whole tree from the manifest. |
| A commit entry that names a blob (`{ path, blob }`) | Works only | A work archive is a partial clone. The older bodies are only in the remote, so the tree names their blobs and Git does not check that they are local. |
| `GitCommit.date` | The capture time of a work operation; none for a session | A retry of a work operation must give the same commit. |
| The kind of a `LocalGitRepositoryProvider` | `work` or `session` | A provider of one feature must not open a repository of the other. |
| The namespace variable of `ArtifactsRepositoryProvider.fromEnvironment` | `SOLUS_ARTIFACTS_NAMESPACE` or `SOLUS_SESSION_ARTIFACTS_NAMESPACE` | Each feature has its own Artifacts namespace. |
| The storage scope that a work record keeps for local Git | `local` | It is a stored value. The session records keep `file://<folder>`. |

### What does not change

The repository names on disk and in Cloudflare, the layout of each repository,
the manifest formats, the RPC contract, the Solus API routes, the database
schema, the environment variables, and the words of each error that a person
can see.

## Consequences

- A change to the Git environment, to the Artifacts API, or to the checked
  push is one change in one file.
- `tools/oxlint/solus/rules/acting-identity.ts` names one file that runs Git as
  the host for storage (`sync/git-storage/git-repository.ts`). Before, it named
  four.
- A work archive commit is now built with a temporary index (`update-index`,
  `write-tree --missing-ok`) and not with `mktree --missing`. The tree and the
  commit are the same objects.
- A provider read uses `cat-file blob` in each adapter. `show` gave the same
  bytes.
- A Git process that Solus stops because its output is too large, or because
  its own time limit ended, reported the exit code `null` in each caller.
  `GitRemote` reported `1` before. ADR 0005 changed this: a stopped process
  reports `1` in each caller, and its error has a typed reason.
- Output over the limit is always an error. Before, a process that ended
  before the stop arrived could answer with a part of its output.
- The settings of a remote (no credential helper, the file protocol, the
  HTTP stall limit) are Git config pairs in the environment of `GitRemote`.
  "Hooks off" is an argument of the one runner, so it applies to each process.
- `ArtifactsRepositoryProvider` checks the form of the account and of the
  namespace before a feature compares the storage scope with its records. A
  configuration with the two faults reports the other fault first.
- The local provider checks a file path with the general rule (plain path
  segments). The local session provider had a list of the three session file
  patterns; `SessionCloudReader` asks only for those three.
- Not in this decision: `apps/app-repository.ts` had its own Git runner and
  commit builder for app repositories. ADR 0005 moved it to `GitRepository`.
