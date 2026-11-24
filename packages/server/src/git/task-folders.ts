import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { TASK_FOLDER_ROOT_NAME, type TaskFolder, type TaskFolderRepository } from '@solus/contracts/codebases'
import { hostPathKey } from '@solus/contracts/host-path'
import type { ProcessUser } from '../cli-env'
import { applyMemberFiles } from '../execution/seats/member-files'
import { folderStateOf, isSubmodule } from '../files/codebase-members'
import { runBounded, runOneAtATime } from '../lib/concurrency'
import { createLogger } from '../logger'
import { isInsideRoot } from '../paths'
import { readWorktreeLayout } from '../project-config/project-config'
import { gitCommitExists, gitOutputPath, runAsync } from './exec'
import { runLayoutCommand } from './task-folder-layout-command'
import { linkPlainFolder, openPlaceInLinks, removeLinks } from './task-folder-links'
import type { TaskFolderPlan } from './task-folder-plan'
import { findTaskFolderContaining, putTaskFolder, removeTaskFolderRecord, type TaskFolderRecord } from './task-folder-store'
import {
  checkOutMissingWorktree, createWorktree, freeBranchName, getWorkingBranch, listProjectWorktrees, localBranchNames,
  type WorktreeSetupStage, type WorktreeStageUpdate,
} from './worktree-manager'

/**
 * The owner of each task folder on this host (docs/plans/codebases.md §7). A
 * task folder is the folder that a worktree session of several repositories
 * works in: one directory that holds a worktree of each chosen repository at
 * the same relative place as the original, so a relative path between two
 * repositories also works between their worktrees.
 *
 * Each change of a task folder goes through this module: `planTaskFolder`,
 * then `createTaskFolder`; `addRepository`, `renameBranch`,
 * `restoreTaskFolder`, and `removeTaskFolder` for one that exists. The
 * changes of one task folder run one at a time.
 */

export { planTaskFolder, type TaskFolderPlan, type TaskFolderPlanInput, type TaskFolderPlanRepository } from './task-folder-plan'
export { findTaskFolderContaining, listTaskFolders, type TaskFolderRecord } from './task-folder-store'

const log = createLogger('TaskFolders', 'task-folders.ts')

/** Checkouts that run at the same time. Each one writes a full working tree. */
const CHECKOUTS_AT_ONE_TIME = 4

/** One checkout of a task folder: a repository and the place of its worktree. */
interface Checkout {
  repositoryPath: string
  worktreePath: string
}

/**
 * The progress of the worktree of one repository, in the stages of
 * `createWorktree`. A repository whose worktree fails reports `error` with
 * the message in `detail`, for the stage that it was in.
 */
export type TaskFolderProgress = (repositoryPath: string, stage: WorktreeSetupStage, update: WorktreeStageUpdate) => void

export interface CreateTaskFolderOptions {
  /**
   * The folder that holds `solus-task-folders`: the data folder, or the member
   * folder of an organization member. The caller resolves it by the rule of a
   * chat (`chatFolderFor`). It must not be a Git repository.
   */
  baseFolder: string
  /** On a host where each member is their own user: the user that makes the folder. */
  member?: ProcessUser | null
  /** The branch of the session. It gets a suffix when it is not free in each repository. */
  branch: string
  /** A repository that has this branch starts from it. Each other one starts from its default branch. */
  baseBranch: string | null
  /** The session that the task folder is made for. The record names it when the creation ends. */
  sessionId?: string
  signal?: AbortSignal
  onRepository?: TaskFolderProgress
}

export interface AddRepositoryOptions {
  /** As for a new task folder. Not used when the repository already has the branch. */
  baseBranch: string | null
  signal?: AbortSignal
  onRepository?: TaskFolderProgress
}

export interface RemoveTaskFolderOptions {
  /** Also remove a worktree that has changes, and each file that exists only in the task folder. */
  force: boolean
  /** Also delete the branch in each repository whose worktree was removed. Without `force`, only a merged branch. */
  deleteBranch?: boolean
}

export interface TaskFolderRemoval {
  removed: string[]
  kept: { path: string; reason: string }[]
}

const samePlace = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)
const messageOf = (error: Parameters<typeof String>[0]): string => (error instanceof Error ? error.message : String(error))

