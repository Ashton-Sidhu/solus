import { CODEBASE_WORKTREE_DEFAULT_MAX, type CodebaseMember } from '@solus/contracts/codebases'
import { hostPathKey, isWindowsHostPath, sameHostPath } from '@solus/contracts/host-path'

/**
 * The repositories of a run that get a worktree when it starts a new worktree
 * (docs/plans/codebases.md §7, "Which repositories"): those that its host
 * found in its project folder, and those of its codebase. The host makes the
 * plan (`planTaskFolder`). This is the same rule on the client, so the start
 * control shows what the host will do before Send.
 */

/**
 * True when a new worktree of the folder `workingPath`, which has no
 * repository of its own, is a task folder: the run has a codebase, or the
 * folder holds a repository. A folder with no repository and no codebase gets
 * no worktree.
 */
export function plainFolderGetsTaskFolder(members: readonly CodebaseMember[], workingPath: string, hasCodebase: boolean): boolean {
  const working = members.find((member) => sameHostPath(member.path, workingPath))
  return working?.state === 'plain' && (hasCodebase || members.some((member) => member.state === 'git'))
}

/** The text of the start control for a working folder that is not a repository. */
export const PLAIN_MEMBER_LINKS_NOTE =
  'This folder is not a repository, so it has no worktree. Its files are links to the originals: an edit of a linked file changes the original for every session.'

/** Why a repository cannot get a worktree: a short mark for the row, and the full sentence. */
export interface WorktreeRefusal {
  mark: string
  reason: string
}

const SUBMODULE: WorktreeRefusal = { mark: 'Submodule', reason: 'A submodule follows its parent repository, so it gets no worktree of its own.' }
const NO_COMMIT: WorktreeRefusal = { mark: 'No commit', reason: 'This repository has no commit, so it cannot get a worktree.' }
const OTHER_DRIVE: WorktreeRefusal = { mark: 'Other drive', reason: 'This repository is on a different drive from the working folder, so one task folder cannot hold both.' }

export interface WorktreeRepositoryRow {
  path: string
  name: string
  /** The repository gets a worktree at the start of the run. */
  isChosen: boolean
  /** Why the repository cannot get a worktree, or null when it can. */
  refusal: WorktreeRefusal | null
}

export interface WorktreeRepositoryChoice {
  /** The folder the run works in. It is not in `rows`: the run always starts there. */
  working: { path: string; name: string; isRepository: boolean }
  /** The other repositories of the run on its host, by name. */
  rows: WorktreeRepositoryRow[]
  /** The person made no choice: the host uses the default set. */
  isDefault: boolean
  /** Said when the default leaves each repository out because there are too many. */
  note: string | null
}

/** A Windows drive, or the empty text for a path with none. Two different drives share no folder. */
function driveOf(path: string): string {
  return isWindowsHostPath(path) ? hostPathKey(path).slice(0, 2) : ''
}

function refusalOf(member: CodebaseMember, workingPath: string): WorktreeRefusal | null {
  if (member.submodule) return SUBMODULE
  if (!member.hasCommit) return NO_COMMIT
  if (driveOf(member.path) !== driveOf(workingPath)) return OTHER_DRIVE
  return null
}

/**
 * The choice for a run in `workingPath` with the members that its host read.
 * `chosen` is `worktreeRepositories(run)`: member paths, or null for the
 * default set. Null when `workingPath` is not a member on this host: such a
 * run gets one worktree inside its repository.
 */
export function worktreeRepositoryChoice(
  members: readonly CodebaseMember[],
  workingPath: string,
  chosen: readonly string[] | null,
): WorktreeRepositoryChoice | null {
  const working = members.find((member) => member.state !== 'missing' && sameHostPath(member.path, workingPath))
  if (!working) return null
  const isRepository = working.state === 'git'
  const others = members
    .filter((member) => member.state === 'git' && !sameHostPath(member.path, working.path))
    .map((member) => ({ member, refusal: refusalOf(member, working.path) }))
    .sort((a, b) => a.member.name.localeCompare(b.member.name) || a.member.path.localeCompare(b.member.path))
  const candidates = others.filter((each) => !each.refusal)
  const fitsDefault = candidates.length + (isRepository ? 1 : 0) <= CODEBASE_WORKTREE_DEFAULT_MAX
  const chosenKeys = chosen ? new Set(chosen.map(hostPathKey)) : null
  return {
    working: { path: working.path, name: working.name, isRepository },
    rows: others.map(({ member, refusal }) => ({
      path: member.path,
      name: member.name,
      isChosen: !refusal && (chosenKeys ? chosenKeys.has(hostPathKey(member.path)) : fitsDefault),
      refusal,
    })),
    isDefault: chosen === null,
    note: chosen === null && !fitsDefault
      ? `This work has more than ${CODEBASE_WORKTREE_DEFAULT_MAX} repositories, so none gets a worktree unless you choose it.`
      : null,
  }
}

/**
 * The paths for `chooseWorktreeRepositories` after the person changes one row.
 * The answer is always a list: a change is a choice, and it stays when the
 * codebase gets a new repository.
 */
export function withWorktreeRepository(choice: WorktreeRepositoryChoice, path: string, isChosen: boolean): string[] {
  return choice.rows
    .filter((row) => !row.refusal && (sameHostPath(row.path, path) ? isChosen : row.isChosen))
    .map((row) => row.path)
}
