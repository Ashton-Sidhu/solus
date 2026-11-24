import { lstat } from 'fs/promises'
import { basename, join, relative, resolve, sep } from 'path'
import { createLogger } from '../logger'
import { realPathOf } from '../paths'
import { resolveHomePath } from '../platform/paths'
import { runBounded } from '../lib/concurrency'
import { resolveRepoRoot } from './git-helpers'
import { turnActivity } from './turn-activity'
import {
  SESSION_CHANGE_SUMMARY_FILES,
  type ChangeCounts,
  type DigestTurnChanges,
  type SessionChangeSummary,
  type SessionRepositoryChanges,
} from '@solus/contracts/session-digest'
import type { ChangedFileStat } from '@solus/contracts/git-types'
import { beginFolderTurn, endFolderTurn } from './folder-turn-snapshots'
import { getDiffStats, getSessionBaseSha, initSessionBase, prepareTurnSnapshot, sessionBaseCommit, snapshotTurn, type SnapshotOpts } from './session-snapshots'

const log = createLogger('TurnCheckpoints', 'turn-checkpoints.ts')

/**
 * The one owner of a turn's checkpoints. A backend tells it where a turn starts
 * and where it ends; how each checkout is captured is decided here. A session
 * has one checkpoint target for each repository it works in: its working
 * directory, and each `git` session folder (docs/plans/codebases.md §8).
 *
 * Both ends of a turn in the working directory are whole-checkout snapshots
 * (`session-snapshots.ts`), so a turn's diff holds every change, whichever tool
 * or person made it, less what another session wrote at the same time
 * (`session-snapshots.ts`, with times from `turn-activity.ts`). A session
 * folder is captured only when the turn changed it (`folder-turn-snapshots.ts`).
 *
 * The snapshots of one turn in different repositories have different indexes:
 * each repository counts its own. They carry the same `traceId`.
 */

/** A `git` session folder as a checkpoint target. `SessionFolder` has this shape. */
export interface CheckpointFolder {
  /** Where the session works: the member itself, or its worktree. */
  path: string
  /** The folder `path` is a checkout of. It names the repository in a change summary. */
  repositoryPath: string
  name: string
}

/** Where one Solus session works. Snapshots belong to the session, not to one
 *  provider thread (docs/plans/session-identity.md). */
export interface CheckpointTarget {
  sessionId: string
  /** The working directory of the session. */
  workTree: string
  /** The `git` session folders at this moment. It is read at each end of the
   *  turn: a folder attached in the turn is only in the second answer. */
  folders?: () => readonly CheckpointFolder[]
}

/** What one turn's checkpoint found: the session's change so far, and the turn's own totals. */
export interface TurnCheckpointed {
  sessionId: string
  changes: SessionChangeSummary
  turn: DigestTurnChanges & { endedAt: number }
}

/** All the session folders of one turn start share this time, so many
 *  repositories delay a turn no longer than one does. */
export const FOLDER_START_BUDGET_MS = 2_000
/** The session folders that are read at one time. */
const FOLDER_CONCURRENCY = 4
/** The most change summaries of left-alone repositories that are kept. */
const SUMMARY_CACHE_SIZE = 256

interface OpenTurn {
  startedAt: number
  /** The repositories of session folders that got a start in this turn, by real repository root. */
  started: Set<string>
}

/** One repository of a session folder, resolved. */
interface FolderRepository {
  folder: CheckpointFolder
  workTree: string
  repoRoot: string
  /** The real path of `repoRoot`: two folders with one key are one target. */
  key: string
}

/** The open turn of each session on this host. */
const openTurns = new Map<string, OpenTurn>()
/** The files a session changed in a repository that was clean at `head` when
 *  they were read: a later turn that leaves the repository alone reads no diff. */
const leftAloneSummaries = new Map<string, { head: string; files: ChangedFileStat[] }>()

const checkpointListeners = new Set<(checkpoint: TurnCheckpointed) => void>()

/** Hear each turn checkpoint, after its snapshots are written. One call for one turn, with all its repositories. */
export function onTurnCheckpointed(listener: (checkpoint: TurnCheckpointed) => void): () => void {
  checkpointListeners.add(listener)
  return () => checkpointListeners.delete(listener)
}

