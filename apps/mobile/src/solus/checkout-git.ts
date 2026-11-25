import type { GitAction } from "@solus/contracts/git-types";
import type { GitStackedAction, VcsBranchStatus } from "@t3tools/contracts";
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

export function checkoutBranch(repo: VcsBranchStatus | null | undefined) {
  if (repo == null) return { kind: "unknown" } as const;
  if (repo.isRepo === false) return { kind: "no-repository" } as const;
  return repo.refName === null
    ? ({ kind: "detached" } as const)
    : ({ kind: "branch", name: repo.refName } as const);
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