/** The worktrees of a task folder. A worktree is before each one inside it. */
function checkoutsOf(taskFolder: TaskFolder): Checkout[] {
  const primary = taskFolder.primaryIsWorktree ? [{ repositoryPath: taskFolder.primaryRepositoryPath, worktreePath: taskFolder.primaryPath }] : []
  return [...primary, ...taskFolder.repositories].sort((a, b) => a.worktreePath.length - b.worktreePath.length)
}

function taskFolderOf(record: TaskFolderRecord): TaskFolder {
  return {
    root: record.root,
    anchor: record.anchor,
    primaryPath: record.primaryPath,
    primaryRepositoryPath: record.primaryRepositoryPath,
    primaryIsWorktree: record.primaryIsWorktree,
    branch: record.branch,
    repositories: record.repositories,
  }
}

/** The changes of one task folder run one at a time, on its newest record. */
async function changeTaskFolder<T>(root: string, change: (record: TaskFolderRecord) => Promise<T>): Promise<T> {
  const known = findTaskFolderContaining(root)
  if (!known) throw new Error(`${root} is not a task folder of this host.`)
  return runOneAtATime(`task-folder:${hostPathKey(known.root)}`, async () => {
    const record = findTaskFolderContaining(known.root)
    if (!record) throw new Error(`The task folder ${known.root} was removed.`)
    return change(record)
  })
}

async function hasBranch(repositoryPath: string, branch: string): Promise<boolean> {
  return await gitCommitExists(repositoryPath, `refs/heads/${branch}`) || await gitCommitExists(repositoryPath, `refs/remotes/origin/${branch}`)
}

/** The Git directory that each worktree of a repository shares, or null when `folder` is not in a repository. */
async function sharedGitDirectoryOf(folder: string): Promise<string | null> {
  const output = await runAsync('git', ['rev-parse', '--git-common-dir'], folder).catch(() => null)
  if (!output) return null
  try { return realpathSync(gitOutputPath(folder, output)) } catch { return null }
}

/** True when `place` is a linked worktree of `repositoryPath`. A clone has its own `.git` directory. */
async function isLinkedWorktreeOf(place: string, repositoryPath: string): Promise<boolean> {
  if (!(await lstat(path.join(place, '.git')).catch(() => null))?.isFile()) return false
  const [own, shared] = await Promise.all([sharedGitDirectoryOf(place), sharedGitDirectoryOf(repositoryPath)])
  return own !== null && own === shared
}

/** True when nothing is at `place`: no folder, or an empty one. */
async function isEmptyPlace(place: string): Promise<boolean> {
  const entries = await readdir(place).catch(() => null)
  return entries === null || entries.length === 0
}

/** A worktree of `checkout` on the branch of the task folder. A new branch starts from the base branch when the repository has it. */
async function checkOut(
  checkout: Checkout,
  branch: { name: string; exists: boolean },
  options: Pick<CreateTaskFolderOptions, 'baseBranch' | 'signal' | 'onRepository'>,
): Promise<void> {
  const { baseBranch, onRepository } = options
  const base = !branch.exists && baseBranch && await hasBranch(checkout.repositoryPath, baseBranch) ? baseBranch : undefined
  // The stages of this repository that started and did not end, the newest last.
  const openStages = new Set<WorktreeSetupStage>()
  try {
    // `createWorktree` copies the `.worktreeinclude` files, loads the submodules, and removes what it made when it fails.
    await createWorktree(checkout.repositoryPath, base, {
      signal: options.signal,
      branch,
      worktreePath: checkout.worktreePath,
      onStage: onRepository && ((stage, update) => {
        if (update.status === 'active') openStages.add(stage)
        else openStages.delete(stage)
        onRepository(checkout.repositoryPath, stage, update)
      }),
    })
  } catch (error) {
    // The repository that failed names its error. A checkout that a person or a different failure stopped did not fail.
    if (!options.signal?.aborted) {
      onRepository?.(checkout.repositoryPath, [...openStages].at(-1) ?? 'checkout', { status: 'error', detail: messageOf(error) })
    }
    throw error
  }
}

