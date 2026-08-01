# Dispatch carries the repository, not your working tree

Status: accepted

Sending a session to another host ("dispatch") guarantees only that the **repository** is present
and fresh on that host. It clones when the host has no base checkout, then cuts a session worktree
off the origin default branch. Your uncommitted local changes do not travel — the only thing that
crosses machines is the git remote, and the code comes from the code host, not from your laptop.

We considered making work follow you (pushing a WIP branch, or syncing the working tree) and cut
it. It turns a cheap, well-understood operation into one with real hazards — throwaway commits in
history, or a bespoke sync path that has to reconcile two dirty trees — for a workflow that
`commit → push` already covers explicitly. Dispatch stays honest about being a *fresh start on
another machine* rather than a *continuation of this one*.

The load-bearing consequence is that **a dispatched session never depends on the target's base
checkout being clean**: `createWorktree` fetches `origin/<default>` and branches off the remote
ref, which doesn't read the working tree at all. So you can switch to a host, make a mess in place,
switch home, dispatch a session there, and still get a clean worktree. That invariant is why no
auto-pull is needed, and why nothing on a host you can't see can quietly break a dispatch.

## Consequences

- A project with **no git remote** cannot be dispatched. Such projects are reachable only by
  opening the folder on that host, or by switching to it. Guard this in `retargetSessionHost` as
  well as the picker — it currently keeps the *local* working directory when no path resolves,
  starting the session in a path that doesn't exist on the target.
- Choosing the host you are already working on is not a dispatch, so it honours the per-session
  worktree toggle. Moving to a *different* host always forces a worktree, because a base checkout
  on a machine you aren't watching is shared state with no one there to untangle a collision.
- Dispatched work returns the same way local work does: commit → push → PR. There is no separate
  return path, which is what makes push credentials load-bearing on every dispatch target
  (see ADR-0001).
