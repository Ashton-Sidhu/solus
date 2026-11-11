import type { BranchChanges, GitState } from "@solus/contracts/types";

export interface ChangesRow {
  label: string;
  /** Line counts beside the label; absent until the host has counted them. */
  lines?: BranchChanges;
  /** Shown only while the line counts are absent; the tooltip names it too. */
  fileCount: number;
  tooltip?: string;
}

/** What the Changes row reports. Uncommitted work comes first, because that
 *  is what a commit takes and so what a commit clears. When the tree is clean,
 *  the row reports what the branch still carries over its target, and names
 *  the target, so a count after a commit reads as expected. */
export function changesRow(status: GitState | null | undefined): ChangesRow {
  if (!status) return { label: "Changes", fileCount: 0 };
  // The file count is from the summary scan, which updates first. The line
  // counts are details and can lag a commit, so they show only while the
  // summary still has uncommitted files.
  const uncommittedFileCount = status.uncommittedChanges.fileCount;
  const onBranch = !!status.branch && status.branch !== status.targetBranch;
  const branch = status.branchChanges;
  if (uncommittedFileCount > 0) {
    // A host from before `uncommittedTotals` sends only the branch count,
    // which on the target branch is the same count.
    const lines = status.uncommittedTotals ?? (onBranch ? undefined : branch);
    return {
      label: "Changes",
      lines,
      fileCount: uncommittedFileCount,
      tooltip:
        onBranch && branch
          ? `${filesText(uncommittedFileCount)} not committed yet · ${filesText(branch.fileCount)} changed since this branch left ${status.targetBranch}`
          : `${filesText(uncommittedFileCount)} not committed yet`,
    };
  }
  if (onBranch && branch?.fileCount) {
    return {
      label: `Changes vs ${status.targetBranch}`,
      lines: branch,
      fileCount: branch.fileCount,
      tooltip: `Committed on this branch since it left ${status.targetBranch}`,
    };
  }
  return { label: "Changes", fileCount: 0, tooltip: "No changes" };
}

export function filesText(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}
