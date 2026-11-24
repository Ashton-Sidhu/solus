import { homedir } from 'node:os'
import { dirname, parse, resolve } from 'node:path'
import type { ActivityKind } from '@solus/contracts/activity'
import { isChat } from '@solus/contracts/chat'
import { nextUpdatedAt } from '@solus/client-core/codebases'
import { plainCodebaseName, type Codebase, type CodebaseRoot, type SessionAttachedFolder } from '@solus/contracts/codebases'
import { hostPathBaseName } from '@solus/contracts/host-path'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { codebasesOfFolder, getCodebase, listCodebases, saveCodebase } from '../../data/codebases/codebases'
import { folderStateOf, isContainer } from '../../files/codebase-members'
import { findTaskFolderContaining, projectRootOfPath } from '../../git/task-folder-store'
import { hostUserKey } from '../../host/host-user'
import { runOneAtATime } from '../../lib/concurrency'
import { createLogger } from '../../logger'
import { isInsideRoot, realPathOf } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import { isOutsideProjects, listProjects } from '../../project-config/projects-manifest'
import { listedProjectHolding } from './attach-target'

const log = createLogger('SessionRuntime', 'session-codebase-formation.ts')

/**
 * The codebases that Solus forms (docs/plans/codebases.md decisions 13 and
 * 14). A person does not make a codebase before the work.
 *
 * - Rule 1: exactly one live codebase holds the project folder. The session
 *   takes it. More than one: the session takes none, and nothing is formed.
 * - The container rule: a folder that is not a repository and that holds two
 *   or more repositories is a container, and a container is a codebase with
 *   one root. It forms at a turn start of a session that works there, and
 *   when a person adds or opens the folder as a project.
 * - Rule 2: a real second project is attached to a session with no codebase:
 *   a Git repository, or a folder in a project that this host lists, that is
 *   not in the project folder. A codebase with two roots, the project folder
 *   and the attached folder, is made. A different folder that is attached
 *   stays a folder of that session only.
 *
 * A project is one folder or one repository: no rule looks inside a
 * repository for more repositories.
 *
 * `SessionFolders` calls the rules for a session. It decides which session
 * has no codebase.
 */

/** The codebase that a rule gave a session. */
export interface SessionCodebase {
  codebase: Codebase
  /** True only when this call made the record. */
  formed: boolean
  /**
   * Set when this call made the record with a plain name from the names of
   * its folders: a generated name can replace it later (`renameFormed`).
   */
  plainName?: string
}

/**
 * The record of a formation in the conversation of the session: the divider
 * that each client shows at the point where the codebase formed. `name` is
 * the name at that time. A client shows the name that the codebase has now,
 * and this one when it has no copy of the codebase.
 */
export function formationActivity(codebase: Codebase): Extract<ActivityKind, { kind: 'codebase_formed' }> {
  return { kind: 'codebase_formed', codebaseId: codebase.id, name: codebase.name }
}

/** A guest reads no codebase and stays in the checkout of the shared session, and a chat has no project folder: no rule applies. */
export function hasNoRule(projectFolder: string, actor: Actor): boolean {
  return actor.principal.kind === 'guest' || isChat(projectFolder)
}

/**
 * True when the folder is not the place of one piece of work: the root of the
 * file system, the home directory, and the projects root of the host or of a
 * member hold much more. Such a folder is no container, and no codebase is
 * made for it.
 */
