import {
  hostPathKey,
  hostPathSegments,
  hostPathSeparator,
  isAbsoluteHostPath,
  isWindowsHostPath,
  joinHostPath,
  relativeHostPath,
} from '@solus/contracts/host-path'

/**
 * How one session names a file when it works in more than one folder
 * (docs/plans/codebases.md §8). A file of the working directory keeps its
 * path. A file of a session folder has the folder's path from the working
 * directory in front (`../api/src/a.ts`, `api/src/a.ts`), as the host writes
 * it in a change summary, so two repositories never name one file the same.
 */

/** One file of a session, and the session folder that holds it. */
export interface SessionFile<Folder> {
  /** The file as the session names it: from the working directory. */
  sessionPath: string
  /** The session folder that holds the file. Null for a file of the working
   *  directory, and for a file that no folder of the session holds. */
  folder: Folder | null
  /** The file from its session folder, or as the session names it. */
  path: string
}

/** `path` with each `.` and `..` name applied. A clean path comes back the same. */
export function normalizeHostPath(path: string): string {
  const lead = path.startsWith('\\\\') ? '\\\\' : path.startsWith('/') ? '/' : ''
  const hasDrive = !lead && isWindowsHostPath(path)
  const names: string[] = []
  for (const name of hostPathSegments(path)) {
    if (name === '.') continue
    if (name !== '..') names.push(name)
    else if (names.length > (hasDrive ? 1 : 0) && names.at(-1) !== '..') names.pop()
    // A relative path can start above its folder. A rooted path cannot go above its root.
    else if (!lead && !hasDrive) names.push(name)
  }
  return lead + names.join(hostPathSeparator(path))
}

/**
 * The folder `to` as a path from the folder `from`, with `/` separators:
 * `../api` for a folder beside it, `api` for one inside it, `''` for the
 * folder itself. A folder on a different drive keeps its absolute path.
 */
export function hostPathFrom(from: string, to: string): string {
  const fromNames = hostPathSegments(hostPathKey(from))
  const toKeyNames = hostPathSegments(hostPathKey(to))
  const toNames = hostPathSegments(to)
  const isWindows = isWindowsHostPath(to)
  if (isWindows !== isWindowsHostPath(from) || (isWindows && fromNames[0] !== toKeyNames[0])) {
    return to.replaceAll('\\', '/')
  }
  let shared = 0
  while (shared < fromNames.length && shared < toKeyNames.length && fromNames[shared] === toKeyNames[shared]) shared++
  return [...fromNames.slice(shared).map(() => '..'), ...toNames.slice(shared)].join('/')
}

/** A file of one session folder, as the session names it. */
export function sessionPathIn(folder: { path: string }, workingDirectory: string, path: string): string {
  const prefix = hostPathFrom(workingDirectory, folder.path)
  return prefix ? `${prefix}/${path}` : path
}

/**
 * The folder of the session that holds a file, and the file's path from it.
 * `path` is absolute, or it is from the working directory. The longest folder
 * wins: a file of a repository inside a different one is a file of the inner
 * repository, and a file of the working directory inside a session folder
 * stays a file of the working directory.
 */
export function locateSessionFile<Folder extends { path: string }>(
  path: string,
  workingDirectory: string,
  folders: readonly Folder[],
): SessionFile<Folder> {
  const unlocated = { sessionPath: path, folder: null, path }
  if (!workingDirectory || path.startsWith('~')) return unlocated
  const absolute = isAbsoluteHostPath(path) ? path : normalizeHostPath(joinHostPath(workingDirectory, path))
  let holder: Folder | null = null
  let held: string | null = null
  for (const folder of folders) {
    const inFolder = relativeHostPath(folder.path, absolute)
    if (inFolder === null || !inFolder) continue
    if (holder && hostPathKey(folder.path).length <= hostPathKey(holder.path).length) continue
    holder = folder
    held = inFolder
  }
  const fromWorkingDirectory = relativeHostPath(workingDirectory, absolute)
  if (!holder || held === null) return unlocated
  if (fromWorkingDirectory !== null && hostPathKey(workingDirectory).length > hostPathKey(holder.path).length) return unlocated
  return { sessionPath: sessionPathIn(holder, workingDirectory, held), folder: holder, path: held }
}
