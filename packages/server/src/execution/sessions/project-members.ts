import { homedir } from 'node:os'
import { parse } from 'node:path'
import { isChat } from '@solus/contracts/chat'
import type { Codebase, CodebaseMember } from '@solus/contracts/codebases'
import { hostPathKey, sameHostPath } from '@solus/contracts/host-path'
import type { Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { membersOf, membersOfProject } from '../../files/codebase-members'
import { resolveHomePath } from '../../platform/paths'
import { isOutsideProjects } from '../../project-config/projects-manifest'
import { realPathOf } from './attach-target'

/**
 * The folders that a session covers on this host (docs/plans/codebases.md
 * decisions 13 and 14). A project covers the repositories inside it with no
 * codebase: the host finds them on the disk at each read, as it finds the
 * members of a root. A codebase adds the members of its roots.
 */

/** A guest reads no codebase and stays in the checkout of the shared session, and a chat has no project folder: no rule applies. */
export function hasNoRule(projectFolder: string, actor: Actor): boolean {
  return actor.principal.kind === 'guest' || isChat(projectFolder)
}

/**
 * True when the folder is not the project of one piece of work: the root of
 * the file system, the home directory, and the projects root of the host or
 * of a member hold much more. Such a folder covers no repository, and no
 * codebase is made for it.
 */
export async function holdsTooMuch(projectFolder: string): Promise<boolean> {
  const realFolder = await realPathOf(projectFolder)
  if (isOutsideProjects(projectFolder) || parse(realFolder).root === realFolder) return true
  for (const home of new Set([resolveHomePath('~'), homedir()])) {
    if (await realPathOf(home) === realFolder) return true
  }
  return false
}

export interface SessionMembers {
  /** The project folder, then the repositories that the host found inside it. Empty when the project covers none. */
  project: CodebaseMember[]
  /** The members of the codebase of the session that are not in `project`. */
  codebase: CodebaseMember[]
}

/**
 * The members of a session on this host: those of its project folder, then
 * those of its codebase. `projectFolder` is null when the place of the
 * session is not known. A project folder that is a root of the codebase is
 * read one time.
 */
export async function sessionMembers(projectFolder: string | null, codebase: Codebase | null, actor: Actor): Promise<SessionMembers> {
  const ofCodebase = codebase ? await membersOf(codebase, getInstallationId()) : []
  if (!projectFolder || hasNoRule(projectFolder, actor) || await holdsTooMuch(projectFolder)) return { project: [], codebase: ofCodebase }
  const isRoot = ofCodebase.some((member) => !member.discovered && sameHostPath(member.path, projectFolder))
  const project = isRoot
    ? ofCodebase.filter((member) => sameHostPath(member.rootPath, projectFolder))
    : await membersOfProject(projectFolder).catch(() => [])
  const inProject = new Set(project.map((member) => hostPathKey(member.path)))
  return { project, codebase: ofCodebase.filter((member) => !inProject.has(hostPathKey(member.path))) }
}