/**
 * The folder of a new task folder: `<base>/solus-task-folders/<branch slug>-<8 hex>`.
 * This call makes it. A folder that is already there is never used.
 */
async function makeRoot(baseFolder: string, branch: string, member: ProcessUser | null): Promise<string> {
  // As for a chat: the agent there would read and change the repository.
  if (existsSync(path.join(baseFolder, '.git'))) throw new Error(`Task folders are off on this host: ${baseFolder} is a Git repository.`)
  const holder = path.join(baseFolder, TASK_FOLDER_ROOT_NAME)
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48) || 'task'
  for (let attempt = 0; attempt < 8; attempt++) {
    const root = path.join(holder, `${slug}-${randomBytes(4).toString('hex')}`)
    if (await lstat(root).catch(() => null)) continue
    if (member) {
      // The member's Git runs as the member, so the folder is theirs (`makeChatFolder`).
      applyMemberFiles(member, [{ kind: 'folder', path: root, mode: 0o2775 }])
      return root
    }
    await mkdir(holder, { recursive: true })
    try {
      await mkdir(root)
      return root
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  }
  throw new Error(`Could not make a task folder in ${holder}.`)
}

/**
 * Make the worktrees of the built-in layout. A worktree inside a different one
 * is made after it. The first failure stops the checkouts that run, and each
 * one that ended is in `made`.
 */
async function checkOutAll(checkouts: readonly Checkout[], branch: string, options: CreateTaskFolderOptions, made: Checkout[]): Promise<void> {
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  const failures: unknown[] = []
  const depthOf = (checkout: Checkout) => checkouts.filter((each) => each !== checkout && isInsideRoot(each.worktreePath, checkout.worktreePath)).length
  const depths = [...new Set(checkouts.map(depthOf))].sort((a, b) => a - b)
  for (const depth of depths) {
    // A task that throws would leave its siblings running during the roll back, so each one keeps its failure.
    await runBounded(checkouts.filter((checkout) => depthOf(checkout) === depth).map((checkout) => async () => {
      if (failures.length > 0) return
      try {
        await checkOut(checkout, { name: branch, exists: false }, { ...options, signal })
        made.push(checkout)
      } catch (error) {
        failures.push(error)
        stop.abort()
      }
    }), CHECKOUTS_AT_ONE_TIME)
    if (failures.length > 0) throw failures[0]
  }
}

/**
 * What a layout command left: each member repository that has a checkout at
 * its place in the task folder. Only a linked worktree of that repository on
 * the branch is adopted. Each other checkout is an error.
 */
async function adoptCheckouts(record: TaskFolderRecord, candidates: readonly string[], names: ReadonlyMap<string, string>): Promise<TaskFolderRepository[]> {
  const adopted: TaskFolderRepository[] = []
  for (const repositoryPath of candidates) {
    const worktreePath = path.join(record.root, path.relative(record.anchor, repositoryPath))
    if (!(await lstat(path.join(worktreePath, '.git')).catch(() => null))) continue
    const isAdoptable = await isLinkedWorktreeOf(worktreePath, repositoryPath) && await getWorkingBranch(worktreePath) === record.branch
    if (!isAdoptable) {
      throw new Error(`The worktree layout command left a checkout at ${worktreePath} that is not a worktree of ${repositoryPath} on the branch ${record.branch}.`)
    }
    adopted.push({ repositoryPath, worktreePath, name: names.get(repositoryPath) ?? path.basename(repositoryPath) })
  }
  return adopted
}

/** Make the layout with the `create` command of the working member, then record what it made. */
async function createWithCommand(command: string, plan: TaskFolderPlan, record: TaskFolderRecord, candidates: readonly string[], options: CreateTaskFolderOptions): Promise<void> {
  await runLayoutCommand({
    command,
    workingMember: plan.workingMember,
    root: record.root,
    primaryPath: record.primaryPath,
    branch: record.branch,
    baseBranch: options.baseBranch,
    repositories: checkoutsOf(record).map((checkout) => checkout.repositoryPath),
    signal: options.signal,
  })
  const adopted = await adoptCheckouts(record, candidates, new Map(plan.repositories.map((repository) => [repository.path, repository.name])))
  const primary = adopted.find((repository) => samePlace(repository.repositoryPath, plan.workingMember))
  if (plan.workingMemberIsRepository && !primary) {
    throw new Error(`The worktree layout command made no worktree of ${plan.workingMember} at ${record.primaryPath}.`)
  }
  if (!(await lstat(record.primaryPath).catch(() => null))?.isDirectory()) {
    throw new Error(`The worktree layout command did not make the working folder ${record.primaryPath}.`)
  }
  record.repositories = adopted.filter((repository) => repository !== primary)
  putTaskFolder(record)
}

