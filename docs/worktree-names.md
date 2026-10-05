# Worktree identity and names

A checkout is identified by its host and path. Its branch name can change without
changing that identity. The directory keeps its original name when a branch is
renamed.

## Branch naming

Settings > Source control > Worktrees > **Branch names** sets how Solus names the
branch of a new worktree on this host. The setting is the host config key
`worktreeBranchNaming`. Desktop, web, and mobile show the same row.

| Mode | Template | Behavior |
|---|---|---|
| Name from title (default) | `{prefix}/{slug}` | The worktree starts on `{prefix}/<id>`. When a title is generated from the first prompt, the branch is renamed to `{prefix}/<slug>`. |
| Short id | `{prefix}/{id}` | The first name is final. No model names the branch. |
| Custom template | your template | Tokens: `{prefix}`, `{slug}`, `{id}`, `{user}`. The branch is renamed only when the template uses `{slug}`. Before the rename, `{slug}` holds the id. |

- `{prefix}` is the prefix setting. The default is `solus`. Empty means no prefix.
- `{id}` is eight random hex characters.
- `{slug}` is the generated title in lowercase words joined by `-`.
- `{user}` is the project's `git config user.name` as a slug. If git has no user,
  the token is empty and the separator next to it is removed.

Solus cleans every name to git's ref-name rules (`git check-ref-format --branch`):
spaces and forbidden characters become `-`, and repeated `/` and `.` collapse. A
template with an unknown token, or one that cannot make a valid name, falls back
to `solus/{slug}`. Settings shows the error and an example name. If a title
cannot make a name, the worktree keeps its temporary branch. A worktree is never
left without a branch. A name that a branch already holds gets a `-2`, `-3`, and
so on suffix.

A project can override the host setting in Settings > Projects > **Override
branch names**. The override is saved in the project's `.solus/config.json` as
`worktreeBranchNaming`, so a team can commit it. The override applies to every
worktree of that repository. It does not depend on the agent provider.

## Server owner

`git/checkout-service.ts` owns current checkout state. Session startup, continuing
in a worktree, remote project setup, pull request preparation, and automation
creation use this service. The low-level worktree manager runs Git commands.
The control plane attaches sessions to checkout paths rather than owning a second
checkout watcher or identity map.

A successful Solus rename publishes `git.checkoutChanged` with the checkout path,
current state, host generation, revision, and a rename receipt: previous branch,
new branch, and time. The service updates the object held by pending dispatch, so
naming can finish before the session starts. Failed or skipped renames do not
publish a rename receipt. Git's existing guard preserves a branch the user has
switched or published while automatic naming was in progress.

External Git changes pass through the same service as observations. An observation
can be a rename, a branch switch, detached HEAD, or checkout removal; it does not
claim a confirmed rename. Status reads that started before a committed change
cannot replace the newer identity. Filesystem watchers are installed when clients
have a foreground lease. Headless runs still use the service and refresh before
starting in an existing worktree.

The latest confirmed rename is retained in memory and written to the structured
`worktree_branch_renamed` log. This is not a durable rename-history database. Git
is the durable source of current identity after a host restart.

## Client projection and recovery

`contexts/git/checkout.store.svelte.ts` is the shared client projection. It is keyed
by host and checkout path. Environment panels, session/sidebar names, worktree
picker rows, transcript dividers, browser page groups, and outbound session
contexts resolve names from it. Cached status and session attachments provide a
fallback only while no checkout record is available. A known removed checkout
cannot fall back to its old name.

`checkoutSnapshot` reloads current state on connection recovery. Each record has
a revision; older responses cannot undo a newer event. A host generation permits
revision numbers to restart after a host restart and rejects responses from an
older generation. IPC and WebSocket clients use the same typed contract. This is
shared by desktop, web, and mobile, and does not depend on the agent provider.

A “Continued in worktree” divider records the checkout path. Older dividers can
match their original managed-worktree slug. If no matching checkout is known,
the recorded label remains a historical fallback. Closed session rows carry their
checkout path when the session index has one, with their recorded branch as a
fallback. Custom browser page labels remain unchanged, even when they happen to
match the original branch name.

## Verification

Focused tests cover startup naming before session registration, a status scan
already in flight during rename, shared session attachments, external branch
switches, detached HEAD, restart snapshots, host isolation, stale client snapshots,
browser label projection, dividers, and outgoing session contexts. Test repositories
and data directories are disposable; live Solus data is not used.
