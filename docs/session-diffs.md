# Session diffs and snapshots

Solus reads changes from the checkout configured for the session. The environment
panel shows that checkout. A shell command that enters another directory does not
change the session's checkout or diff target. Assign the worktree to the session
before asking the agent to work there.

Solus snapshots the whole checkout at the start and at the end of each turn. The
turn's diff is the difference between those two snapshots. This includes shell
edits, additions, deletions, and changes that the provider did not report.
Untracked files excluded by Git ignore rules are not included.

In a linked worktree the session owns the checkout. The live session diff is the
whole checkout compared with the session base.

In the main checkout, the user and other sessions edit the same files. There the
live session diff shows only the files that changed during this session's turns,
including the turn that runs now. It compares each of those files in the checkout
with the session base. A file that only other authors changed, between this
session's turns, does not show. The session's changed-files list uses the same
rule. Two limits remain: an edit by another author during one of this session's
turns shows, and so does another author's edit to a file this session also
changed. To keep a session's diff to its own work exactly, assign it a worktree.

Snapshots use a temporary Git index. They do not change staged files or advance
the checked-out branch. The same server behavior applies to Claude and Codex and
to desktop, web, and mobile clients.

The Changed files menu has checkboxes for Code, Tests, Mocks, Generated, and
Docs. Select any combination. All classes are selected by default. Each row
shows the full line counts for its class, even when that class is hidden.
The choices are saved on this device and restored after closing the menu,
closing the diff, or restarting the client. Select all classes to clear the
filter. The file tree, diff stream, and diff search use the selected classes.
Map and Guide keep the full change. A file or comment jump can temporarily
show all files to reveal its target. It does not change the saved filter.
Filters do not change the files included in a commit or review submission.

Desktop and web share these controls. The native mobile pull request Files tab
has the same choices in its Changed files menu. Classification uses paths and
is the same for both agent providers and all host connection modes.
