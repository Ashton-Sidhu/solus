import {
  hostPathFrom,
  hostPathKey,
  isAbsoluteHostPath,
  joinHostPath,
  normalizeHostPath,
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
