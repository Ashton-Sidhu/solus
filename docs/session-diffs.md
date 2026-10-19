# Session diffs and snapshots

Solus reads changes from the checkout configured for the session. The environment
panel shows that checkout. A shell command that enters another directory does not
change the session's checkout or diff target. Assign the worktree to the session
before asking the agent to work there.

Solus snapshots the whole checkout at the start and at the end of each turn. The
turn's diff is the difference between those two snapshots. The live session diff
is the whole checkout compared with the session base. This includes shell edits,
additions, deletions, and changes that the provider did not report. Untracked
files excluded by Git ignore rules are not included.

The same rule applies in a linked worktree and in the main checkout. In the main
checkout, the user and other sessions can edit the same files. Their edits show in
the turn diff and the session diff too. To keep a session's diff to its own work,
assign it a worktree.

Snapshots use a temporary Git index. They do not change staged files or advance
the checked-out branch. The same server behavior applies to Claude and Codex and
to desktop, web, and mobile clients.
