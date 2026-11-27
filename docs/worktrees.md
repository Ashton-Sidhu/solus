# Solus worktrees

Solus makes two kinds of worktree for a session:

- A **worktree** of one repository, in its Git directory:
  `<project>/.git/solus/worktrees/<name>`. The folder is not part of the
  working tree, so no project needs a `.gitignore` entry for it.
- A **task folder** for a session of a codebase, in
  `<data dir>/solus-task-folders/<name>`. It has one worktree of each of its
  repositories, all on one branch (`docs/plans/codebases.md` §7).

## See and delete them

**Settings → Source control → Solus worktrees** lists both kinds on the
selected host on desktop and web. On mobile, go to **Settings → Worktrees**
to see the list for each selected host. The host reads worktrees from its
projects and codebase repositories. It reads task folders from its own
records. A task folder is one row.

- **Groups and filters on desktop and web.** Rows are grouped by project, or by codebase for a
  task folder. The **Filters** menu, the same one as on the pull request and
  task pages, has a **Project** group and a **Status** group, each with
  counts. In a group, the rows that are safe to delete come first.
- **One state for each row, in words:**
  - *No unsaved work*: safe to delete.
  - *Has uncommitted work*: a worktree has changes that are not committed.
  - *Has unmerged commits*: its branch has commits that are not in the default
    branch and not pushed. `git cherry` compares by content, so a squash or a
    cherry-pick into the default branch counts as merged.
  - *A turn is running*: a session there is mid-turn or waits for an answer.
    Delete waits until it ends. A session that is open but idle does not
    block Delete: the row says *Session open*, and the confirmation says that
    the session loses its working folder. Its conversation stays.

  On desktop and web, each row also has **Open session** and **Delete** actions.
- **Size on desktop and web.** Each row shows its size on disk, and each group and filter its
  total. The toolbar also shows the free space on the disk that holds the
  Solus data folder (`HostResources.disk`, which the host page shows too). A
  removal answers with a fresh read of it, so the gain shows at once. Sizes arrive after the list, because each one walks a whole checkout. A
  skeleton shows while the host reads the list.

**Delete** removes the folder and deletes the branch (`git branch -D`), in each
repository for a task folder. It asks first. The question says what is lost
and how much space it frees. When work is lost, the button says
**Delete and lose work**.

To delete more than one worktree, select the rows and choose **Delete** in
the selection bar. On desktop and web, the checkboxes appear when you hover
over or focus a row. Shift-click selects a range. Press Cmd+A or Ctrl+A
with focus on a worktree row to select all eligible rows in the current list.
On mobile, tap a row to show the selection bar, which has **Select all**.
The confirmation shows what each deletion removes. If the host cannot delete
a worktree, the list shows the reason and the host continues with the other
selected worktrees.

- A worktree where a turn runs cannot be deleted.
- If unsaved work appears after the list loads, the host does not delete it.
  The row shows the new state, and you confirm again.
- The default branch of a project stays, also when the worktree has it.

The host serves the list over `managedWorktreesList`, `managedWorktreeRemove`,
and `managedWorktreeSizes` (`packages/server/src/git/managed-worktrees.ts`).
