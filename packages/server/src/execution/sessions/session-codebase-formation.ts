import { homedir } from 'node:os'
import { basename, parse, resolve } from 'node:path'
import type { ActivityKind } from '@solus/contracts/activity'
import { isChat } from '@solus/contracts/chat'
import type { Codebase, SessionAttachedFolder } from '@solus/contracts/codebases'
import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { codebasesOfFolder, listCodebases, saveCodebase } from '../../data/codebases/codebases'
import { repositoriesInside } from '../../files/codebase-members'
import { findTaskFolderContaining } from '../../git/task-folder-store'
import { hostUserKey } from '../../host/host-user'
import { runOneAtATime } from '../../lib/concurrency'
import { createLogger } from '../../logger'
import { isInsideRoot } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import { isOutsideProjects, listProjects } from '../../project-config/projects-manifest'
import { realPathOf } from './attach-target'

const log = createLogger('SessionRuntime', 'session-codebase-formation.ts')

/**
 * A codebase forms by itself (docs/plans/codebases.md decision 13). A person
 * does not make a codebase before the work: the host gives a session that has
 * none the codebase of its project folder, and makes one when the disk shows
 * that the work covers more than one folder.
 *
 * - Rule 1: exactly one live codebase holds the project folder. The session
 *   takes it. More than one: the session takes none, and nothing is formed.
 * - Rule 2: no codebase holds the project folder, and it has a repository
 *   inside it. A codebase with one root, the project folder, is made.
 * - Rule 4: a folder is attached to a session with no codebase. A codebase
 *   with two roots, the project folder and the attached folder, is made.
 *
 * `SessionFolders` calls the rules. It decides which session has no codebase.
 */

/** The codebase that a rule gave a session. `formed` is true only when this call made the record. */
export interface SessionCodebase {
  codebase: Codebase
  formed: boolean
}

/**
 * The record of a formation in the conversation of the session: the divider
 * that each client shows at the point where the codebase formed. It keeps the
 * names of the roots at that time, the project folder first, so the line
 * reads the same after a person changes or deletes the codebase.
 */
export function formationActivity(codebase: Codebase): Extract<ActivityKind, { kind: 'codebase_formed' }> {
  return {
    kind: 'codebase_formed',
    codebaseId: codebase.id,
    name: codebase.name,
    folders: codebase.roots.map((root) => root.name || hostPathBaseName(root.path) || root.path),
  }
}

/** Where a session works, as the rules read it. */
export interface FormationPlace {
  workingDirectory: string
  /** The repository that the working directory is a checkout of, or is in. */
  repositoryRoot?: string | null
}

/**
 * The project folder of a session: the member that it works in. That is the
 * root of the repository of its working directory, else the working directory
 * itself. For a session in a worktree it is the original folder, never the
 * worktree: a task folder names the member that its working folder stands in for.
 */
export function projectFolderOf(place: FormationPlace): string {
  if (place.repositoryRoot) return resolve(resolveHomePath(place.repositoryRoot))
  const standsInFor = findTaskFolderContaining(place.workingDirectory)
  return resolve(resolveHomePath(standsInFor ? standsInFor.primaryRepositoryPath : place.workingDirectory))
}

/** A guest reads no codebase, and a chat has no project folder: no rule applies. */
function hasNoRule(projectFolder: string, actor: Actor): boolean {
  return actor.principal.kind === 'guest' || isChat(projectFolder)
}

/**
 * True when no codebase is made for the folder: the root of the file system,
 * the home directory, and the projects root of the host or of a member hold
 * much more than one piece of work.
 */
async function holdsTooMuch(projectFolder: string, realFolder: string): Promise<boolean> {
  if (isOutsideProjects(projectFolder) || parse(realFolder).root === realFolder) return true
  for (const home of new Set([resolveHomePath('~'), homedir()])) {
    if (await realPathOf(home) === realFolder) return true
  }
  return false
}

/**
 * A person's "no" is kept: a deleted codebase keeps its roots, and a deleted
 * codebase that has the project folder as a root stops each rule that makes
 * one for that folder. The person can still make a codebase by hand.
 */
async function wasRemovedByAPerson(projectFolder: string, realFolder: string, actor: Actor): Promise<boolean> {
  const installationId = getInstallationId()
  for (const codebase of await listCodebases(recordScopeOf(actor.principal), { includeDeleted: true })) {
    if (codebase.deletedAt === null) continue
    for (const root of codebase.roots) {
      if (root.installationId !== installationId) continue
      if (sameHostPath(root.path, projectFolder) || await realPathOf(root.path) === realFolder) return true
    }
  }
  return false
}

