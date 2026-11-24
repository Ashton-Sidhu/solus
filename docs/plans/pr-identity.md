# Pull request identity

A pull request is named by its repository and its number. A project is not
part of its name. A project is one way to find a repository, and the place
where a checkout of it lives.

## Problem

Every pull request RPC took an `IpcContext` and found the repository from the
project in it (`reviewTargetFor`). To read a pull request of a repository that
is not a project, a client put the repository key in `session.projectPath`
(`repositoryContext`), and `repoForScope` read it back. One field then meant two
things: a folder, or a repository. That is two architectures behind one shape.

## Vocabulary

- **`PrRef`** — `{ repo: RepoRef; number: number }`. One pull request.
- **Per-PR call** — reads or changes one pull request through its code host. It
  takes a `PrRef` and no `IpcContext`.
- **Repository call** — about a repository's pull requests as a set: checks,
  PR sync interest, refresh. It takes a `RepoRef`.
- **Project call** — needs a folder on a host: a list of a project's pull
  requests, a checkout, a guide, conflict resolution, interdiff. It takes an
  `IpcContext`, as before.

## Decisions

1. Per-PR calls take a `PrRef` first. A request type that names a pull request
   (`PrDiffRequest`, `PrDiffFileContentsRequest`, `PrStackMergeRequest`)
   extends `PrRef` instead. A guide's diff sets `guide: true`; it no longer
   says so by carrying `repo`.
2. `prChecks`, `prRefresh` and `prSetInterest` take a `RepoRef`.
   `prSetInterest` also takes the checkout an interest in a branch is resolved
   against, when it has one.
3. `prRepository(ctx)` answers a project's repository. It reads the local Git
   remote only. A client asks it once per project and keeps the answer.
4. `prUpdate` takes the session to link the pull request to, and
   `prSubmitReview` the checkout to keep its review checkpoint in. Both were
   read from the context before.
5. Project calls do not change. `prPrepareCheckout` still refuses a pull
   request of another repository than the project's.
6. A client still groups the pull requests it holds by scope; a repository
   with no project is a scope named by its key (`repositoryContext`). Per-PR
   and repository calls from such a scope send its `PrRef` or `RepoRef`
   (`repositoryOfScope`), never the scope.
7. `prInspectUrl` is removed. A pull request opened by its URL is read with the
   per-PR calls, in the same panel as any other.

## GitHub calls

None are added or changed. Each handler's provider and `prIndex` calls stay
as they are; only where the handler finds the repository changes. The reads
that only `prInspectUrl` made go with it.
The batched list reads (`prListProjects`, `batchedPages`, `listPages`) are
project calls and do not change. `prIndex` keys a repository by its spelling,
so a URL of a project's repository is read with the project's own `RepoRef`,
not the URL's spelling.

## Not in scope

- The demo client (`apps/client/src/demo`).
- Guide and lens project calls (`prGuideMetadata`, `prGuideStatuses`,
  `prLensRevisions`) still take a context, and a pull request of a repository
  with no project still sends its repository scope there. The host reads that
  scope in `repoForScope`. Moving those calls to `PrRef` removes the last use
  of the `host/owner/repo` scope form on the wire.
