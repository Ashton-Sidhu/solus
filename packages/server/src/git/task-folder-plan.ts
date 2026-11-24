import path from 'node:path'
import { CODEBASE_WORKTREE_DEFAULT_MAX, type CodebaseMember } from '@solus/contracts/codebases'
import { hostPathKey, isWindowsHostPath, sameHostPath } from '@solus/contracts/host-path'

/**
 * The plan of a task folder (docs/plans/codebases.md §7): which repositories
 * get a worktree, and the folder that the task folder stands in for. It reads
 * no disk: the members are the answer of `membersOf` or `scanFolder`.
 */

export interface TaskFolderPlanInput {
  /** The codebase of the session, or null for a session with no codebase. */
  codebaseId: string | null
  /** The member that the session works in. It must be in `members`. */
  workingMember: string
  /** The members of the session on this host (its project and its codebase), the working member with them. */
  members: readonly CodebaseMember[]
  /** The repositories that a person chose, as member paths. Null is the default set. */
  repositories: readonly string[] | null
}

export interface TaskFolderPlanRepository {
  path: string
  name: string
}

export interface TaskFolderPlan {
  codebaseId: string | null
  /** The deepest folder that holds the working member and each chosen repository. */
  anchor: string
  workingMember: string
  /** False for a plain folder: the task folder then holds links to its entries. */
  workingMemberIsRepository: boolean
  /** The repositories that get a worktree besides the working member. A repository is before each one nested in it. */
  repositories: TaskFolderPlanRepository[]
  /** The other member repositories. Their places get no link, and a layout command can make their worktrees. */
  otherRepositories: string[]
}

type PathRules = typeof path.posix

/** The path rules of the host that `sample` is from. A Windows path never names a folder of a POSIX host. */
function pathRulesOf(sample: string): PathRules {
  return isWindowsHostPath(sample) ? path.win32 : path
}

function holds(rules: PathRules, folder: string, target: string): boolean {
  const fromFolder = rules.relative(folder, target)
  return fromFolder === '' || (fromFolder !== '..' && !fromFolder.startsWith(`..${rules.sep}`) && !rules.isAbsolute(fromFolder))
}

/** The deepest folder that holds each path. Null when there is none: two Windows drives. */
function commonAncestorOf(paths: readonly string[]): string | null {
  const rules = pathRulesOf(paths[0])
  let ancestor = rules.resolve(paths[0])
  for (const each of paths.slice(1)) {
    while (!holds(rules, ancestor, each)) {
      const parent = rules.dirname(ancestor)
      if (parent === ancestor) return null
      ancestor = parent
    }
  }
  return ancestor
}

/**
 * The plan of the task folder of a new worktree session, or null when the
 * session does not need one: its working member is a repository and no other
 * repository is chosen. That session keeps the worktree inside its repository.
 *
 * Without a choice, each repository gets a worktree when there are at most
 * `CODEBASE_WORKTREE_DEFAULT_MAX` of them, the working member counted; above
 * that, none. Never chosen: a submodule (it comes with the worktree of its
 * parent), a repository with no commit, and the working member itself.
 * A named path that is not a member, that is not a repository, or that shares
 * no folder with the working member is refused.
 */
export function planTaskFolder(input: TaskFolderPlanInput): TaskFolderPlan | null {
  const working = input.members.find((member) => sameHostPath(member.path, input.workingMember))
  if (!working || working.state === 'missing') throw new Error(`The working folder ${input.workingMember} is not a folder on this host.`)
  const workingMemberIsRepository = working.state === 'git'

  const isOther = (member: CodebaseMember) => !sameHostPath(member.path, working.path)
  const canHaveWorktree = (member: CodebaseMember) => member.state === 'git' && member.hasCommit && !member.submodule
  const sharesFolder = (member: CodebaseMember) => commonAncestorOf([working.path, member.path]) !== null

  let chosen: CodebaseMember[]
  if (input.repositories === null) {
    const all = input.members.filter((member) => isOther(member) && canHaveWorktree(member) && sharesFolder(member))
    chosen = all.length + (workingMemberIsRepository ? 1 : 0) <= CODEBASE_WORKTREE_DEFAULT_MAX ? all : []
  } else {
    chosen = input.repositories.map((named) => {
      const member = input.members.find((each) => sameHostPath(each.path, named))
      if (!member) throw new Error(`${named} is not a folder of this session's project or codebase.`)
      if (isOther(member) && member.state !== 'git') throw new Error(`${named} is not a Git repository, so it cannot get a worktree.`)
      if (!sharesFolder(member)) throw new Error(`${named} and ${working.path} share no folder, so one task folder cannot hold both.`)
      return member
    }).filter((member) => isOther(member) && canHaveWorktree(member))
  }
  // One repository is one worktree, whatever spelling named it.
  const byPath = new Map(chosen.map((member) => [hostPathKey(member.path), member]))
  if (byPath.size === 0 && workingMemberIsRepository) return null
  if (workingMemberIsRepository && !working.hasCommit) {
    throw new Error(`${working.path} has no commit, so it cannot get a worktree. Make a first commit, then start the session again.`)
  }

  const repositories = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, member]) => ({ path: member.path, name: member.name }))
  const anchor = commonAncestorOf([working.path, ...repositories.map((repository) => repository.path)])
  if (anchor === null) throw new Error(`The repositories of this session share no folder with ${working.path}.`)
  return {
    codebaseId: input.codebaseId,
    anchor,
    workingMember: working.path,
    workingMemberIsRepository,
    repositories,
    otherRepositories: input.members
      .filter((member) => member.state === 'git' && isOther(member) && !byPath.has(hostPathKey(member.path)))
      .map((member) => member.path),
  }
}