/**
 * Remove a creation that failed: each worktree that the repositories have
 * inside the task folder, the branch in each repository of `branchMadeIn`,
 * the folder, and the record. A branch that was there before is not in
 * `branchMadeIn`, so it stays.
 */
async function rollBack(record: TaskFolderRecord, repositories: readonly string[], branchMadeIn: readonly string[], removeCommand: (() => Promise<void>) | null): Promise<void> {
  await removeCommand?.().catch((error) => log.warn('task_folder_layout_remove_failed', { root: record.root, error: messageOf(error) }))
  let realRoot: string
  try { realRoot = realpathSync(record.root) } catch { realRoot = record.root }
  const worktrees = repositories.flatMap((repositoryPath) => listProjectWorktrees(repositoryPath)
    .filter((entry) => isInsideRoot(realRoot, realpathSync(entry.path)))
    .map((entry) => ({ repositoryPath, worktreePath: entry.path })))
  for (const worktree of worktrees.sort((a, b) => b.worktreePath.length - a.worktreePath.length)) {
    await runAsync('git', ['worktree', 'remove', '--force', worktree.worktreePath], worktree.repositoryPath)
      .catch((error) => log.warn('task_folder_rollback_worktree_failed', { root: record.root, worktreePath: worktree.worktreePath, error: messageOf(error) }))
  }
  // A link is only unlinked: `rm` does not follow one.
  await rm(record.root, { recursive: true, force: true })
  for (const repositoryPath of repositories) {
    await runAsync('git', ['worktree', 'prune'], repositoryPath).catch(() => {})
    if (branchMadeIn.includes(repositoryPath)) await runAsync('git', ['branch', '-D', record.branch], repositoryPath).catch(() => {})
  }
  removeTaskFolderRecord(record.root)
}

/**
 * Make the task folder of `plan`. The record is written before the first
 * checkout, so a creation that the host did not finish is found
 * (`listTaskFolders`) and removed. It names its session only when the
 * creation ends. The branch has one name, free in each
 * repository. With `worktreeLayout.create` in the working member's
 * `.solus/config.json`, that command makes the checkouts in place of the
 * built-in layout. A failure removes all that this call made.
 */
export async function createTaskFolder(plan: TaskFolderPlan, options: CreateTaskFolderOptions): Promise<{ taskFolder: TaskFolder; branch: string }> {
  const layout = await readWorktreeLayout(plan.workingMember)
  const planned = [...(plan.workingMemberIsRepository ? [plan.workingMember] : []), ...plan.repositories.map((repository) => repository.path)]
  // A layout command can also make the worktree of a member repository that was not chosen.
  const candidates = layout ? [...planned, ...plan.otherRepositories.filter((repositoryPath) => isInsideRoot(plan.anchor, repositoryPath))] : planned
  const branches = await runBounded(candidates.map((repositoryPath) => () => localBranchNames(repositoryPath)), CHECKOUTS_AT_ONE_TIME)
  const branch = freeBranchName(branches.flat(), options.branch)

  const root = await makeRoot(options.baseFolder, branch, options.member ?? null)
  const placeOf = (memberPath: string) => path.join(root, path.relative(plan.anchor, memberPath))
  const record: TaskFolderRecord = {
    root,
    anchor: plan.anchor,
    primaryPath: placeOf(plan.workingMember),
    primaryRepositoryPath: plan.workingMember,
    primaryIsWorktree: plan.workingMemberIsRepository,
    branch,
    repositories: plan.repositories.map((repository) => ({ repositoryPath: repository.path, worktreePath: placeOf(repository.path), name: repository.name })),
    codebaseId: plan.codebaseId,
    sessionId: null,
    createdAt: Date.now(),
  }
  putTaskFolder(record)
  log.info('task_folder_creating', { root, branch, repositoryCount: planned.length, hasLayoutCommand: !!layout })

  const made: Checkout[] = []
  try {
    if (layout) {
      await createWithCommand(layout.create, plan, record, candidates, options)
    } else {
      await checkOutAll(checkoutsOf(record), branch, options, made)
      // After the worktrees: a working folder inside a chosen repository is in the worktree of that repository.
      if (!plan.workingMemberIsRepository) await linkPlainFolder(plan.workingMember, record.primaryPath, [...planned, ...plan.otherRepositories])
    }
  } catch (error) {
    log.warn('task_folder_create_failed', { root, branch, error: messageOf(error) })
    // The name was free in each candidate, so a branch with it is from this call: from a checkout that ended, or from the command.
    const branchMadeIn = layout ? candidates : made.map((checkout) => checkout.repositoryPath)
    const removeCommand = layout?.remove
    await rollBack(record, candidates, branchMadeIn, removeCommand ? () => runRemoveCommand(removeCommand, record) : null)
    throw error
  }
  if (options.sessionId) {
    // Written last: a record that names a session is a creation that ended.
    record.sessionId = options.sessionId
    putTaskFolder(record)
  }
  log.info('task_folder_created', { root, branch })
  return { taskFolder: taskFolderOf(record), branch }
}

