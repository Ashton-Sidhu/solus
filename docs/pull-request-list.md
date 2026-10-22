# Pull request list

The Pull Requests page shows one list for every scope. With one project chosen, the list shows the pull requests of that project. With **All projects**, the list shows the pull requests of every project that a connected host can read. The page reads at most four projects at the same time. Each row then shows the name of its project. The repository name is in the tooltip.

A project has pull requests only when its repository has a remote on a code host. The project is the remote that names the repository: `upstream`, then `origin`, then the first remote by name. Thus the page reads a fork's pull requests from its upstream. A folder that is not a git repository, or a repository with no remote, is a local-only project. The project picker shows it, but you cannot select it, and **All projects** does not read it. The project scope is shared with the Tasks, Folio, and Automations pages, so you can choose a local-only project on one of them. When this occurs, the page names the project, tells you whether it is not a git repository or has no remote, and gives a **Show all projects** button.

## Sections

The list has three sections, in this order:

1. **Authored** — pull requests that you opened.
2. **Review requested** — pull requests that ask for your review, or that are assigned to you.
3. **Others** — all other pull requests.

A pull request that you opened is in Authored, also when it asks for your review. The list shows sections only when Involvement is **All** and the search field is empty. In all other conditions, the list is one flat group. You can collapse and expand each section.

## Sort

The default sort is **Merge readiness**:

1. Checks pass and the pull request is approved.
2. Checks pass.
3. Other open pull requests, drafts included.
4. Merged and closed pull requests.
5. Pull requests with a merge conflict.

In each tier, a smaller diff comes first. A pull request with no known diff size comes after the others. Then the most recently updated comes first. **Created** and **Updated** are also available. The sort applies in each section, and Authored stays first.

## Search

Type in the search field to narrow the list. The rows on screen are filtered immediately by title, author, number, branch, and repository. 250 ms after you stop typing, the host searches GitHub. GitHub also matches the body and the comments of a pull request, so it can find more rows. With the Merge readiness sort, search results are in order of relevance: exact number, exact title, title contains the text, all words in the title, branch, author, repository, then any word.

The search field accepts these GitHub qualifiers:

| Qualifier | Effect |
|---|---|
| `label:bug`, `label:bug,wip` | Only pull requests with that label (a comma means "or") |
| `-label:"needs design"` | No pull requests with that label |
| `author:octocat`, `author:me` | Only pull requests by that author, or by you |
| `draft:true`, `draft:false` | Only drafts, or no drafts |
| `review:approved`, `review:changes_requested`, `review:required`, `review:none` | Only pull requests with that review state |
| `status:success`, `status:failure` | Only pull requests whose checks pass, or fail |

An unknown key is read as a label with that name, for example `size:XL`. Put a term in quotes to search for it as text.

## Memory on this device

The page keeps the sort and the filters that you chose on this device, and restores them the next time it opens. Opening the page does not reset them.

After a reload, the page shows the last list that it read without a search for that scope. The live read then replaces those rows. The remembered list holds at most 99 rows, is used only for the same State filter, and is ignored after seven days.

While the page is open, the host pushes changes to the rows (docs/plans/pr-sync.md). A change on the code host to a pull request that Solus tracks (one that a session or a task links, or that a screen shows) reaches its row in about a minute, with no read by the page. A pull request that Solus opens joins the unsearched list at the top at once. When an agent turn ends in a listed repository, the page reads its first page again, so a pull request that the agent opened shows. The page does not poll, and the host does not read the repository for the page. A pull request that someone opens on GitHub shows at the next open of the page, after a turn ends in that repository, or when you push the refresh button, which asks the host to read the projects at once. On mobile, the Pull Requests tab reads the hosts again when it gets focus more than 30 seconds after its last read.

When you change a filter, the rows on screen stay and are narrowed to the new filter until the host answers. The page shows the loading skeleton only when no row matches yet, or when you change the project.

## Folding header

