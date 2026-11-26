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
selected host. The host reads worktrees from each project and from each
repository of a codebase on that host, and task folders from its own record of
them. A task folder is one row.

- **Groups and filters.** Rows are grouped by project, or by codebase for a
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

  Each row has the same two actions: **Open session** and **Delete**.
- **Size.** Each row shows its size on disk, and each group and filter its
  total. The toolbar also shows the free space on the disk that holds the
  Solus data folder (`HostResources.disk`, which the host page shows too). A
  removal answers with a fresh read of it, so the gain shows at once. Sizes arrive after the list, because each one walks a whole checkout. A
  skeleton shows while the host reads the list.

**Delete** removes the folder and deletes the branch (`git branch -D`), in each
repository for a task folder. It asks first. The question says what is lost
and how much space it frees. When work is lost, the button says
**Delete and lose work**.

- A worktree where a turn runs cannot be deleted.
- If unsaved work appears after the list loads, the host does not delete it.
  The row shows the new state, and you confirm again.
- The default branch of a project stays, also when the worktree has it.

The host serves the list over `managedWorktreesList`, `managedWorktreeRemove`,
and `managedWorktreeSizes` (`packages/server/src/git/managed-worktrees.ts`).
Desktop and web show the section. The mobile app does not show it yet.