function runRemoveCommand(command: string, record: TaskFolderRecord): Promise<void> {
  return runLayoutCommand({
    command,
    workingMember: record.primaryRepositoryPath,
    root: record.root,
    primaryPath: record.primaryPath,
    branch: record.branch,
    baseBranch: null,
    repositories: checkoutsOf(record).map((checkout) => checkout.repositoryPath),
  })
}

/**
 * Give a repository its worktree in a task folder that a session already
 * works in, on the branch of the task folder. A branch that the repository
 * already has is checked out, not started again. Refused: a repository
 * outside the folder that the task folder stands in for, a submodule, a
 * folder that is not a repository, and a repository that has its worktree.
 */
export function addRepository(root: string, repositoryPath: string, options: AddRepositoryOptions): Promise<TaskFolder> {
  return changeTaskFolder(root, async (record) => {
    if (!isInsideRoot(record.anchor, repositoryPath)) {
      throw new Error(`${repositoryPath} is outside ${record.anchor}, the folder that this task folder stands in for. Start a new session to work in both.`)
    }
    if (await folderStateOf(repositoryPath) !== 'git') throw new Error(`${repositoryPath} is not a Git repository, so it cannot get a worktree.`)
    if (await isSubmodule(repositoryPath)) throw new Error(`${repositoryPath} is a submodule: it comes with the worktree of its parent repository.`)
    if (checkoutsOf(record).some((checkout) => samePlace(checkout.repositoryPath, repositoryPath))) {
      throw new Error(`${repositoryPath} already has its worktree in this task folder.`)
    }
    const worktreePath = path.join(record.root, path.relative(record.anchor, repositoryPath))
    // In the stand-in of a plain working member, the place can be behind a link, and a link is the original.
    const isBehindLinks = !record.primaryIsWorktree && !samePlace(record.primaryPath, worktreePath) && isInsideRoot(record.primaryPath, worktreePath)
    const putLinksBack = isBehindLinks ? await openPlaceInLinks(record.primaryRepositoryPath, record.primaryPath, worktreePath) : null
    try {
      const exists = await gitCommitExists(repositoryPath, `refs/heads/${record.branch}`)
      await checkOut({ repositoryPath, worktreePath }, { name: record.branch, exists }, options)
    } catch (error) {
      await putLinksBack?.().catch((linkError) => log.warn('task_folder_links_not_restored', { root: record.root, worktreePath, error: messageOf(linkError) }))
      throw error
    }
    record.repositories.push({ repositoryPath, worktreePath, name: path.basename(repositoryPath) })
    putTaskFolder(record)
    log.info('task_folder_repository_added', { root: record.root, repositoryPath })
    return taskFolderOf(record)
  })
}

