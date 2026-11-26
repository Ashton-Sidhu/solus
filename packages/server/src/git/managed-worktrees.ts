import { realpath, stat } from 'fs/promises'
import path from 'path'
import { taskFolderRootOf } from '@solus/contracts/codebases'
import {
  managedWorktreeState,
  worktreeProjectRoot,
  type ManagedWorktree,
  type ManagedWorktreeGroup,
  type ManagedWorktreeRemoveResult,
  type ManagedWorktreeSize,
} from '@solus/contracts/types'
import { runBounded } from '../lib/concurrency'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import type { TaskFolderRecord } from './task-folder-store'
import { checkoutsOf, removeTaskFolder, type Checkout } from './task-folders'
import { getDefaultBranchLocal, parseWorktreeList, type ListedWorktree } from './worktree-manager'

const log = createLogger('main', 'managed-worktrees')

/** Git reads at one time. A list reads three or four for each worktree. */
const GIT_READS = 6
/** `du` runs at one time. Each one walks a whole checkout and its dependencies. */
const SIZE_READS = 2
const SIZE_TIMEOUT_MS = 120_000

type WorktreeSessions = ManagedWorktree['sessions']

/** What the list and the removal need from the host, so a test can give its own. */
export interface ManagedWorktreeHost {
  /** The sessions bound to a checkout now, as `[sessionId, directory]`. */
  boundDirectories(): Iterable<[sessionId: string, directory: string]>
  /** Mid-turn, or waiting for an answer: its folder must stay. */
  isSessionBusy(sessionId: string): boolean
  sessionTitles(sessionIds: string[]): Promise<Map<string, string>>
  /** The task folders of this host that the caller sees. */
  taskFolders(): TaskFolderRecord[]
  /** The name of a codebase that the caller sees, or null. */
  codebaseName(codebaseId: string): Promise<string | null>
}

/** A worktree inside `<project>/.git/solus/worktrees/`. */
function isManaged(worktreePath: string): boolean {
  return worktreeProjectRoot(worktreePath) !== worktreePath
}

function taskFolderAt(folder: string, host: ManagedWorktreeHost): TaskFolderRecord | null {
  if (taskFolderRootOf(folder) !== folder) return null
  return host.taskFolders().find((record) => path.resolve(record.root) === folder) ?? null
}

async function managedWorktreesOf(projectPath: string): Promise<ListedWorktree[]> {
  const output = await runAsync('git', ['worktree', 'list', '--porcelain'], projectPath).catch(() => '')
  return parseWorktreeList(projectPath, output).filter((entry) => !entry.isBare && isManaged(entry.path))
}

async function realpathOrNull(directory: string): Promise<string | null> {
  return realpath(directory).catch(() => null)
}

/** The sessions bound to `folder` or to a folder inside it. */
async function sessionsIn(folder: string, host: ManagedWorktreeHost): Promise<WorktreeSessions> {
  const real = await realpathOrNull(folder)
  if (!real) return []
  const sessionIds: string[] = []
  for (const [sessionId, bound] of host.boundDirectories()) {
    const boundReal = await realpathOrNull(bound)
    if (boundReal && (boundReal === real || boundReal.startsWith(real + path.sep))) sessionIds.push(sessionId)
  }
  if (!sessionIds.length) return []
  const titles = await host.sessionTitles(sessionIds)
  return sessionIds.map((sessionId) => ({ sessionId, title: titles.get(sessionId) ?? 'Untitled session', isBusy: host.isSessionBusy(sessionId) }))
}

interface UnsavedWork {
  hasUncommittedWork: boolean
  hasUnmergedCommits: boolean
}

/** The default branch that a branch's work can be in: the local one, else the remote one. Null when neither exists. */
async function defaultBaseRef(repositoryPath: string): Promise<string | null> {
  const branch = await getDefaultBranchLocal(repositoryPath)
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (await runAsync('git', ['rev-parse', '--verify', '--quiet', ref], repositoryPath).then(() => true, () => false)) return ref
  }
  return null
}

/**
 * Whether HEAD of `worktreePath` has commits that are only here: not in the
 * default branch by content (`git cherry`, so a squash or a cherry-pick
 * counts as merged) and not on the remote branch of the same name.
 */
