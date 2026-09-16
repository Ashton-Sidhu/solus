# Task pull request menu

When a task has several pull requests, its context menu lists each PR by number
and title. Selecting the number or title opens that PR in Solus. The separate
actions control keeps review, browser, copy, and unlink commands available.
Keyboard and touch selection use the same commands as mouse selection.

The title uses the current PR record when available, then the saved task link.
The menu shows the PR number once. A link that has only a number uses “Pull
request” as its label until a title is available.

This menu is shared by desktop, web, and mobile clients. PR navigation continues
through the shared workspace command and host GitHub provider, which includes
the `gh auth` credential fallback. A menu selection does not need a separate
authentication path.
