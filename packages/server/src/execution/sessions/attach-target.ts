import { access, constants, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { CHAT_ROOT_NAME } from '@solus/contracts/chat'
import { TASK_FOLDER_ROOT_NAME } from '@solus/contracts/codebases'
import { attachmentsRoot } from '../../data/assets/attachment-store'
import { folderStateOf } from '../../files/codebase-members'
import { resolveRepoRoot } from '../../git/git-helpers'
import { isInsideRoot } from '../../paths'
import { dataDir, resolveHomePath, solusDir } from '../../platform/paths'
import { listProjects } from '../../project-config/projects-manifest'

/** The folder that a path names for an attach, or why no folder can be attached for it. */
export type AttachTarget = { folder: string } | { refused: string }

/** The path that the file system gives for `path`, or `path` resolved when nothing is there. */
export function realPathOf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * The project that this host lists and that is `folder`, or holds it: the
 * deepest one. Null when no listed project holds the folder.
 */
export async function listedProjectHolding(folder: string): Promise<string | null> {
  const realFolder = await realPathOf(folder)
  let deepest: { path: string; realPath: string } | null = null
  for (const project of await listProjects()) {
    const realPath = await realPathOf(project.path)
    if (isInsideRoot(realPath, realFolder) && (!deepest || realPath.length > deepest.realPath.length)) deepest = { path: project.path, realPath }
  }
  return deepest?.path ?? null
}

/**
 * The temporary directories of the operating system. The system puts a pasted
 * screenshot, a download, and the files of each program there, and it deletes
 * them: such a directory is not a folder of the work.
 */
export function systemTemporaryPlaces(): string[] {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir
    return systemRoot ? [tmpdir(), join(systemRoot, 'Temp')] : [tmpdir()]
  }
  return [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
}

/** True when `realPath` is one of `places`, or is inside one. A place is read with its name and with its real path. */
async function isInPlace(places: readonly string[], realPath: string): Promise<boolean> {
  for (const place of places) {
    if (isInsideRoot(place, realPath) || isInsideRoot(await realPathOf(place), realPath)) return true
  }
  return false
}

/**
 * Why a folder in the data of Solus is not a session folder, or null. The
 * data folder holds the database, the secrets, and the sessions of the host,
 * and the attachment store holds the files that clients uploaded. A task
 * folder and the folder of a chat are in the data folder, but they are folders
 * of work, so they are not refused. `resolved` is the path that the message
 * names, and `realFolder` is the real path of the folder to attach.
 */
export async function refusalForSolusData(resolved: string, realFolder: string): Promise<string | null> {
  if (await isInPlace([attachmentsRoot()], realFolder)) {
    return `"${resolved}" is in the attachment store of this host, which cannot be a session folder. Read an attached file by its path.`
  }
  for (const dataFolder of new Set([solusDir(), dataDir()])) {
    if (!await isInPlace([dataFolder], realFolder)) continue
    const realDataFolder = await realPathOf(dataFolder)
    const isWorkFolder = [TASK_FOLDER_ROOT_NAME, CHAT_ROOT_NAME].some((name) => {
      const holder = join(realDataFolder, name)
      return realFolder !== holder && isInsideRoot(holder, realFolder)
    })
    if (!isWorkFolder) return `"${resolved}" is in the data folder of Solus, which cannot be a session folder.`
  }
  return null
}

/** True when `folder` is one of the temporary directories `places`, or is inside one. */
export async function isInTemporaryPlace(folder: string, places: readonly string[]): Promise<boolean> {
  return isInPlace(places, await realPathOf(folder))
}

/**
 * The rule of each automatic trigger (docs/plans/codebases.md decision 8):
 * the folder that Solus attaches when nobody asked for a folder by its name,
 * or why it attaches none. An automatic trigger is a path that Solus read in
 * a prompt, in a permission request, or in a write. `folder` is the target of
 * that path (`attachTargetOf`).
 *
 * Such a trigger attaches only a real project of the work: a Git repository,
 * or the project that this host lists and that holds the folder. A different
 * folder (`~/Downloads`, the directory of a file that the agent read) is not
 * a request to work there: the trigger attaches nothing, and the permission
 * flow of the provider answers for that one call. A temporary directory of
 * the system (the file of a pasted screenshot) and a folder that cannot be
 * read are refused also. A person and the agent can still ask for each such
 * folder by its name.
 *
 * `temporaryPlaces` is `systemTemporaryPlaces()` on a host. A test that makes
 * its folders in the temporary directory gives its own list.
 */
export async function automaticAttachTarget(folder: string, temporaryPlaces: readonly string[]): Promise<AttachTarget> {
  if (await isInTemporaryPlace(folder, temporaryPlaces)) {
    return { refused: `"${folder}" is in a temporary directory of the system. Solus attaches such a folder only when a person or the agent asks for it.` }
  }
  const isReadable = await access(folder, constants.R_OK).then(() => true, () => false)
  if (!isReadable) return { refused: `"${folder}" cannot be read.` }
  if (await folderStateOf(folder) === 'git') return { folder }
  const project = await listedProjectHolding(folder)
  // The listed project is the folder of the work. It passes the same rule as each other target.
  if (project) return attachTargetOf(project)
  return { refused: `"${folder}" is not a Git repository and is not in a project of this host. Solus attaches such a folder only when a person or the agent asks for it.` }
}

/**
 * The folder to attach for a path (docs/plans/codebases.md decision 8): the
 * root of the Git repository that holds the path, else the path itself when
 * it is a directory, else the directory of the file. One rule for each
 * trigger, so the same path always names the same session folder.
 *
 * The root of the file system and the home directory of the person are never
 * a target: they hold much more than one piece of work. The data folder of
 * Solus and the attachment store of the host are never a target: they are not
 * a place of work. An automatic trigger also asks `automaticAttachTarget`
 * about the folder.
 */
export async function attachTargetOf(path: string): Promise<AttachTarget> {
  const named = resolveHomePath(path.trim())
  if (!isAbsolute(named)) return { refused: `"${path}" is not an absolute path. Give an absolute path, or a path under ~.` }
  const resolved = resolve(named)
  const entry = await stat(resolved).catch(() => null)
  if (!entry) return { refused: `"${resolved}" does not exist on this host.` }
  const directory = entry.isDirectory() ? resolved : dirname(resolved)
  const folder = await repositoryRootHolding(directory) ?? directory

  const realFolder = await realPathOf(folder)
  if (parse(realFolder).root === realFolder) {
    return { refused: `"${resolved}" is in the root of the file system, which cannot be a session folder. Name a folder below it.` }
  }
  for (const home of new Set([resolveHomePath('~'), homedir()])) {
    if (await realPathOf(home) === realFolder) {
      return { refused: `"${resolved}" is in the home directory, which cannot be a session folder. Name a folder below it.` }
    }
  }
  const refusal = await refusalForSolusData(resolved, realFolder)
  return refusal ? { refused: refusal } : { folder }
}

/**
 * The root of the repository that holds `directory`, written with the names
 * that `directory` uses (Git answers the real path). Null for a directory in
 * no repository, and for a checkout that its repository does not hold (a
 * linked worktree in a different place, a submodule): there the directory is
 * the folder.
 */
async function repositoryRootHolding(directory: string): Promise<string | null> {
  // Most folders that a prompt names are in no repository: Git is asked only below a `.git` entry.
  if (!await hasGitEntryAbove(directory)) return null
  const repositoryRoot = await resolveRepoRoot(directory)
  if (!repositoryRoot) return null
  const [realRoot, realDirectory] = await Promise.all([realPathOf(repositoryRoot), realPathOf(directory)])
  if (!isInsideRoot(realRoot, realDirectory)) return null
  const below = relative(realRoot, realDirectory)
  let named = directory
  for (let depth = below === '' ? 0 : below.split(sep).length; depth > 0; depth--) named = dirname(named)
  return await realPathOf(named) === realRoot ? named : resolve(repositoryRoot)
}

/** True when `directory` or a folder above it has a `.git` entry: only then can Git name a repository for it. */
async function hasGitEntryAbove(directory: string): Promise<boolean> {
  for (let folder = directory; ; folder = dirname(folder)) {
    if (await stat(join(folder, '.git')).catch(() => null)) return true
    if (dirname(folder) === folder) return false
  }
}
