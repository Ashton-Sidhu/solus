import { useMemo } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import { codebaseFolders } from "../solus/codebase-folders";
import {
  worktreeRepositoryOptions,
  type WorktreeRepositoryOption,
  type WorktreeRepositoryOptions,
} from "../solus/session-repositories";
import { useEnvironmentQuery } from "./query";

interface WorktreeRepositoryChoices {
  /**
   * The repositories that a new worktree thread can take. Null while the host reads its disk,
   * and when the folder of the project is not a member.
   */
  readonly choices: ReadonlyArray<WorktreeRepositoryOption> | null;
  /** The choices with what the default rule needs. Null as `choices` is. */
  readonly repositories: WorktreeRepositoryOptions | null;
  /** Whether a worktree thread has a repository to work in besides the project folder. */
  readonly tracksGitRepositories: boolean;
}

const NO_CODEBASE: WorktreeRepositoryChoices = Object.freeze({
  choices: Object.freeze([]),
  repositories: null,
  tracksGitRepositories: false,
});

/**
 * The repositories that a new worktree thread of this project can take (docs/plans/codebases.md
 * §7): the `git` members of the thread's codebase on the host of the project. A thread with no
 * codebase is in one project: it has one checkout, and no repositories to choose.
 */
export function useWorktreeRepositoryChoices(
  project: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly codebaseId: string | null;
  } | null,
): WorktreeRepositoryChoices {
  const codebaseId = project?.codebaseId ?? null;
  const members = useEnvironmentQuery(
    project !== null && codebaseId !== null
      ? codebaseFolders.members({ environmentId: project.environmentId, input: { codebaseId } })
      : null,
  );
  const workspaceRoot = project?.workspaceRoot ?? null;
  const ofCodebase = members.data;
  return useMemo(() => {
    if (workspaceRoot === null || codebaseId === null) return NO_CODEBASE;
    // Not read yet: the host decides, so a worktree send still gets the host's own default.
    if (ofCodebase === null) return { choices: null, repositories: null, tracksGitRepositories: true };
    const repositories = worktreeRepositoryOptions(ofCodebase, workspaceRoot);
    // The folder of the project is not a member: the host makes one worktree, in its repository.
    if (repositories === null) return NO_CODEBASE;
    return {
      choices: repositories.options,
      repositories,
      tracksGitRepositories: repositories.options.some(
        (option) => option.unavailable === undefined,
      ),
    };
  }, [codebaseId, ofCodebase, workspaceRoot]);
}