/** The base name of the project folder. A name that a live codebase has gets a number: `shop 2`, `shop 3`. */
async function freeNameFor(projectFolder: string, actor: Actor): Promise<string> {
  const base = basename(projectFolder) || projectFolder
  const taken = new Set((await listCodebases(recordScopeOf(actor.principal))).map((codebase) => codebase.name))
  if (!taken.has(base)) return base
  for (let number = 2; ; number++) {
    if (!taken.has(`${base} ${number}`)) return `${base} ${number}`
  }
}

/** Rule 1. `none`: no live codebase holds the folder. `several`: more than one does, so the session takes none. */
async function existingCodebaseOf(projectFolder: string, actor: Actor): Promise<Codebase | 'none' | 'several'> {
  const holders = await codebasesOfFolder(recordScopeOf(actor.principal), getInstallationId(), projectFolder)
  if (holders.length === 0) return 'none'
  return holders.length === 1 ? holders[0] : 'several'
}

async function makeCodebase(sessionId: string, projectFolder: string, otherRoots: string[], actor: Actor): Promise<SessionCodebase> {
  const installationId = getInstallationId()
  const codebase = await saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), {
    id: crypto.randomUUID(),
    name: await freeNameFor(projectFolder, actor),
    roots: [projectFolder, ...otherRoots].map((path) => ({ installationId, path, name: '' })),
    updatedAt: Date.now(),
    deletedAt: null,
  })
  log.info('session_codebase_formed', { sessionId, codebaseId: codebase.id, projectFolder, rootCount: codebase.roots.length })
  return { codebase, formed: true }
}

/**
 * One formation at a time for one project folder, so two sessions that start
 * there at the same moment get one codebase: the second one reads the record
 * that the first one made. `form` runs only when no live codebase holds the
 * folder and no person removed its codebase.
 */
async function formOnce(projectFolder: string, actor: Actor, form: () => Promise<SessionCodebase | null>): Promise<SessionCodebase | null> {
  const realFolder = await realPathOf(projectFolder)
  return runOneAtATime(`codebase-formation:${realFolder}`, async () => {
    const existing = await existingCodebaseOf(projectFolder, actor)
    if (existing === 'several') return null
    if (existing !== 'none') return { codebase: existing, formed: false }
    if (await holdsTooMuch(projectFolder, realFolder) || await wasRemovedByAPerson(projectFolder, realFolder, actor)) return null
    return form()
  })
}

/**
 * Rules 1 and 2, at a turn start of a session with no codebase: the one
 * codebase that holds the project folder, else a new codebase when the folder
 * has a repository inside it. Null when the session stays with no codebase.
 */
export async function codebaseForProjectFolder(sessionId: string, projectFolder: string, actor: Actor): Promise<SessionCodebase | null> {
  if (hasNoRule(projectFolder, actor)) return null
  return formOnce(projectFolder, actor, async () => {
    const inside = await repositoriesInside(projectFolder).catch(() => [])
    return inside.length > 0 ? makeCodebase(sessionId, projectFolder, [], actor) : null
  })
}

/** True when `folder` is a project that this host lists, or is inside one. */
async function isInListedProject(folder: string): Promise<boolean> {
  const realFolder = await realPathOf(folder)
  for (const project of await listProjects()) {
    if (isInsideRoot(await realPathOf(project.path), realFolder)) return true
  }
  return false
}

/**
 * Rule 4, after a folder was attached to a session with no codebase: a new
 * codebase whose roots are the project folder and the attached folder. The
 * caller ran rules 1 and 2 at the turn start. A folder that Solus only saw a
 * write in (`observed`) makes a codebase only when it is in a project that
 * this host lists, so a stray repository makes none. A folder inside the
 * project folder adds no root: rule 2 reads it at the next turn start.
 */
export async function codebaseForAttachedFolder(
  sessionId: string,
  projectFolder: string,
  attached: SessionAttachedFolder,
  actor: Actor,
): Promise<SessionCodebase | null> {
  if (hasNoRule(projectFolder, actor) || attached.source === 'codebase') return null
  if (isInsideRoot(await realPathOf(projectFolder), await realPathOf(attached.path))) return null
  if (attached.source === 'observed' && !await isInListedProject(attached.path)) return null
  return formOnce(projectFolder, actor, () => makeCodebase(sessionId, projectFolder, [resolve(attached.path)], actor))
}