async function hasUnmergedCommits(worktreePath: string, repositoryPath: string, branch: string | null): Promise<boolean> {
  const base = await defaultBaseRef(repositoryPath)
  if (base) {
    const cherry = await runAsync('git', ['cherry', base, 'HEAD'], worktreePath).catch(() => null)
    if (cherry !== null && !cherry.split('\n').some((line) => line.startsWith('+'))) return false
  }
  if (!branch) return true
  const ahead = await runAsync('git', ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], worktreePath).catch(() => null)
  return ahead === null || Number(ahead) > 0
}

async function unsavedWorkOf(checkout: Checkout): Promise<UnsavedWork> {
  if (!(await stat(checkout.worktreePath).catch(() => null))?.isDirectory()) return { hasUncommittedWork: false, hasUnmergedCommits: false }
  const status = await runAsync('git', ['status', '--porcelain'], checkout.worktreePath).catch(() => '')
  const branch = await runAsync('git', ['branch', '--show-current'], checkout.worktreePath).catch(() => '')
  return {
    hasUncommittedWork: status.length > 0,
    hasUnmergedCommits: await hasUnmergedCommits(checkout.worktreePath, checkout.repositoryPath, branch || null),
  }
}

async function unsavedWorkOfAll(checkouts: readonly Checkout[]): Promise<UnsavedWork> {
  const each = await Promise.all(checkouts.map(unsavedWorkOf))
  return {
    hasUncommittedWork: each.some((work) => work.hasUncommittedWork),
    hasUnmergedCommits: each.some((work) => work.hasUnmergedCommits),
  }
}

async function newestChange(folders: readonly string[]): Promise<number | undefined> {
  const times = await Promise.all(folders.map((folder) => stat(folder).then((info) => info.mtimeMs, () => 0)))
  const newest = Math.max(0, ...times)
  return newest > 0 ? newest : undefined
}

function projectGroup(projectPath: string): ManagedWorktreeGroup {
  return { key: `project:${projectPath}`, name: path.basename(projectPath), detail: projectPath }
}

async function listedWorktree(entry: ListedWorktree, host: ManagedWorktreeHost): Promise<ManagedWorktree | null> {
  if (!(await stat(entry.path).catch(() => null))?.isDirectory()) return null
  const projectPath = worktreeProjectRoot(entry.path)
  const sessions = await sessionsIn(entry.path, host)
  return {
    path: entry.path,
    kind: 'worktree',
    group: projectGroup(projectPath),
    title: entry.branch ?? path.basename(entry.path),
    branch: entry.branch,
    lastModified: await newestChange([entry.path]),
    ...await unsavedWorkOf({ repositoryPath: projectPath, worktreePath: entry.path }),
    // No record names the session that made a worktree of one repository: a session there now is the best answer.
    sessionId: sessions[0]?.sessionId ?? null,
    sessions,
  }
}

async function listedTaskFolder(record: TaskFolderRecord, host: ManagedWorktreeHost, titles: Map<string, string>): Promise<ManagedWorktree | null> {
  if (!(await stat(record.root).catch(() => null))?.isDirectory()) return null
  const checkouts = checkoutsOf(record)
  const codebaseName = record.codebaseId ? await host.codebaseName(record.codebaseId) : null
  const repositoryNames = checkouts.map((checkout) => path.basename(checkout.repositoryPath))
  return {
    path: record.root,
    kind: 'task_folder',
    group: codebaseName && record.codebaseId
      ? { key: `codebase:${record.codebaseId}`, name: codebaseName, detail: repositoryNames.join(' + ') }
      : projectGroup(record.primaryRepositoryPath),
    title: (record.sessionId && titles.get(record.sessionId)) || record.branch,
    branch: record.branch,
    lastModified: await newestChange(checkouts.map((checkout) => checkout.worktreePath)),
    ...await unsavedWorkOfAll(checkouts),
    sessionId: record.sessionId,
    sessions: await sessionsIn(record.root, host),
  }
}

/**
 * The worktrees that Solus made in `projectPaths`, and the task folders of
 * the host, newest first. Two projects in one repository list its worktrees
 * once. A worktree or task folder whose folder is gone is not listed.
 */
