import type { GitAction, GitRepositoryStatus, GitState } from "@solus/contracts/git-types";
import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import type { SessionFolder } from "@solus/contracts/codebases";
import { sameHostPath } from "@solus/contracts/host-path";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
  type GitRepositoryTarget,
} from "../state/thread-git-target";

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

/**
 * What a Git sheet acts on (docs/plans/codebases.md §8): the session's own
 * working directory, or the repository that its route names. `folder` is the
 * session folder of that repository. A repository that is not a session
 * folder (a pin) has no `folder`: its state shows, and it gets no Git action,
 * because the host binds the session to the folder of an action that is not
 * one of its session folders.
 */
export interface CheckoutGitTarget {
  readonly cwd: string;
  readonly repository: GitRepositoryTarget | undefined;
  readonly folder: SessionFolder | undefined;
}

export function checkoutGitTarget(
  workingDirectory: string,
  folders: readonly SessionFolder[],
  params: GitRepositoryRouteParams,
): CheckoutGitTarget {
  const repository = gitRepositoryTargetFromRoute(params);
  if (repository === undefined || sameHostPath(repository.cwd, workingDirectory)) {
    return { cwd: workingDirectory, repository: undefined, folder: undefined };
  }
  return {
    cwd: repository.cwd,
    repository,
    folder: folders.find((folder) => sameHostPath(folder.path, repository.cwd)),
  };
}