/** Capture each checkout before a provider turn starts. Never throws: a turn
 *  runs without a checkpoint rather than not at all. */
export async function beginTurnCheckpoint(target: CheckpointTarget): Promise<void> {
  const turn: OpenTurn = { startedAt: Date.now(), started: new Set() }
  openTurns.set(target.sessionId, turn)
  const workTree = resolveHomePath(target.workTree)
  let repoRoot: string | null = null
  try {
    turnActivity.turnStarted(target.sessionId, workTree)
    repoRoot = await resolveRepoRoot(workTree)
  } catch (error) {
    log.warn('turn_checkpoint_begin_failed', { sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
  }
  await Promise.all([
    repoRoot ? beginWorkingDirectory(target.sessionId, workTree, repoRoot) : null,
    beginFolders(target, turn, repoRoot),
  ])
}

async function beginWorkingDirectory(sessionId: string, workTree: string, repoRoot: string): Promise<void> {
  try {
    await initSessionBase(repoRoot, sessionId, await sessionBaseCommit(workTree, repoRoot), workTree)
    await prepareTurnSnapshot(workTree, repoRoot, sessionId)
  } catch (error) {
    log.warn('turn_checkpoint_begin_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Take the start of each session folder, a few at one time, inside one time
 *  budget. A folder that misses the budget has no start in this turn. */
async function beginFolders(target: CheckpointTarget, turn: OpenTurn, workingRepoRoot: string | null): Promise<void> {
  const folders = foldersOf(target)
  if (folders.length === 0) return
  const { sessionId } = target
  const budget = new AbortController()
  let late: ReturnType<typeof setTimeout> | undefined
  const budgetEnded = new Promise<void>((done) => {
    late = setTimeout(() => {
      budget.abort()
      done()
    }, FOLDER_START_BUDGET_MS)
  })
  const startAll = async (): Promise<void> => {
    const repositories = await folderRepositories(folders, workingRepoRoot ? await realPathOf(workingRepoRoot) : null)
    await runBounded(repositories.map((repository) => async () => {
      if (budget.signal.aborted) return
      try {
        turnActivity.turnStarted(sessionId, repository.workTree)
        if (await beginFolderTurn(repository.workTree, repository.repoRoot, sessionId, budget.signal)) turn.started.add(repository.key)
      } catch (error) {
        if (!budget.signal.aborted) log.warn('turn_checkpoint_folder_begin_failed', { sessionId, cwd: repository.workTree, error: error instanceof Error ? error.message : String(error) })
      }
    }), FOLDER_CONCURRENCY)
  }
  const starts = startAll().catch((error) => log.warn('turn_checkpoint_begin_failed', { sessionId, error: error instanceof Error ? error.message : String(error) }))
  await Promise.race([starts, budgetEnded])
  clearTimeout(late)
  if (budget.signal.aborted) log.info('turn_checkpoint_folder_budget_ended', { sessionId, folders: folders.length, started: turn.started.size })
}

/** Capture each checkout when a turn ends. Answers the paths the session has
 *  changed from its base in its working directory, read from git, or null when
 *  no checkpoint was taken there. */
export async function endTurnCheckpoint(target: CheckpointTarget, facts: SnapshotOpts): Promise<string[] | null> {
  const { sessionId } = target
  const turn = openTurns.get(sessionId)
  openTurns.delete(sessionId)
  const workTree = resolveHomePath(target.workTree)
  const ended: RepositoryTurn[] = []
  let sessionChangedFiles: string[] | null = null
  let workingRepoRoot: string | null = null
  try {
    workingRepoRoot = await resolveRepoRoot(workTree)
    if (workingRepoRoot) {
      const result = await snapshotTurn(workTree, workingRepoRoot, sessionId, facts)
      sessionChangedFiles = result?.sessionChangedFiles ?? null
      ended.push({
        repositoryPath: workingRepoRoot, name: basename(workingRepoRoot), prefix: '',
        workTree, repoRoot: workingRepoRoot, key: await realPathOf(workingRepoRoot), turn: result?.snapshot ?? null, leftAloneAt: null,
      })
    }
  } catch (error) {
    log.warn('turn_checkpoint_end_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
  } finally {
    turnActivity.turnEnded(sessionId, workTree)
  }
  // An end with no start in this process (a second end of one run) records nothing in the session folders.
  if (turn) ended.push(...await endFolders(target, turn, workTree, ended[0]?.key ?? null, facts))
  // Also the turn of a folder that left the session in the turn.
  turnActivity.sessionTurnsEnded(sessionId)
  // The summary is more reads of git; the turn does not wait for it.
  if (checkpointListeners.size > 0 && ended.some((repository) => repository.turn)) void announceCheckpoint(sessionId, ended)
  return sessionChangedFiles
}

/** One repository at the end of a turn. */
interface RepositoryTurn {
  repositoryPath: string
  name: string
  /** What goes in front of a file of this repository in the session's file list. Empty for the working directory. */
  prefix: string
  workTree: string
  repoRoot: string
  key: string
  /** The totals of the snapshot this turn wrote; null when it wrote none. */
  turn: (ChangeCounts & { timestamp: number }) | null
  leftAloneAt: string | null
}

async function endFolders(target: CheckpointTarget, turn: OpenTurn, workingDirectory: string, workingKey: string | null, facts: SnapshotOpts): Promise<RepositoryTurn[]> {
  const { sessionId } = target
  const repositories = await folderRepositories(foldersOf(target), workingKey)
  const ended = await runBounded(repositories.map((repository) => async (): Promise<RepositoryTurn | null> => {
    const { folder } = repository
    try {
      const { result, leftAloneAt } = await endFolderTurn(repository.workTree, repository.repoRoot, sessionId, turn.started.has(repository.key), turn.startedAt, facts)
      return {
        repositoryPath: folder.repositoryPath, name: folder.name, prefix: toPosix(relative(resolve(workingDirectory), repository.workTree)),
        workTree: repository.workTree, repoRoot: repository.repoRoot, key: repository.key, turn: result?.snapshot ?? null, leftAloneAt,
      }
    } catch (error) {
      log.warn('turn_checkpoint_folder_end_failed', { sessionId, cwd: folder.path, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }), FOLDER_CONCURRENCY)
  return ended.filter((repository) => repository !== null)
}

async function announceCheckpoint(sessionId: string, ended: RepositoryTurn[]): Promise<void> {
  try {
    const repositories: SessionRepositoryChanges[] = []
    const listed: ChangedFileStat[] = []
    for (const repository of ended) {
      const files = await sessionFilesIn(sessionId, repository)
      if (files.length === 0) continue
      const changes = { repositoryPath: repository.repositoryPath, name: repository.name, ...totalsOf(files) }
      repositories.push(changes)
      const { prefix } = repository
      listed.push(...(prefix ? changes.files.map((file) => ({ ...file, path: `${prefix}/${file.path}` })) : changes.files))
    }
    const turns = ended.flatMap((repository) => repository.turn ? [{ repository, turn: repository.turn }] : [])
    const changedInTurn = turns.filter(({ turn }) => turn.filesChanged > 0)
    const turn: TurnCheckpointed['turn'] = { ...sumOf(turns.map((each) => each.turn)), endedAt: Math.max(...turns.map((each) => each.turn.timestamp)) }
    if (changedInTurn.length > 1) {
      turn.repositories = changedInTurn.map((each) => ({
        repositoryPath: each.repository.repositoryPath, name: each.repository.name,
        filesChanged: each.turn.filesChanged, additions: each.turn.additions, deletions: each.turn.deletions,
      }))
    }
    const checkpoint: TurnCheckpointed = { sessionId, changes: sessionSummary(repositories, listed), turn }
    for (const listener of checkpointListeners) listener(checkpoint)
  } catch (error) {
    log.warn('turn_checkpoint_summary_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The session's own change in one repository, from its base to the checkout
 * now. A repository the session never changed is not read. One that the turn
 * left alone is read one time for each commit it is clean at.
 */
async function sessionFilesIn(sessionId: string, repository: RepositoryTurn): Promise<ChangedFileStat[]> {
  const cacheKey = `${sessionId}\0${repository.key}`
  // No sidecar: the session has no change in the repository, and no Git process is needed to know it.
  if (!getSessionBaseSha(repository.repoRoot, sessionId)) return []
  if (!repository.leftAloneAt) {
    leftAloneSummaries.delete(cacheKey)
    return getDiffStats(repository.workTree, repository.repoRoot, { kind: 'session' }, sessionId)
  }
  const known = leftAloneSummaries.get(cacheKey)
  if (known?.head === repository.leftAloneAt) return known.files
  const files = await getDiffStats(repository.workTree, repository.repoRoot, { kind: 'session' }, sessionId)
  leftAloneSummaries.delete(cacheKey)
  leftAloneSummaries.set(cacheKey, { head: repository.leftAloneAt, files })
  if (leftAloneSummaries.size > SUMMARY_CACHE_SIZE) leftAloneSummaries.delete(leftAloneSummaries.keys().next().value!)
  return files
}

/** The totals of one repository, with its largest files first. Each path is relative to the repository. */
function totalsOf(files: ChangedFileStat[]): Pick<SessionRepositoryChanges, 'files' | 'filesChanged' | 'additions' | 'deletions'> {
  const largestFirst = [...files].sort(bySize)
  return {
    files: largestFirst.slice(0, SESSION_CHANGE_SUMMARY_FILES),
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

/**
 * The change of the session over all its repositories. A file of the working
 * directory's repository keeps its path; a file of a session folder gets the
 * folder's path from the working directory in front, so two repositories never
 * name one file the same. The list for each repository is present only when
 * more than one repository has changes.
 */
function sessionSummary(repositories: SessionRepositoryChanges[], listed: ChangedFileStat[]): SessionChangeSummary {
  const summary: SessionChangeSummary = { files: listed.sort(bySize).slice(0, SESSION_CHANGE_SUMMARY_FILES), ...sumOf(repositories) }
  if (repositories.length > 1) summary.repositories = repositories
  return summary
}

function sumOf(counts: ChangeCounts[]): ChangeCounts {
  return {
    filesChanged: counts.reduce((total, each) => total + each.filesChanged, 0),
    additions: counts.reduce((total, each) => total + each.additions, 0),
    deletions: counts.reduce((total, each) => total + each.deletions, 0),
  }
}

function bySize(a: ChangedFileStat, b: ChangedFileStat): number {
  return (b.additions + b.deletions) - (a.additions + a.deletions)
}

function foldersOf(target: CheckpointTarget): readonly CheckpointFolder[] {
  try {
    return target.folders?.() ?? []
  } catch (error) {
    log.warn('turn_checkpoint_folders_failed', { sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

/**
 * The repositories of the session folders, in the order of the folders. Two
 * folders in one repository root (a path and its real path) are one target:
 * the first one, at each end of a turn. The repository of the working
 * directory is left out: it has its own checkpoint.
 */
async function folderRepositories(folders: readonly CheckpointFolder[], workingKey: string | null): Promise<FolderRepository[]> {
  const resolved = await runBounded(folders.map((folder) => () => repositoryOf(folder).catch(() => null)), FOLDER_CONCURRENCY)
  const seen = new Set(workingKey ? [workingKey] : [])
  return resolved.filter((repository): repository is FolderRepository => {
    if (!repository || seen.has(repository.key)) return false
    seen.add(repository.key)
    return true
  })
}

/**
 * The repository of a session folder. A folder with its own `.git` directory
 * is its repository root, which costs no Git process; a linked worktree asks
 * Git for the repository it belongs to.
 */
async function repositoryOf(folder: CheckpointFolder): Promise<FolderRepository | null> {
  const workTree = resolve(resolveHomePath(folder.path))
  const hasOwnGitDirectory = (await lstat(join(workTree, '.git')).catch(() => null))?.isDirectory() === true
  const repoRoot = hasOwnGitDirectory ? workTree : await resolveRepoRoot(workTree)
  return repoRoot ? { folder, workTree, repoRoot, key: await realPathOf(repoRoot) } : null
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
