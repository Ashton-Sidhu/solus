import type { ChangedFileStat } from '@solus/contracts/git-types'
import { hostPathFrom, isAbsoluteHostPath, joinHostPath, normalizeHostPath } from '@solus/contracts/host-path'
import type { ChangeCounts, ChangedRepository, SessionChangeSummary, SessionDigest } from '@solus/contracts/session-digest'
import { locateSessionFile } from '../../../lib/session-paths'
import type { DiffRepository } from '../../diff/lib/diff-repositories'

/**
 * A change summary of a session that works in more than one repository
 * (docs/plans/codebases.md §8): the share of each repository, and the
 * repository of each file.
 */

/** What one repository holds of a change: one row of the breakdown. */
export type RepositoryChange = ChangedRepository & ChangeCounts

/** The time of one turn: from its prompt until the next prompt, the last one open. */
export interface TurnWindow {
  from: number
  until: number | null
}

function rowsOf(repositories: readonly RepositoryChange[] | undefined): RepositoryChange[] {
  return (repositories ?? []).map(({ repositoryPath, name, filesChanged, additions, deletions }) =>
    ({ repositoryPath, name, filesChanged, additions, deletions }))
}

/**
 * The breakdown of a change by repository, from the session's digest: of the
 * whole session, or of the turn that ended in `turn`. Empty when one
 * repository holds the change: the totals are then its own, and there is
 * nothing to break down.
 */
export function repositoryChanges(
  digest: Pick<SessionDigest, 'changes' | 'turns'> | null | undefined,
  turn?: TurnWindow | null,
): RepositoryChange[] {
  if (!digest) return []
  if (!turn) return rowsOf(digest.changes?.repositories)
  // A digest turn has no trace to join by. Its checkpoint is taken when it
  // ends, which is after its prompt and before the next one.
  for (let index = digest.turns.length - 1; index >= 0; index--) {
    const ended = digest.turns[index]!
    if (ended.endedAt < turn.from) break
    if (ended.settled && (turn.until === null || ended.endedAt < turn.until)) return rowsOf(ended.changes?.repositories)
  }
  return []
}

/** One repository as a summary names its files: the path in front of them, and the name a reader knows it by. */
export interface SummaryRepository {
  /** The folder's path from the working directory. Empty for the working directory. */
  prefix: string
  name: string
}

/**
 * The repositories that a summary of the session can name files in, from the
 * session's repository list (`diffRepositories`). Empty for a session with one
 * repository: its files need no repository beside them.
 */
export function summaryRepositories(repositories: readonly DiffRepository[]): SummaryRepository[] {
  const workingDirectory = repositories[0]
  if (!workingDirectory || repositories.length === 1) return []
  return repositories.map((repository) => ({
    prefix: repository.isWorkingDirectory ? '' : hostPathFrom(workingDirectory.path, repository.path),
    name: repository.name,
  }))
}

/**
 * The repository of a file that a summary names, and the file's path in it.
 * The longest folder wins, so a file of a repository inside the working
 * directory is a file of the inner repository. A path outside each repository
 * (an absolute path from the transcript) has none.
 */
export function repositoryOfSummaryFile(
  path: string,
  repositories: readonly SummaryRepository[],
): { repository: SummaryRepository; path: string } | null {
  let holder: SummaryRepository | null = null
  for (const repository of repositories) {
    if (!repository.prefix || !path.startsWith(`${repository.prefix}/`)) continue
    if (!holder || repository.prefix.length > holder.prefix.length) holder = repository
  }
  if (holder) return { repository: holder, path: path.slice(holder.prefix.length + 1) }
  const workingDirectory = repositories.find((repository) => !repository.prefix)
  return workingDirectory && !isAbsoluteHostPath(path) && !path.startsWith('~') ? { repository: workingDirectory, path } : null
}

/**
 * The files of the session folders in the host's summary of the session. Git
 * on this client counts the working directory only, so the folders' files come
 * from the summary, which names each with its folder's path in front.
 */
export function sessionFolderFiles(
  changes: SessionChangeSummary | null | undefined,
  repositories: readonly SummaryRepository[],
): ChangedFileStat[] {
  if (!changes || repositories.length === 0) return []
  return changes.files.filter((file) => !!repositoryOfSummaryFile(file.path, repositories)?.repository.prefix)
}

/**
 * The paths that a summary of the session lists: the paths the session knows,
 * each named as the session names it, and the files of the session folders
 * from the host's summary. The transcript names a file of a session folder by
 * its absolute path. It becomes the path from the longest session folder that
 * holds it, with that folder's path in front, so it is the same file as the
 * one the host lists. Undefined stays undefined: the stats then name the files.
 */
export function summaryPaths(
  changedFiles: string[] | undefined,
  repositories: readonly DiffRepository[],
  folderFiles: readonly ChangedFileStat[],
): string[] | undefined {
  const workingDirectory = repositories[0]
  if (!changedFiles || !workingDirectory || repositories.length === 1) return changedFiles
  const folders = repositories.slice(1)
  const paths = new Set<string>()
  for (const path of changedFiles) {
    const file = locateSessionFile(path, workingDirectory.path, folders)
    paths.add(file.folder ? file.sessionPath : path)
  }
  for (const file of folderFiles) paths.add(file.path)
  return [...paths]
}

/**
 * The path that opens a summary's file in the file pane. A file of a session
 * folder is outside the working directory, so it is opened by its absolute
 * path. Each other file keeps the path the summary has.
 */
export function summaryFilePath(path: string, repositories: readonly DiffRepository[]): string {
  const workingDirectory = repositories[0]
  if (!workingDirectory || repositories.length === 1 || isAbsoluteHostPath(path)) return path
  const file = locateSessionFile(path, workingDirectory.path, repositories.slice(1))
  return file.folder ? normalizeHostPath(joinHostPath(workingDirectory.path, path)) : path
}