When you scroll the list past the search row, the row folds into the crumb line: `Pull requests / Open ▾ / All ▾`. Each crumb is a menu for the State or the Involvement filter. The search button opens the search row again and puts the cursor in it. The refresh button stays on the crumb line. The header does not fold while the search field has focus or holds text, or while a pull request is open beside the list.

The page is the same on desktop, web, and mobile.

## Opening a pull request

Clicking a row opens the pull request in a panel beside the list. The list
narrows; it is not covered, so the queue stays readable. The ↑ / ↓ keys move
through the list, and the `#number` switcher in the panel walks the same order.

- The panel opens at half the page. Drag its left edge (or focus the edge and
  press ← / →, Shift for bigger steps) to resize it. The width is remembered on
  this device.
- The panel keeps at least 360px, and so does the list. The panel never takes
  more than 70% of the page.
- When the page cannot hold both 360px floors (a phone, or a narrow pane), the
  panel covers the list instead. The expand control in the panel does the same
  on purpose; Esc steps back.
- The list's title row and the panel's top row are the same chrome row, so
  they sit level across the split. The list header still folds on scroll.
- Rows keep their full layout beside the panel. As a row narrows it drops the
  labels first, then the author's name, then the age.

## Stacked pull requests

GitHub can put pull requests in a stack. A stack is a chain of pull requests.
Each pull request is based on the head branch of the pull request below it, and
the bottom pull request is based on the stack's base branch. GitHub merges the
layers in order.

- A row in a stack shows its layer at its right end, for example `2/3`. Layer 1
  is the bottom layer. The tooltip gives the base branch of the stack. Click
  `2/3` to open a menu with all the layers, without opening the row. Select a
  layer to open it in the panel. The menu reads the stack only when it opens.
  While it reads, the menu says *Loading stack…*. If the read fails, the menu
  has **Try again**. If the pull request left its stack, the menu says so.
- The row's quick **Merge** (Shift, the context menu, and Shift+M) is off for a
  layer of a stack, because it would merge one layer alone. Open the pull
  request and use **Merge stack** in its `2/3` menu.
- In an open pull request, the top row shows the same `2/3` control. It opens a
  menu with all the layers, the top layer first, and the base branch under them.
  Select a layer to open it. In the panel beside the list, the layer opens in
  the panel, also when the list does not show it (for example, a merged layer).
  On the full pull request page, the layer opens on its own page. **Open stack
  in browser** opens the stack on GitHub.
- On a phone, the row shows `Stack 2/3`, and the pull request screen has a
  **Stack** section with all the layers. Tap a layer to open it.

The list reads the stack position in the same request that reads review state,
so the list does not make more requests. The open pull request reads the full
stack one time. When it is not known whether a pull request is in a stack,
Solus reads the stack. When the list showed that it is not in a stack, Solus
does not read it.

GitHub stacks are a preview. When a repository has no stacks, or when the stack
read fails, Solus shows no stack. The pull request itself is not affected.
Solus does not rebase a stack. Use GitHub for this action.

### Merge a stack

On desktop and web, the `2/3` menu has **Merge stack (N)** when GitHub lets
you merge the stack and you can write to the repository. It merges every open
layer from the bottom up to the open pull request, in one host operation, with
the merge method that the merge button starts on. Solus asks for confirmation
first and lists the layers. A progress message shows while the host works.
Then the message says that the layers merged, or that GitHub added them to its
merge queue. If the host refuses, the message gives its reason as the host
sends it (for example, the stack changed, a layer is a draft, or checks are
still running). After each attempt, Solus reads the stack and the pull request
again.

Solus sends the head of each layer as the stack read showed it. If one layer
moved, the host refuses the merge. When the stack read does not give a head for
a layer, the item is off: refresh the pull request.

## The pull request's action

In an open pull request, the `#number` in the top row is also the pull
request's one action. It shows the next step and has the colour of the state:

- **Merge** (for example *Squash and merge*) when the pull request is ready.
- **Update branch** when the branch is behind its base and the base branch
  requires it to be up to date. The host merges the base into the branch, or
  rebases the branch if the base branch takes only rebases.
- **Auto-merge** when only checks or reviews are pending. The host merges the
  pull request when they pass.
