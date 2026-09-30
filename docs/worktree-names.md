# Worktree identity and names

A checkout is identified by its host and path. Its branch name can change without
changing that identity. The directory keeps its original name when a branch is
renamed.

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
