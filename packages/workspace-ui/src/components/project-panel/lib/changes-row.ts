import type { BranchChanges, GitState } from "@solus/contracts/types";

export interface ChangesRow {
  /** Line counts beside the label; absent until the host has counted them. */
  lines?: BranchChanges;
  /** Shown only while the line counts are absent; the tooltip names it too. */
  fileCount: number;
  tooltip?: string;
}

export function changesRow(status: GitState | null | undefined): ChangesRow {
  if (!status) return { fileCount: 0 };
  // Before the first commit and on detached HEAD, Changes uses the same
  // comparison as Uncommitted. A named branch may already have local commits.
  const lines = status.branchChanges;
  const fileCount = lines?.fileCount ??
    (!status.headSha || !status.branch ? status.uncommittedChanges.fileCount : 0);
  return {
    lines,
    fileCount,
    tooltip: fileCount > 0 ? filesText(fileCount) : lines ? "No changes" : undefined,
  };
}

export function filesText(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}
