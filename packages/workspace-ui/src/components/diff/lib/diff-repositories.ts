import type { SessionFolder } from '@solus/contracts/codebases'
import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'
import type { DiffComment, DiffScope, RunConfig, TurnSnapshot } from '@solus/contracts/types'
import { checkoutGit, workingPlace } from '../../../contexts/workspace/run-location'
import { locateSessionFile, sessionPathIn } from '../../../lib/session-paths'

/**
 * The repositories of one session that the diff panel can read
 * (docs/plans/codebases.md §8 and §9): the repository of the working directory
 * and each `git` session folder. The repository picker of the diff panel and
 * the Repositories section of the project panel list the same entries.
 */
export interface DiffRepository {
  /** What a diff request names: the working directory, or the `path` of a `git` session folder. */
  path: string
  name: string
  /** The repository of the working directory. A request for it names no repository. */
  isWorkingDirectory: boolean
}

/** The part of a session that says where it works. */
export interface RepositorySession {
  run: Pick<RunConfig, 'location'>
  sessionFolders: readonly SessionFolder[]
}

/**
 * The entries of the repository picker: the working directory first, then each
 * `git` session folder in the order of the session. A `plain` folder has no
 * diff, so it is not an entry.
 */
export function diffRepositories(session: RepositorySession | null | undefined): DiffRepository[] {
  const workingDirectory = workingPlace(session?.run)?.path
  if (!session || !workingDirectory || workingDirectory === '~') return []
  const repositories: DiffRepository[] = [{
    path: workingDirectory,
    // The host names the repository of the working directory the same way.
    name: hostPathBaseName(checkoutGit(session.run)?.repoRoot ?? workingDirectory) || workingDirectory,
    isWorkingDirectory: true,
  }]
  for (const folder of session.sessionFolders) {
    if (folder.state !== 'git') continue
    if (repositories.some((repository) => sameHostPath(repository.path, folder.path))) continue
    repositories.push({ path: folder.path, name: folder.name, isWorkingDirectory: false })
  }
  return repositories
}

/** A picker with one entry has no choice to offer, so it does not show. */
export function hasRepositoryChoice(repositories: readonly DiffRepository[]): boolean {
  return repositories.length > 1
}

/**
 * The entry that the picker shows for a stored choice. A choice that is not an
 * entry (no choice yet, or a folder that left the session) is the working
 * directory.
 */
export function chosenDiffRepository(
  repositories: readonly DiffRepository[],
  chosenPath: string | null | undefined,
): DiffRepository | null {
  const chosen = chosenPath ? repositories.find((repository) => sameHostPath(repository.path, chosenPath)) : undefined
  return chosen ?? repositories[0] ?? null
}

/**
 * The entry that a path from a different surface names: the `path` or the
 * `repositoryPath` of a session folder (a change summary names the second).
 * Each other path, the repository root of the working directory too, is the
 * working directory.
 */
export function diffRepositoryNamed(
  session: RepositorySession | null | undefined,
  path: string,
): DiffRepository | null {
  const repositories = diffRepositories(session)
  const folder = session?.sessionFolders.find((each) =>
    each.state === 'git' && (sameHostPath(each.path, path) || sameHostPath(each.repositoryPath, path)))
  return chosenDiffRepository(repositories, folder?.path)
}

/**
 * The scope that reads the same change in a different repository. Each
 * repository counts its own turn snapshots, so a turn index is valid in one
 * repository only: the turn is kept by its trace. A turn that left the other
 * repository alone has no snapshot there, so the scope becomes the session's.
 */
export function scopeInRepository(
  scope: DiffScope | undefined,
  fromTurns: readonly TurnSnapshot[],
  toTurns: readonly TurnSnapshot[],
): DiffScope | undefined {
  if (scope?.kind !== 'turn') return scope
  const traceId = fromTurns.find((turn) => turn.index === scope.index)?.traceId
  const sameTurn = traceId ? toTurns.find((turn) => turn.traceId === traceId) : undefined
  return sameTurn ? { kind: 'turn', index: sameTurn.index } : { kind: 'session' }
}

/** The session folders that the picker lists, for path work. */
function folderEntries(repositories: readonly DiffRepository[]): DiffRepository[] {
  return repositories.filter((repository) => !repository.isWorkingDirectory)
}

/**
 * A file of one repository as the session names it. Queued comments belong to
 * the session, and the agent reads them from its working directory, so a
 * comment in a session folder keeps the folder's path in front.
 */
export function sessionPathOfDiffFile(
  repository: DiffRepository | null,
  repositories: readonly DiffRepository[],
  path: string,
): string {
  const workingDirectory = repositories[0]
  if (!repository || repository.isWorkingDirectory || !workingDirectory) return path
  return sessionPathIn(repository, workingDirectory.path, path)
}

/** One file of a session: its repository, and its path as that repository's diff names it. */
export interface DiffRepositoryFile {
  /** Null only for a session with no working directory. */
  repository: DiffRepository | null
  path: string
}

/** The repository of a file that the session names, and the file's path in that repository's diff. */
export function diffFileOfSessionPath(
  repositories: readonly DiffRepository[],
  sessionPath: string,
): DiffRepositoryFile {
  const workingDirectory = repositories[0]
  if (!workingDirectory || repositories.length === 1) return { repository: workingDirectory ?? null, path: sessionPath }
  const file = locateSessionFile(sessionPath, workingDirectory.path, folderEntries(repositories))
  return { repository: file.folder ?? workingDirectory, path: file.path }
}

/**
 * The queued comments of one repository, each with its path as that
 * repository's diff names it. A session with one repository gets its list back.
 */
export function commentsOfRepository(
  comments: DiffComment[],
  repository: DiffRepository | null,
  repositories: readonly DiffRepository[],
): DiffComment[] {
  if (!repository || repositories.length <= 1) return comments
  const own: DiffComment[] = []
  for (const comment of comments) {
    const file = diffFileOfSessionPath(repositories, comment.filePath)
    if (file.repository !== repository) continue
    own.push(file.path === comment.filePath ? comment : { ...comment, filePath: file.path })
  }
  return own
}
