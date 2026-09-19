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

The sidebar chip shows “N PRs” with a caret when there is more than one choice.
The dropdown and context menu share a two-line label: current title, then number
and known state. An unloaded PR has no state label. Both menus use
`text-workspace-chrome`, a smaller laptop width, viewport bounds, and scrolling.

The shared PR store owns linked identity, loading, refresh and status selection.
The task page, sidebar and preview use `linkedPr` to read a link and
`watchLinkedPrs` to register interest. Components do not choose repositories or
combine saved observations with live records. Reads use the repository and PR
number in the URL; number-only legacy links use their saved scope, then the task
project, with filesystem scopes resolved on the host. Repository reads do not
inherit the active session's checkout or branch.

The store shares a list request per repository and reads linked PRs missing
from that page individually. Subscriptions stop when their surface releases
them. Saved observations and live responses use the newest known status, which
remains visible during refresh failures. A link with no known status remains
visible with a neutral chip; it does not count as open or as merged. A combined
chip only shows merged when all its PRs are known merged.

Selecting a PR uses the same route and current workspace context as a GitHub PR
link in an assistant message. The URL supplies the repository and PR number.
The host checks access before a pane opens; a failed check opens the original URL
in the browser. A choice with no URL still opens by number, without that check or
a browser fallback. The shared command chooses the default tab.
“Review changes” explicitly selects the diff tab. Command-click on an individual
PR opens its URL in the browser; the multi-PR trigger always opens the chooser.
Keyboard activation of the chip does not activate the containing task row.