- **Resolve conflicts with agent** (red) or **Fix failing checks with agent**,
  which open a session.
- **Mark ready for review** for a draft.

When you cannot take a step, the number shows the state: *Merged*, *Closed*,
*Auto-merge on*, *Checks in progress*, and so on. The caret beside the number
selects the merge method, merges now instead of waiting, and turns auto-merge
on or off. The status card on Activity has the same action as a button under
its state, so you can merge from either place.

Merge methods come from the repository and from the rules of the base branch.
A branch that requires linear history, or a ruleset that names the allowed
methods, removes the methods it does not allow. The host names the default
method: your GitHub default when the base branch allows it, otherwise the first
allowed method.

## Workflows from a fork

GitHub does not run the Actions workflows of a pull request from a fork until a
maintainer approves them. On desktop and web, Activity shows these workflows
above **Checks**, each with a link to its run on GitHub. When you can approve
them, **Approve and run** starts them for the current head. If the
head moved, the host refuses and Solus reads the waiting runs again.

## Changes by kind

Under the **Changes** line of an open pull request, Solus splits the added and
deleted lines by the kind of file: Code, Tests, Mocks, Generated, and Docs. The
kind comes from the file path alone (`changedFileKind` in
`packages/client-core/src/change-breakdown.ts`), and the first match wins:

1. **Generated**: lockfiles, minified files, source maps, and files named
   `*.generated.*` or `*.gen.*` or in a `generated` folder.
2. **Mocks**: snapshots, fixtures, mocks, stubs, and fakes.
3. **Tests**: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `FooTest.java`,
   and files in a `test`, `tests`, `__tests__`, `spec`, or `e2e` folder.
4. **Docs**: Markdown, reStructuredText, AsciiDoc, and text files, except
   text files that tools read (such as `requirements.txt`).
5. **Code**: all other files.

In the list, point at a row's `+N −M` to see the same split in a tooltip.
The row reads its changed files only then, so rows that nobody points at cost
the host nothing; the files stay cached for when you open the pull request.

A kind with no changed lines does not show. When the whole change is one kind,
no split shows. In the mobile app, the split is under the file count of
**Changed files**. No split shows when the host gave only part of the files
(GitHub stops at 3000), because then the split would not add up to the total. The mobile **Hide test
files** filter uses the same rule: it hides Tests and Mocks.

## Viewed files

When the host keeps GitHub's "Viewed" marks, each file header in the pull
request diff (inline and in the diff pane) has a **Viewed** box, and the diff
toolbar shows "3 of 12 viewed". GitHub's marks are the only record, so GitHub
shows the same marks. A file that changed after you viewed it shows **Changed
since viewed**. A mark shows at once, collapses the file, and goes to GitHub
after a short pause together with other marks. If GitHub refuses, the marks go
back and the toolbar shows "Couldn't save viewed files" (hover for the reason)
until a later mark saves. Solus reads the marks each time the
pull request opens. An older host has no marks, and the diff has no box.

## Images in descriptions and comments

A private repository serves the images and videos in a pull request only to a
GitHub account. When the host can do this, Solus asks the host for a short-term
link to each GitHub image or video in the description and the comments, and the
host gets the file with its own GitHub access. The link is kept until shortly
before it expires. When the host cannot get the file, Solus shows the original
link.

## Revert

A merged pull request has **Revert changes** in its ⋯ menu when GitHub allows
it and you can write to the repository. Solus asks for confirmation, then opens
a new pull request that reverses the merge. The message that follows has
**Open** to show the new pull request.

## Row actions

A row can merge, close, reopen, or mark a draft ready for review without
opening the pull request. A row shows only the actions that its state and your
permissions allow: an open pull request offers **Merge** and **Close**, a draft
offers **Ready** and **Close**, a closed one offers **Reopen**, and a merged one
offers nothing.

- **Shift** — while you hold Shift on the page, every row shows its actions as
  compact buttons. Shift in a text field does not show them. They go away when
  you release Shift or the window loses focus.
