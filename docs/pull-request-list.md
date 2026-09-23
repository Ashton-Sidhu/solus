# Pull request list

The Pull Requests page shows one list for every scope. With one project chosen, the list shows the pull requests of that project. With **All projects**, the list shows the pull requests of every project that a connected host can read. The page reads at most four projects at the same time. Each row then shows the name of its project. The repository name is in the tooltip.

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

When you change a filter, the rows on screen stay and are narrowed to the new filter until the host answers. The page shows the loading skeleton only when no row matches yet, or when you change the project.

## Folding header

When you scroll the list past the search row, the row folds into the crumb line: `Pull requests / Open ▾ / All ▾`. Each crumb is a menu for the State or the Involvement filter. The search button opens the search row again and puts the cursor in it. The refresh button stays on the crumb line. The header does not fold while the search field has focus or holds text, or while a pull request is open beside the list.

The page is the same on desktop, web, and mobile.

## Opening a pull request

Clicking a row opens the pull request in a panel beside the list. The list
narrows; it is not covered, so the queue stays readable and J / K walk it.

- The panel opens at 60% of the page. Drag its left edge (or focus the edge and
  press ← / →, Shift for bigger steps) to resize it. The width is remembered on
  this device.
- The panel keeps at least 360px, and so does the list. The panel never takes
  more than 70% of the page.
- When the page cannot hold both 360px floors (a phone, or a narrow pane), the
  panel covers the list instead. E does the same on purpose; Esc steps back.
- The list's title row and the panel's top row are the same chrome row, so
  they sit level across the split. The list header still folds on scroll.
- Rows keep their full layout beside the panel. As a row narrows it drops the
  labels first, then the author's name, then the age.

## Row colours

The state glyph, review verdict, checks mark and diff counts use full-strength
hues with their own dark-mode values (`components/prs/lib/pr-row-styles.ts`):
open emerald, merged violet, closed red, draft zinc; checks emerald / amber /
red; "Approved" emerald and "Changes requested" amber.

## Loading more

The list does not load pages on scroll. When the host has more, the end of the
list shows **Load more pull requests**; while a page loads it reads "Loading
more". At 500 rows it reads "Narrow your search to find more pull requests."
If the filters hide every loaded row while the host still has more, the empty
state offers **Load more pull requests** next to **Clear filters**.

## Search and filter row

The row stays on screen beside an open panel. Its layout follows the list's own
width, not the pane's: between 32rem and 40rem the Sort and Filters menus show
only their icons; under 32rem the search takes a line of its own and the menus
sit under it. Beside the panel, the project picker leaves the Filters menu,
because changing project would replace the list you are working from.
