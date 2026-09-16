# Session diffs and snapshots

Solus reads changes from the checkout configured for the session. The environment
panel shows that checkout. A shell command that enters another directory does not
change the session's checkout or diff target. Assign the worktree to the session
before asking the agent to work there.

In an assigned linked worktree, the live session diff includes the full worktree
relative to the session base. At the end of each turn, the saved session snapshot
and the turn's ending snapshot use the same complete Git tree. This includes
shell edits, additions, deletions, and changes the provider did not report.
Untracked files excluded by Git ignore rules are not included.

In the main checkout, session snapshots filter changes to paths reported for that
session. This limits inclusion of edits from the user or other sessions, but can
omit shell changes to paths the provider never reported. The working-tree diff
shows the checkout's changes regardless of which session made them.

Snapshots use a temporary Git index. They do not change staged files or advance
the checked-out branch. The same server behavior applies to Claude and Codex and
to desktop, web, and mobile clients.