- **Keyboard** — on the highlighted row, press Shift+M (merge), Shift+C
  (close), Shift+O (reopen), or Shift+R (ready). The row buttons are not in the
  Tab order, because they exist only while Shift is held.
- **Context menu** — right-click a row, or press and hold it on a touch
  screen. The menu has the same actions, so a phone gets them without Shift.

Merge always asks for confirmation first, and merges with the default method
that the host names. Every action changes the row at once. If the host refuses, the
row goes back to its earlier state and an error message tells you why.

## How the host reads the list

The host reads the list with GitHub search, not one request for each project.
For each host and GitHub account, one GraphQL search finds the pull requests of
up to 100 projects: `is:pr is:open repo:a repo:b … sort:updated-desc`, then the
State filter and the search text. The host splits the rows by project. The
same document holds three more searches across the same projects: your pull
requests (`author:`), and the pull requests that ask for your review
(`review-requested:`) or are assigned to you (`assignee:`). These fill the
Authored and Review requested sections. A page holds up to 100 rows across the
projects. The next page is the same search with `updated:<=` the last row of
the page before it, so projects at the same place share one search.

| Read | GraphQL requests | REST requests |
|---|---|---|
| Page one of N projects, with sections | one for each 100 projects | 0 |
| The next page of several projects | 1 | 0 |
| A search across N projects | one for each 100 projects | 0 |

Each row carries the combined state of the checks on its head commit
(`checksState`), so the list asks for no checks. Optional checks count, as on
GitHub's own list. PR sync pushes new checks to the row. Each row carries the
merge methods that the repository allows. The detail read narrows them by the
rules of the base branch, so the list reads no branch rules.

Search can miss a project. GitHub knows a renamed repository only by its new
name: the host reads the new name beside the search, searches again with it,
and keeps it. The search index can also be late with a new pull request. When
the search found every match but fewer rows than the repository has, the host
reads that project's own listing (`repository.pullRequests`) in one more
request. A project that the account cannot see is read alone with the next
credential.

## Row colours

The state glyph, review verdict, checks mark and diff counts use full-strength
hues with their own dark-mode values (`components/prs/lib/pr-row-styles.ts`):
open emerald, merged violet, closed red, draft zinc; checks emerald / amber /
red; "Approved" emerald and "Changes requested" amber.

## Loading more

The list does not load pages on scroll. When the host has more, the end of the
list shows **Load more pull requests**; while a page loads it reads "Loading
more". Each project continues from a cursor that its last page gave. With
**All projects**, one read for each host gets the next page of every project
that has more. At 500 rows it reads "Narrow your search to find more pull requests."
If the filters hide every loaded row while the host still has more, the empty
state offers **Load more pull requests** next to **Clear filters**.

## Search and filter row

The row stays on screen beside an open panel. Its layout follows the list's own
width, not the pane's: between 32rem and 40rem the Sort and Filters menus show
only their icons; under 32rem the search takes a line of its own and the menus
sit under it. Beside the panel, the project picker leaves the Filters menu,
because changing project would replace the list you are working from.

## In the mobile app

The iOS and Android app shows pull requests in the **Pull Requests** tab beside
**Chats**. The tab lists the pull requests of every connected host in one list.
Filter pills above the list choose the host, the project, the involvement, the
labels, the author, drafts, the review state, the checks, and the sort. The app
keeps these filters on the device. A saved host or project stays selected while
that host is offline.

A pull request opens with the tabs **Overview**, **Activity**, **Commits**,
**Files**, and **Guide**. From Overview you can comment, review, merge (or turn
on auto-merge), update the branch, close or reopen, mark ready or draft, change
reviewers and labels, and start agent work on the pull request. In Files, tap a
line, or long-press and then tap a second line, to write an inline comment. The
comments stay on the device as a review draft until you submit the review.

The app keeps a copy of each pull request that you read: the list, the detail,
the diff, and the guide. Offline, it shows that copy with a "Not refreshed"
notice, and the controls that change the pull request are off until the host is
connected again. The copy is kept for 30 days, and for at most 256 records and
32 MiB for each host.
