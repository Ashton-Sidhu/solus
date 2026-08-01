# Solus

An agent workspace that runs coding sessions on whichever machine holds the code — the machine
you're sitting at, or one you've paired over the network.

## Language

**Host**:
A machine Solus can run sessions on, reachable because a Solus server is running there.
_Avoid_: Server (that's the process), machine, remote, box

**Solus server**:
The Solus daemon process running on a host. One per host.
_Avoid_: Instance, node

**Host readiness**:
Whether a host still needs a user choice before it can take a session — code-host credentials and
at least one provider that is installed and authenticated. Git and commit identity are probed, but
repaired at the point of use rather than presented as onboarding requirements.
_Avoid_: Setup status, health, capabilities

**Host onboarding**:
The guided authentication pass that brings a host to readiness. Offered once when the host is
claimed, always skippable, and resumable afterwards from the host's row in the host directory.
_Avoid_: Setup wizard, checklist, first-run

**Base checkout**:
A host's copy of a repository, kept only so session worktrees can be cut from it. Never edited
directly. The same repository can have a base checkout on several hosts.
_Avoid_: Clone (that's the act), working copy, project folder

**Dispatch**:
Sending a session to a host other than the one you are working on. A dispatched session always
runs in its own session worktree, so it never depends on that host's base checkout being clean.
Only possible for a project with a git remote — that remote is the only thing that travels.
Choosing the host you are already on is not a dispatch.
_Avoid_: Remote run, offload, run-on

**Session worktree**:
The git worktree a session runs in, branched off the origin default branch of a base checkout.
Modelled as `GitCheckout` in code.
_Avoid_: Checkout (ambiguous with base checkout), branch
