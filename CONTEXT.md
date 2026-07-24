# Solus

Solus is a desktop workspace for driving coding agents — sessions, PR review, and landing agent-authored changes. This glossary covers the language of its domain, starting with the merge lifecycle.

## Language

### Merge lifecycle

**Merge queue**:
The machine that lands pull requests: it sequences them, gates each on required checks, and drives merges to completion. Each project has its own, with at most one run active at a time; projects' queues are independent of each other.
_Avoid_: merge list, batch merger

**Run**:
A single opening of the merge queue over a set of pull requests that is sealed at start. There is exactly one kind of run; runs are deliberate, not standing background policy, and nothing joins a run after it starts. A run does not outlive the app — quitting abandons it, leaving worktrees clean.

**Fail-stop**:
The merge queue's guarantee that a failed entry halts everything behind it. The queue never routes around a failure on its own; it waits for the user's decision.

**Failure prompt**:
The decision point raised app-wide when an entry fails — required checks failed, the host refused the merge, or the resolver gave up — offering exactly three verbs: agent fix, skip, or stop the run.
_Avoid_: error toast (it demands a decision, not just attention)

**Resolver**:
The agent the queue spawns automatically, without prompting, in an entry's worktree when a merge or restack hits conflicts. Conflicts are routine mechanics, not failures; only a resolver that gives up escalates to the failure prompt.
_Avoid_: fixer, conflict agent

**Staged**:
The pull requests a user has selected for the next run. Staging during an active run builds the following run; it never feeds the live one.
_Avoid_: queued (ambiguous with entries inside a run)

**Run board**:
The expanded view of an active run on the PRs page: one row per entry showing its live stage, its resolver, and — when paused — the failure prompt's verbs. The queue's first-class surface.
_Avoid_: dock (the dock is the collapsed form)

**Run chip**:
The compact app-wide indicator of a project's active run, showing progress and the current entry's state, and linking back to the run board.

**Auto-merge**:
The merge queue's autonomous mechanics — restacking, conflict resolution, waiting out CI — that land a run without user intervention. A quality of every run, not a separate run kind, intake mode, or standing policy.
_Avoid_: auto-land, merge policy, "auto run"
