# Worktree and pull request identity

A selected worktree has two paths: `repoRoot` names its owning project and
`worktreePath` names the checkout where the agent runs. An external worktree can
be outside the project directory. Selection, Git refresh, and draft inheritance
must retain the known project root. Git's checkout identity alone is not enough
to recover that root.

Task PR links use the lowercase `host/owner/repo` identifier and PR number.
Both the merge handler and the background reconciler use that identifier when
they complete linked tasks. The reconciler resolves this identifier directly
to a code host; it does not treat it as a local directory.

A task completes when all its linked PRs are merged. A closed, unmerged PR or
an unreadable PR does not count as merged. The task's own project path supplies
the `taskDoneOnMerge` setting; `false` leaves the task status unchanged. Tasks
already marked done or dropped are not changed.

These rules apply to the shared desktop, web, and mobile clients and both agent
providers. They do not depend on the client and server sharing a filesystem.
