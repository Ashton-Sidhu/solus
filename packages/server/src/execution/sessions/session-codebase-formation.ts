import { resolve } from 'node:path'
import type { ActivityKind } from '@solus/contracts/activity'
import type { Codebase, SessionAttachedFolder } from '@solus/contracts/codebases'
import { hostPathBaseName } from '@solus/contracts/host-path'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { codebasesOfFolder, listCodebases, saveCodebase } from '../../data/codebases/codebases'
import { folderStateOf } from '../../files/codebase-members'
import { findTaskFolderContaining } from '../../git/task-folder-store'
import { hostUserKey } from '../../host/host-user'
import { runOneAtATime } from '../../lib/concurrency'
import { createLogger } from '../../logger'
import { isInsideRoot } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import { listedProjectHolding, realPathOf } from './attach-target'
import { hasNoRule, holdsTooMuch } from './project-members'

const log = createLogger('SessionRuntime', 'session-codebase-formation.ts')

/**
 * The codebase of a session that started with none (docs/plans/codebases.md
 * decision 13). A person does not make a codebase before the work.
 *
 * - Rule 1: exactly one live codebase holds the project folder. The session
 *   takes it. More than one: the session takes none, and nothing is formed.
 * - Rule 2: a real second project is attached to a session with no codebase:
 *   a Git repository, or a folder in a project that this host lists, that is
 *   not in the project folder. A codebase with two roots, the project folder
 *   and the attached folder, is made. A different folder that is attached
 *   stays a folder of that session only.
 *
 * No rule makes a codebase from one folder: a project covers the repositories
 * inside it with no codebase (decision 14, `project-members.ts`).
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

/**
 * The name of a codebase that a rule makes: the names of its two roots,
 * joined (`solus + solus-cloud`). Never the name of the project alone: a
 * project and a codebase with one name are two rows that read as one thing.
 * A name that a live codebase has gets a number: `shop + ui 2`.
 */
async function freeNameFor(roots: readonly string[], actor: Actor): Promise<string> {
  const base = roots.map((path) => hostPathBaseName(path) || path).join(' + ')
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

/** `roots`: the project folder first. */
async function makeCodebase(sessionId: string, roots: readonly string[], actor: Actor): Promise<SessionCodebase> {
  const installationId = getInstallationId()
  const [projectFolder] = roots
  const codebase = await saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), {
    id: crypto.randomUUID(),
    name: await freeNameFor(roots, actor),
    roots: roots.map((path) => ({ installationId, path, name: '' })),
    updatedAt: Date.now(),
    deletedAt: null,
  })
  log.info('session_codebase_formed', { sessionId, codebaseId: codebase.id, projectFolder, rootCount: codebase.roots.length })
  return { codebase, formed: true }
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
 * Rule 2, after a folder was attached to a session with no codebase: a new
 * codebase whose roots are the project folder and the attached folder. The
 * caller ran rule 1 at the turn start.
 *
 * The attached folder must be a real second project of the work: a Git
 * repository, or a folder in a project that this host lists. A plain folder
 * (the directory of a file that the agent read, a folder of notes) stays a
 * folder of that session and makes no codebase: each later session of the
 * project would get it. A folder that Solus only saw a write in (`observed`)
 * must be in a listed project, so a stray repository makes none. A folder in
 * the project folder is no second project: the project covers it. A folder
 * that holds the project folder is none also: one root of a codebase is not
 * inside a different one.
 *
 * One formation at a time for one project folder, so two sessions that attach
 * there at the same moment get one codebase: the second one reads the record
 * that the first one made. No codebase is made when a person deleted a
 * codebase with the same roots.
 */
export async function codebaseForAttachedFolder(
  sessionId: string,
  projectFolder: string,
  attached: SessionAttachedFolder,
  actor: Actor,
): Promise<SessionCodebase | null> {
  if (hasNoRule(projectFolder, actor) || attached.source === 'codebase' || attached.source === 'project') return null
  const [realProject, realAttached] = await Promise.all([realPathOf(projectFolder), realPathOf(attached.path)])
  if (isInsideRoot(realProject, realAttached) || isInsideRoot(realAttached, realProject)) return null
  const isRepository = attached.source !== 'observed' && await folderStateOf(attached.path) === 'git'
  if (!isRepository && !await listedProjectHolding(attached.path)) return null
  return runOneAtATime(`codebase-formation:${realProject}`, async () => {
    const existing = await existingCodebaseOf(projectFolder, actor)
    if (existing === 'several') return null
    if (existing !== 'none') return { codebase: existing, formed: false }
    if (await holdsTooMuch(projectFolder)) return null
    const roots = [projectFolder, resolve(attached.path)]
    if (await wasRemovedByAPerson(roots, actor)) return null
    return makeCodebase(sessionId, roots, actor)
  })
}