export async function holdsTooMuch(projectFolder: string): Promise<boolean> {
  const realFolder = await realPathOf(projectFolder)
  if (isOutsideProjects(projectFolder) || parse(realFolder).root === realFolder) return true
  for (const home of new Set([resolveHomePath('~'), homedir()])) {
    if (await realPathOf(home) === realFolder) return true
  }
  return false
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

/**
 * A person's "no" is kept: a deleted codebase keeps its roots, and a deleted
 * codebase stops the rule that would make a codebase with the same set of
 * roots. A codebase with a different set of roots is a different codebase,
 * so the delete of a wrong one does not stop the correct one. The person can
 * still make each codebase by hand.
 */
async function wasRemovedByAPerson(roots: readonly string[], actor: Actor): Promise<boolean> {
  const installationId = getInstallationId()
  const wanted = await realPathsOf(roots)
  for (const codebase of await listCodebases(recordScopeOf(actor.principal), { includeDeleted: true })) {
    if (codebase.deletedAt === null || codebase.roots.length !== roots.length) continue
    if (codebase.roots.some((root) => root.installationId !== installationId)) continue
    const removed = await realPathsOf(codebase.roots.map((root) => root.path))
    if (removed.size === wanted.size && [...wanted].every((path) => removed.has(path))) return true
  }
  return false
}

/** The set of the real paths of `paths`. A path that is gone keeps its name, so a deleted codebase with a root that is gone still compares. */
async function realPathsOf(paths: readonly string[]): Promise<Set<string>> {
  return new Set(await Promise.all(paths.map((path) => realPathOf(path))))
}

/** `base`, or `base` with a number when a live codebase in the scope of the person has that name: `solus 2`. */
async function freeNameFor(base: string, actor: Actor, exceptId?: string): Promise<string> {
  const taken = new Set((await listCodebases(recordScopeOf(actor.principal))).filter((codebase) => codebase.id !== exceptId).map((codebase) => codebase.name))
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

/**
 * A folder of this host as a root. A folder that is a container at this time
 * gets the mark, so the host reads the repositories inside it as members.
 */
export async function rootOf(path: string): Promise<CodebaseRoot> {
  const root: CodebaseRoot = { installationId: getInstallationId(), path, name: '' }
  return await isContainer(path) ? { ...root, container: true } : root
}

async function makeCodebase(sessionId: string | null, roots: CodebaseRoot[], name: string, actor: Actor): Promise<Codebase> {
  const codebase = await saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), {
    id: crypto.randomUUID(),
    name,
    roots,
    updatedAt: Date.now(),
    deletedAt: null,
  })
  log.info('session_codebase_formed', { sessionId, codebaseId: codebase.id, projectFolder: roots[0]?.path, rootCount: codebase.roots.length, container: roots.length === 1 })
  return codebase
}

/**
 * Rule 1, at a turn start of a session with no codebase: the one live
 * codebase that holds the project folder. Null when none holds it, and when
 * more than one does.
 */
export async function codebaseOfProjectFolder(projectFolder: string, actor: Actor): Promise<Codebase | null> {
  if (hasNoRule(projectFolder, actor)) return null
  const existing = await existingCodebaseOf(projectFolder, actor)
  return existing === 'none' || existing === 'several' ? null : existing
}

/**
 * The container rule (decision 14): the codebase of a folder that is a
 * container. The one live codebase that holds the folder is the answer, with
 * `formed` false. When none holds it, a codebase with one root, the folder
 * marked as a container, is made with the name of the folder. Null for a
 * folder that is no container (it holds one repository or none, or it is a
 * repository), for a folder that more than one codebase holds, for a folder
 * that holds much more than one piece of work, and when a person deleted the
 * codebase of this folder.
 *
 * `sessionId` is null when no session asks: a person added the folder as a project.
 */
export async function containerCodebaseOf(sessionId: string | null, folder: string, actor: Actor): Promise<SessionCodebase | null> {
  // The cheap answers first: the read of a folder that holds too much (the home directory) is not small.
  if (hasNoRule(folder, actor) || await holdsTooMuch(folder) || !await isContainer(folder)) return null
  return runOneAtATime(`codebase-formation:${await realPathOf(folder)}`, async () => {
    const existing = await existingCodebaseOf(folder, actor)
    if (existing === 'several') return null
    if (existing !== 'none') return { codebase: existing, formed: false }
    if (await wasRemovedByAPerson([folder], actor)) return null
    const name = await freeNameFor(hostPathBaseName(folder) || folder, actor)
    return { codebase: await makeCodebase(sessionId, [{ installationId: getInstallationId(), path: folder, name: '', container: true }], name, actor), formed: true }
  })
}

/**
 * A person added or opened `path` as a project on this host (Add project,
 * Open project, the directory picker, a clone). When the folder is a
 * container, its codebase forms now, so each client shows it under Codebases
 * immediately. A new repository can also make a container of the listed
 * project that holds it (a clone into `~/shop`, which had one repository):
 * the folder above the repository, and the one above that (the two levels of
 * the discovery), are read when the host lists them as projects. A failure
 * here stops nothing.
 */
export async function formContainerCodebases(path: string, actor: Actor): Promise<void> {
  try {
    const folder = resolve(projectRootOfPath(resolveHomePath(path)))
    const candidates = [folder]
    if (await folderStateOf(folder) === 'git') {
      const above = [dirname(folder), dirname(dirname(folder))]
      // Only a folder that the host lists as a project: the folder above a clone is often the home directory.
      const listed = new Set(await Promise.all((await listProjects()).map((project) => realPathOf(project.path))))
      for (const each of above) {
        if (listed.has(await realPathOf(each))) candidates.push(each)
      }
    }
    for (const candidate of candidates) await containerCodebaseOf(null, candidate, actor)
  } catch (error) {
    log.warn('container_codebase_not_formed', { path, error: error instanceof Error ? error.message : String(error) })
  }
}