export async function listManagedWorktrees(projectPaths: readonly string[], host: ManagedWorktreeHost): Promise<ManagedWorktree[]> {
  const seen = new Set<string>()
  const listed = (await Promise.all(projectPaths.map(managedWorktreesOf))).flat()
    .filter((entry) => !seen.has(entry.path) && seen.add(entry.path))
  const taskFolders = host.taskFolders()
  const titles = await host.sessionTitles(taskFolders.flatMap((record) => (record.sessionId ? [record.sessionId] : [])))
  const reads = [
    ...listed.map((entry) => () => listedWorktree(entry, host)),
    ...taskFolders.map((record) => () => listedTaskFolder(record, host, titles)),
  ]
  return (await runBounded(reads, GIT_READS))
    .filter((worktree): worktree is ManagedWorktree => worktree !== null)
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
}

/**
 * Remove a managed worktree or task folder and its branch. One where a
 * session is busy stays; an idle session there loses its working folder. One with unsaved work stays unless `force`. The
 * default branch of a project stays, also when the worktree has it.
 */
export async function removeManagedWorktree(folder: string, options: { force: boolean }, host: ManagedWorktreeHost): Promise<ManagedWorktreeRemoveResult> {
  const target = path.resolve(folder)
  const taskFolder = taskFolderAt(target, host)
  if (taskFolder) return removeTaskFolderOf(taskFolder, options, host)
  if (!isManaged(target)) return { status: 'failed', error: `${target} is not a worktree that Solus made.` }
  const projectPath = worktreeProjectRoot(target)
  const entry = (await managedWorktreesOf(projectPath)).find((each) => each.path === target)
  if (!entry) return { status: 'failed', error: `${projectPath} has no worktree at ${target}.` }

  const sessions = await sessionsIn(target, host)
  if (sessions.some((session) => session.isBusy)) return { status: 'in_use', sessions }
  const exists = (await stat(target).catch(() => null))?.isDirectory() === true
  if (exists && !options.force) {
    const work = await unsavedWorkOf({ repositoryPath: projectPath, worktreePath: target })
    if (managedWorktreeState({ sessions, ...work }) === 'unsaved') return { status: 'unsaved', ...work }
  }

  try {
    if (exists) await runAsync('git', ['worktree', 'remove', '--force', target], projectPath)
    else await runAsync('git', ['worktree', 'prune'], projectPath)
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  log.info('managed_worktree_removed', { worktreePath: target, forced: options.force })

  const branch = entry.branch
  if (!branch || branch === await getDefaultBranchLocal(projectPath)) return { status: 'removed' }
  try {
    await runAsync('git', ['branch', '-D', branch], projectPath)
    return { status: 'removed' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('managed_worktree_branch_kept', { worktreePath: target, error: message })
    return { status: 'removed', branchError: message }
  }
}

async function removeTaskFolderOf(record: TaskFolderRecord, options: { force: boolean }, host: ManagedWorktreeHost): Promise<ManagedWorktreeRemoveResult> {
  const sessions = await sessionsIn(record.root, host)
  if (sessions.some((session) => session.isBusy)) return { status: 'in_use', sessions }
  if (!options.force) {
    const work = await unsavedWorkOfAll(checkoutsOf(record))
    if (managedWorktreeState({ sessions, ...work }) === 'unsaved') return { status: 'unsaved', ...work }
  }
  // The unsaved work was read above, or the person confirmed its loss: the removal forces.
  const removal = await removeTaskFolder(record.root, { force: true, deleteBranch: true })
    .catch((error: Error) => ({ removed: [], kept: [{ path: record.root, reason: error.message }] }))
  if (removal.kept.length) return { status: 'failed', error: removal.kept.map((each) => `${each.path} ${each.reason}`).join('\n') }
  log.info('managed_task_folder_removed', { root: record.root, forced: options.force })
  return { status: 'removed' }
}

/** The size of each managed worktree or task folder in `folders`. A folder that is neither has no size. */
export async function managedWorktreeSizes(folders: readonly string[], host: ManagedWorktreeHost): Promise<ManagedWorktreeSize[]> {
  return runBounded(folders.map((folder) => async (): Promise<ManagedWorktreeSize> => {
    const target = path.resolve(folder)
    if (!isManaged(target) && !taskFolderAt(target, host)) return { path: folder, bytes: null }
    // `du` does not follow links, so the originals behind a task folder's links do not count.
    const output = await runAsync('du', ['-sk', target], path.dirname(target), { timeout: SIZE_TIMEOUT_MS }).catch(() => null)
    const kilobytes = output ? Number.parseInt(output, 10) : Number.NaN
    return { path: folder, bytes: Number.isFinite(kilobytes) ? kilobytes * 1024 : null }
  }), SIZE_READS)
}
