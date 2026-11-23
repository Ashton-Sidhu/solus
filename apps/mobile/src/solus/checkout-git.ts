import type { GitAction, GitRepositoryStatus, GitState } from "@solus/contracts/git-types";
import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";

export const checkoutActions: { [K in GitStackedAction]: GitAction } = {
  commit: "commit",
  push: "push",
  commit_push: "commit_push",
  create_pr: "create_pull_request",
  commit_push_pr: "commit_push_pull_request",
};

export function checkoutStatus(repo: GitRepositoryStatus, state: GitState | null): VcsStatusResult {
  const branch = state?.branch ?? repo.branch;
  const pr = state?.prUrl?.match(/\/(?:pull|merge_requests)\/(\d+)\/?$/);
  return {
    isRepo: repo.isRepository,
    refName: branch,
    hasPrimaryRemote: !!repo.primaryRemoteName,
    isDefaultRef: !!branch && branch === state?.targetBranch,
    hasWorkingTreeChanges: !!state?.uncommittedChanges.fileCount,
    workingTree: {
      files:
        state?.uncommittedChanges.files.map((file) => ({
          path: file.path,
          insertions: 0,
          deletions: 0,
        })) ?? [],
      insertions: state?.uncommittedTotals?.insertions ?? 0,
      deletions: state?.uncommittedTotals?.deletions ?? 0,
    },
    hasUpstream: !!state?.upstreamRef,
    aheadCount: state?.aheadCount ?? 0,
    behindCount: state?.behindCount ?? 0,
    aheadOfDefaultCount: state?.targetAheadCount,
    pr:
      pr && state?.prUrl
        ? {
            number: Number(pr[1]),
            url: state.prUrl,
            title: state.prUrl,
            baseRef: state.targetBranch,
            headRef: branch ?? "",
            state: "open",
          }
        : null,
  };
}