/**
 * Rename the branch of a task folder in each of its worktrees: all of them
 * get the new name, or all keep the old one. Answers the name that was used,
 * which has a suffix when `to` is not free in each repository. Null, with no
 * change, when a worktree is not on `from` or its branch was pushed: someone
 * chose that, and that choice wins (as in `renameWorktreeBranch`).
 */
export function renameBranch(root: string, from: string, to: string): Promise<string | null> {
  return changeTaskFolder(root, async (record) => {
    const checkouts = checkoutsOf(record)
    if (record.branch !== from || checkouts.length === 0) return null
    for (const checkout of checkouts) {
      if (await getWorkingBranch(checkout.worktreePath) !== from) return null
      const hasUpstream = await runAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], checkout.worktreePath).then(() => true, () => false)
      if (hasUpstream) return null
    }
    const branches = await runBounded(checkouts.map((checkout) => () => localBranchNames(checkout.repositoryPath)), CHECKOUTS_AT_ONE_TIME)
    const branch = freeBranchName(branches.flat(), to)
    const renamed: Checkout[] = []
    try {
      for (const checkout of checkouts) {
        await runAsync('git', ['branch', '-m', from, branch], checkout.worktreePath)
        renamed.push(checkout)
      }
    } catch (error) {
      for (const checkout of renamed.reverse()) {
        await runAsync('git', ['branch', '-m', branch, from], checkout.worktreePath)
          .catch((undoError) => log.error('task_folder_branch_rename_undo_failed', { root: record.root, worktreePath: checkout.worktreePath, error: messageOf(undoError) }))
      }
      throw error
    }
    record.branch = branch
    putTaskFolder(record)
    log.info('task_folder_branch_renamed', { root: record.root, from, branch })
    return branch
  })
}

/**
 * Put back what is missing in a task folder: a worktree whose folder is gone
 * is checked out again on the branch, and the links of a plain working member
 * are made again. A checkout at the place of a worktree that is not a
 * worktree of its repository is an error; it is never changed. With a layout
 * command, `worktreeLayout.create` runs again when something is missing.
 *
 * `memberRepositories` are the repositories of the session's codebase that
 * have no worktree here. As at the creation, their places get no link.
 */
export function restoreTaskFolder(taskFolder: TaskFolder, memberRepositories: readonly string[] = []): Promise<void> {
  return changeTaskFolder(taskFolder.root, async (record) => {
    const missing: Checkout[] = []
    for (const checkout of checkoutsOf(record)) {
      if (await isEmptyPlace(checkout.worktreePath)) missing.push(checkout)
      else if (!(await isLinkedWorktreeOf(checkout.worktreePath, checkout.repositoryPath))) {
        throw new Error(`${checkout.worktreePath} is not a worktree of ${checkout.repositoryPath}, so Solus did not change it. Move it away, then try again.`)
      }
    }
    const layout = await readWorktreeLayout(record.primaryRepositoryPath)
    const isPrimaryMissing = !(await lstat(record.primaryPath).catch(() => null))
    await mkdir(record.root, { recursive: true })
    if (layout) {
      if (missing.length === 0 && !isPrimaryMissing) return
      await runLayoutCommand({
        command: layout.create,
        workingMember: record.primaryRepositoryPath,
        root: record.root,
        primaryPath: record.primaryPath,
        branch: record.branch,
        baseBranch: null,
        repositories: checkoutsOf(record).map((checkout) => checkout.repositoryPath),
      })
      for (const checkout of missing) {
        if (!(await isLinkedWorktreeOf(checkout.worktreePath, checkout.repositoryPath))) {
          throw new Error(`The worktree layout command did not put back the worktree of ${checkout.repositoryPath} at ${checkout.worktreePath}.`)
        }
      }
      return
    }
    for (const checkout of missing) {
      if (!existsSync(checkout.repositoryPath)) throw new Error(`The repository ${checkout.repositoryPath} is gone, so its worktree at ${checkout.worktreePath} cannot come back.`)
      await checkOutMissingWorktree(checkout.repositoryPath, record.branch, checkout.worktreePath)
    }
    if (!record.primaryIsWorktree) {
      const unlinked = [...record.repositories.map((repository) => repository.repositoryPath), ...memberRepositories]
      await linkPlainFolder(record.primaryRepositoryPath, record.primaryPath, unlinked)
    }
    if (missing.length > 0) log.info('task_folder_restored', { root: record.root, restoredCount: missing.length })
  })
}