/** What rule 2 makes for an attached folder: the two roots, the project folder first, and the plain name. */
export interface FormationOffer {
  roots: [string, string]
  name: string
}

/**
 * Rule 2, before the lock: the codebase that an attach of `attached` forms in
 * a session with no codebase that works in `projectFolder`, or null when it
 * forms none. The attach card reads this to say what an answer does.
 *
 * The attached folder must be a real second project of the work: a Git
 * repository, or a folder in a project that this host lists. A plain folder
 * (the directory of a file that the agent read, a folder of notes) stays a
 * folder of that session and makes no codebase: each later session of the
 * project would get it. A folder that Solus only saw a write in (`observed`)
 * must be in a listed project, so a stray repository makes none. A folder in
 * the project folder is no second project, and a folder that holds the
 * project folder is none also: one root of a codebase is not inside a
 * different one. No codebase is made when a codebase holds the project
 * folder already, and when a person deleted a codebase with the same roots.
 */
export async function formationFor(projectFolder: string, attached: SessionAttachedFolder, actor: Actor): Promise<FormationOffer | null> {
  if (hasNoRule(projectFolder, actor) || attached.source === 'codebase') return null
  const [realProject, realAttached] = await Promise.all([realPathOf(projectFolder), realPathOf(attached.path)])
  if (isInsideRoot(realProject, realAttached) || isInsideRoot(realAttached, realProject)) return null
  const isRepository = attached.source !== 'observed' && await folderStateOf(attached.path) === 'git'
  if (!isRepository && !await listedProjectHolding(attached.path)) return null
  if (await existingCodebaseOf(projectFolder, actor) !== 'none' || await holdsTooMuch(projectFolder)) return null
  const roots: [string, string] = [projectFolder, resolve(attached.path)]
  if (await wasRemovedByAPerson(roots, actor)) return null
  const plain = plainCodebaseName(roots.map((path) => hostPathBaseName(path) || path))
  return { roots, name: await freeNameFor(plain, actor) }
}

/**
 * Rule 2, after a folder was attached to a session with no codebase: a new
 * codebase whose roots are the project folder and the attached folder
 * (`formationFor` has the conditions). The caller ran rule 1 at the turn start.
 *
 * The codebase forms at once with its plain name: the common prefix of the
 * two folder names, else the first name and a count. `name` is the name that
 * a person gave on the attach card: it is used as it is, and no generated
 * name replaces it.
 *
 * One formation at a time for one project folder, so two sessions that attach
 * there at the same moment get one codebase: the second one reads the record
 * that the first one made.
 */
export async function codebaseForAttachedFolder(
  sessionId: string,
  projectFolder: string,
  attached: SessionAttachedFolder,
  actor: Actor,
  name?: string,
): Promise<SessionCodebase | null> {
  if (!await formationFor(projectFolder, attached, actor)) return null
  return runOneAtATime(`codebase-formation:${await realPathOf(projectFolder)}`, async () => {
    const existing = await existingCodebaseOf(projectFolder, actor)
    if (existing === 'several') return null
    if (existing !== 'none') return { codebase: existing, formed: false }
    const offer = await formationFor(projectFolder, attached, actor)
    if (!offer) return null
    const roots = await Promise.all(offer.roots.map((path) => rootOf(path)))
    const given = name?.trim()
    if (given && given !== offer.name) return { codebase: await makeCodebase(sessionId, roots, await freeNameFor(given, actor), actor), formed: true }
    return { codebase: await makeCodebase(sessionId, roots, offer.name, actor), formed: true, plainName: offer.name }
  })
}

/**
 * Give a codebase that a rule formed its generated name. The name replaces
 * the plain one with a normal save and a raised `updatedAt`, so each host
 * takes it. Nothing is saved when the codebase is deleted, and when it does
 * not have its plain name now: a person renamed it, and that name stays.
 * Answers the saved copy, or null.
 */
export async function renameFormed(codebaseId: string, plainName: string, generatedName: string, actor: Actor): Promise<Codebase | null> {
  const current = await getCodebase(recordScopeOf(actor.principal), codebaseId)
  if (!current || current.deletedAt !== null || current.name !== plainName) return null
  const name = await freeNameFor(generatedName, actor, codebaseId)
  if (name === current.name) return null
  return saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), {
    ...current,
    name,
    updatedAt: nextUpdatedAt(current, Date.now()),
  })
}
