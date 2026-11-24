import { useMemo } from "react";

import type { CodebaseMember } from "@solus/contracts/codebases";
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
   * The repositories of the codebase that a new worktree thread can take. Null while the host
   * reads its disk, and when the folder of the project is not a member of the codebase.
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
 * The repositories that a new worktree thread of this project can take: the `git` members of the
 * thread's codebase on the host of the project (docs/plans/codebases.md §7). A thread with no
 * codebase asks the host nothing. `foundMembers` are the members of the codebase that the host
 * makes at the first prompt (decision 13): the draft has no codebase yet, and they are its list.
 */
export function useWorktreeRepositoryChoices(
  project: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly codebaseId: string | null;
    readonly foundMembers?: ReadonlyArray<CodebaseMember> | null;
  } | null,
): WorktreeRepositoryChoices {
  const codebaseId = project?.codebaseId ?? null;
  const members = useEnvironmentQuery(
    project !== null && codebaseId !== null
      ? codebaseFolders.members({ environmentId: project.environmentId, input: { codebaseId } })
      : null,
  );
  const workspaceRoot = project?.workspaceRoot ?? null;
  const foundMembers = project?.foundMembers ?? null;
  const read = codebaseId === null ? foundMembers : members.data;
  return useMemo(() => {
    if (workspaceRoot === null || (codebaseId === null && foundMembers === null)) return NO_CODEBASE;
    // Not read yet: the host decides, so a worktree send still gets the host's own default.
    if (read === null) return { choices: null, repositories: null, tracksGitRepositories: true };
    const repositories = worktreeRepositoryOptions(read, workspaceRoot);
    // The folder of the project is not a member: the host makes one worktree, in its repository.
    if (repositories === null) return NO_CODEBASE;
    return {
      choices: repositories.options,
      repositories,
      tracksGitRepositories: repositories.options.some(
        (option) => option.unavailable === undefined,
      ),
    };
  }, [codebaseId, foundMembers, read, workspaceRoot]);
}