/** Why a worktree stays when the removal is not forced, or null when it can go. */
async function reasonToKeep(checkout: Checkout, kept: TaskFolderRemoval['kept']): Promise<string | null> {
  const { repositoryPath, worktreePath } = checkout
  const holdsKept = kept.find((each) => isInsideRoot(worktreePath, each.path))
  if (holdsKept) return `holds ${holdsKept.path}, which was kept`
  if (!(await isLinkedWorktreeOf(worktreePath, repositoryPath))) return `is not a worktree of ${repositoryPath}`
  const status = await runAsync('git', ['status', '--porcelain'], worktreePath).catch(() => null)
  if (status === null) return 'Git could not read its changes'
  return status ? 'has uncommitted changes' : null
}

/** Remove one worktree of a task folder, or keep it with its reason. */
async function removeCheckout(checkout: Checkout, branch: string, removal: TaskFolderRemoval, options: RemoveTaskFolderOptions): Promise<void> {
  const { repositoryPath, worktreePath } = checkout
  // An empty folder is a worktree that was not made, or one that is gone.
  if (!(await isEmptyPlace(worktreePath))) {
    const reason = options.force ? null : await reasonToKeep(checkout, removal.kept)
    if (reason) {
      removal.kept.push({ path: worktreePath, reason })
      return
    }
    // The changes were read above, so `--force` here is only for the submodules, which Git does not remove without it.
    await runAsync('git', ['worktree', 'remove', '--force', worktreePath], repositoryPath)
      .catch(() => rm(worktreePath, { recursive: true, force: true }))
    removal.removed.push(worktreePath)
  }
  await runAsync('git', ['worktree', 'prune'], repositoryPath).catch(() => {})
  if (options.deleteBranch) {
    await runAsync('git', ['branch', options.force ? '-D' : '-d', branch], repositoryPath)
      .catch((error) => log.info('task_folder_branch_kept', { repositoryPath, branch, error: messageOf(error) }))
  }
}

/**
 * Remove a task folder: the worktrees, the deepest first; then the links of a
 * plain working member; then the folder and the record. Without `force`, a
 * worktree that has uncommitted changes stays, with its reason, and so does a
 * file that exists only in the task folder. The folders that hold them stay,
 * and the record then holds only what stayed. A link is only unlinked: the
 * original is not changed. `worktreeLayout.remove` runs first, and what it
 * leaves is removed here.
 */
export function removeTaskFolder(root: string, options: RemoveTaskFolderOptions): Promise<TaskFolderRemoval> {
  if (!findTaskFolderContaining(root)) return Promise.resolve({ removed: [], kept: [] })
  return changeTaskFolder(root, async (record) => {
    const layout = await readWorktreeLayout(record.primaryRepositoryPath)
    if (layout?.remove) {
      await runRemoveCommand(layout.remove, record)
        .catch((error) => log.warn('task_folder_layout_remove_failed', { root: record.root, error: messageOf(error) }))
    }
    const removal: TaskFolderRemoval = { removed: [], kept: [] }
    for (const checkout of checkoutsOf(record).reverse()) await removeCheckout(checkout, record.branch, removal, options)
    if (options.force) {
      await rm(record.root, { recursive: true, force: true })
    } else if (!removal.kept.some((each) => samePlace(each.path, record.root))) {
      const realFiles = await removeLinks(record.root, removal.kept.map((each) => each.path))
      removal.kept.push(...realFiles.map((file) => ({ path: file, reason: 'exists only in the task folder' })))
    }
    if (await lstat(record.root).catch(() => null)) {
      record.repositories = record.repositories.filter((repository) => removal.kept.some((each) => samePlace(each.path, repository.worktreePath)))
      putTaskFolder(record)
    } else {
      if (!removal.removed.some((each) => samePlace(each, record.root))) removal.removed.push(record.root)
      removeTaskFolderRecord(record.root)
    }
    log.info('task_folder_removed', { root: record.root, removedCount: removal.removed.length, keptCount: removal.kept.length })
    return removal
  })
}
