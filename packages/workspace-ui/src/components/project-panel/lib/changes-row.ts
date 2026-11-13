import type { BranchChanges, GitState } from "@solus/contracts/types";

export interface ChangesRow {
  label: string;
  /** Line counts beside the label; absent until the host has counted them. */
  lines?: BranchChanges;
  /** Shown only while the line counts are absent; the tooltip names it too. */
  fileCount: number;
  tooltip?: string;
}

/** Use one comparison for the checkout, before and after a commit. Feature
 *  branches include committed and uncommitted work against their target's
 *  merge base; the target branch counts only uncommitted work against HEAD. */
export function changesRow(status: GitState | null | undefined): ChangesRow {
  if (!status) return { label: "Changes", fileCount: 0 };
  const onBranch = !!status.branch && status.branch !== status.targetBranch;
  if (onBranch) {
    const lines = status.branchChanges;
    return {
      label: `Changes vs ${status.targetBranch}`,
      lines,
      fileCount: lines?.fileCount ?? 0,
      tooltip: `Changes since this branch left ${status.targetBranch}, including uncommitted work`,
    };
  }
  // The summary updates first. Do not show old line counts after a commit.
  const fileCount = status.uncommittedChanges.fileCount;
  if (!fileCount) return { label: "Changes", fileCount: 0, tooltip: "No changes" };
  return {
    label: "Changes",
    lines: status.uncommittedTotals ?? status.branchChanges,
    fileCount,
    tooltip: `${filesText(fileCount)} not committed yet`,
  };
}

export function filesText(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}
