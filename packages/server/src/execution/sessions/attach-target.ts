import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { resolveRepoRoot } from '../../git/git-helpers'
import { isInsideRoot } from '../../paths'
import { resolveHomePath } from '../../platform/paths'

/** The folder that a path names for an attach, or why no folder can be attached for it. */
export type AttachTarget = { folder: string } | { refused: string }

/** The path that the file system gives for `path`, or `path` resolved when nothing is there. */
export function realPathOf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * The folder to attach for a path (docs/plans/codebases.md decision 8): the
 * root of the Git repository that holds the path, else the path itself when
 * it is a directory, else the directory of the file. One rule for each
 * trigger, so the same path always names the same session folder.
 *
 * The root of the file system and the home directory of the person are never
 * a target: they hold much more than one piece of work.
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
  return { folder }
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
