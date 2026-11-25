import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CodebaseMember, SessionFolder, TaskFolder } from '@solus/contracts/codebases'
import { isTaskFolderPath } from '@solus/contracts/codebases'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import { isSessionBusyStatus, type GitCheckout, type StatusCardSubstep } from '@solus/contracts/types'
import {
  generatedWorktreeBranchName, initialWorktreeBranchName, temporaryWorktreeBranchId, type WorktreeBranchNaming,
} from '@solus/contracts/worktree-branch-naming'
import type { Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { codebasesFor } from '../../data/codebases/codebases'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { organizationOfSession } from '../../data/sessions/session-records'
import { getIndexedSession, indexedTaskFolderDirectories } from '../../db/session-indexer'
import { membersOf } from '../../files/codebase-members'
import {
  addRepository, createTaskFolder, findTaskFolderContaining, listTaskFolders, planTaskFolder, removeTaskFolder, renameBranch, restoreTaskFolder, taskFolderBaseRef,
  type TaskFolderPlan, type TaskFolderProgress, type TaskFolderRecord, type TaskFolderRemoval,
} from '../../git/task-folders'
import { captureWorktreeBranchNaming, capturedWorktreeBranchNamer, resolveWorktreeBranchNamer } from '../../git/worktree-branch-name'
import { getDefaultBranch, type WorktreeSetupStage, type WorktreeStageUpdate } from '../../git/worktree-manager'
import { generateWorktreeName } from '../../git/worktree-name'
import { createLogger } from '../../logger'
import { isInsideRoot, realPathOf } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import { taskFolderBaseFor } from '../../workspace'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'session-task-folders.ts')

/** What the start of a turn knows about a new worktree session. */
export interface TaskFolderTurn {
  /** The codebase that the turn names. A session that has its codebase keeps it. */
  codebaseId?: string | null
  /** The project folder of the session: the member that it works in. */
  projectFolder: string
  /** The member paths that a person chose, or null for the default set. */
  repositories: readonly string[] | null
  actor: Actor
}

export interface CreateSessionTaskFolder {
  actor: Actor
  /** The person's naming. The config of the working member still wins. */
  naming?: WorktreeBranchNaming
  /** A name that a model made already. Without one the branch starts with its temporary name. */
  generatedName?: string | null
  /** A new branch that the caller names, used as it is. The naming does not apply. */
  exactBranch?: string
  baseBranch: string | null
  siblingBaseBranch?: string | null
  signal?: AbortSignal
  onRepository?: TaskFolderProgress
}

export interface CreatedSessionTaskFolder {
  taskFolder: TaskFolder
  /** The checkout of the working directory. Null when the working member is a plain folder. */
  checkout: GitCheckout | null
}

const messageOf = (error: Parameters<typeof String>[0]): string => (error instanceof Error ? error.message : String(error))

/** The worktrees of a task folder, the one of the working member first. */
function checkoutsOf(taskFolder: TaskFolder): { repositoryPath: string; worktreePath: string }[] {
  return [
    ...(taskFolder.primaryIsWorktree ? [{ repositoryPath: taskFolder.primaryRepositoryPath, worktreePath: taskFolder.primaryPath }] : []),
    ...taskFolder.repositories,
  ]
}

/** One change to a step of the setup card of a task folder. A setup of several repositories gives the part of each one. */
export interface TaskFolderStageUpdate extends WorktreeStageUpdate {
  substeps?: StatusCardSubstep[]
}

/** The state of a step from the parts of its repositories: it runs until each repository ended it. */
function stepStatusOf(substeps: readonly StatusCardSubstep[]): TaskFolderStageUpdate['status'] {
  if (substeps.some((substep) => substep.status === 'pending' || substep.status === 'active')) return 'active'
  if (substeps.some((substep) => substep.status === 'warning')) return 'warning'
  return substeps.every((substep) => substep.status === 'skipped') ? 'skipped' : 'done'
}

/** Give a sub-step its new state, with the times of the host. A skipped sub-step did no work, so it has no times. */
function setSubstep(substep: StatusCardSubstep, update: Pick<WorktreeStageUpdate, 'status' | 'detail'>, now: number): void {
  substep.status = update.status
  if (update.status === 'skipped') {
    delete substep.startedAt
    delete substep.endedAt
  } else {
    substep.startedAt ??= now
    if (update.status !== 'active') substep.endedAt = now
  }
  if (update.detail) substep.detail = update.detail
}

/**
 * One setup card for the worktrees of several repositories. Each step that
 * the host runs one time for each repository gets one sub-step for each
 * repository, from the first report of that step: the state of the
 * repository, its times on the clock of the host, and the detail of its
 * warning. The step is active until each repository ended it. The repository
 * that fails names the error in its sub-step. Each sub-step that ran at that
 * time did not end, so it is an error with no detail, as the launch does for
 * the steps. A setup of one repository has no sub-steps: its reports go to
 * the card as they are.
 */
export function taskFolderStages(
  repositories: readonly { path: string; name: string }[],
  onStage: (stage: WorktreeSetupStage, update: TaskFolderStageUpdate) => void,
  /** The files of one repository are checked out: its name, and how many repositories have theirs. */
  onCheckedOut?: (name: string, count: number) => void,
): TaskFolderProgress {
  if (repositories.length < 2) {
    return (repositoryPath, stage, update) => {
      // A failure is the error of the launch: the card gets it there, with its message.
      if (update.status === 'error') return
      if (stage === 'checkout' && update.status === 'done') onCheckedOut?.(repositories[0]?.name ?? repositoryPath, 1)
      onStage(stage, update)
    }
  }
  const stages = new Map<WorktreeSetupStage, StatusCardSubstep[]>()
  const substepsOf = (stage: WorktreeSetupStage): StatusCardSubstep[] => {
    const known = stages.get(stage)
    if (known) return known
    const substeps = repositories.map((repository): StatusCardSubstep => ({ id: repository.path, label: repository.name, status: 'pending' }))
    stages.set(stage, substeps)
    return substeps
  }
  // The card gets a copy: a later report changes the sub-steps here.
  const report = (stage: WorktreeSetupStage, status: TaskFolderStageUpdate['status']): void => {
    onStage(stage, { status, substeps: substepsOf(stage).map((substep) => ({ ...substep })) })
  }
  /** The sub-step of the repository is an error with its message, and so is each sub-step that ran, with no message. */
  const fail = (failed: StatusCardSubstep, stage: WorktreeSetupStage, detail: string | undefined, now: number): void => {
    const stopped = new Set([stage])
    for (const [openStage, substeps] of stages) {
      for (const open of substeps.filter((substep) => substep.status === 'active' && substep !== failed)) {
        setSubstep(open, { status: 'error' }, now)
        stopped.add(openStage)
      }
    }
    setSubstep(failed, { status: 'error', detail }, now)
    // The steps stay active: the launch ends them, after the creation is rolled back.
    for (const stoppedStage of stopped) report(stoppedStage, 'active')
  }
  let hasFailed = false
  return (repositoryPath, stage, update) => {
    const substeps = substepsOf(stage)
    const substep = substeps.find((each) => each.id === repositoryPath)
    // A checkout that the failure stopped can report after it. The files of a
    // checkout report many times a second, and the state of the repository is the same.
    if (hasFailed || !substep || substep.status === update.status) return
    if (update.status === 'error') {
      hasFailed = true
      fail(substep, stage, update.detail, Date.now())
      return
    }
    setSubstep(substep, update, Date.now())
    if (stage === 'checkout' && update.status === 'done') {
      onCheckedOut?.(substep.label, substeps.filter((each) => each.status === 'done').length)
    }
    report(stage, stepStatusOf(substeps))
  }
}

/**
 * The task folder of each session (docs/plans/codebases.md §7): this owner
 * connects a session to `git/task-folders.ts`, which owns each change of a
 * task folder. It decides when a new worktree session gets one, gives the
 * module what it needs from the session (its codebase, its person, its base
 * folder, its branch name), and keeps the session's folders and checkouts
 * current after a change.
 */
export class SessionTaskFolders {
  /** The task folder that this process made for a session, by session id, until the session leaves it. */
  private readonly made = new Map<string, string>()
  /** The removal of the task folders that no session names, at the start of the host. A creation waits for it. */
  private swept: Promise<void> = Promise.resolve()

  constructor(private readonly rt: SessionRuntime) {}

  /**
   * The task folder that a session works in, or null. The first place that is
   * known decides: the task folder this process made for it, the checkout it
   * is bound to, the directory of its live run, then the directory of its record.
   */
  ofSession(sessionId: string): TaskFolderRecord | null {
    const directory = this.made.get(sessionId)
      ?? this.rt.sessionCheckouts.sessionCheckoutPaths.get(sessionId)
      ?? this.rt.activeSessions.get(sessionId)?.runInput?.workingDirectory
      ?? resolveSessionLineageById(sessionId)?.active.cwd
      ?? getIndexedSession(sessionId)?.cwd
    return directory && isTaskFolderPath(directory) ? findTaskFolderContaining(directory) : null
  }

  /**
   * The task folder that a turn continues in, or null. `directory` is where
   * the turn says the session works. A session whose working member is a plain
   * folder has no checkout that a client can send back, so its client names
   * the member (`projectFolder`): the session then works in the folder that
   * stands in for that member.
   */
  ofTurn(sessionId: string, directory: string | null | undefined, projectFolder: string | null | undefined): TaskFolderRecord | null {
    if (directory && isTaskFolderPath(directory)) return findTaskFolderContaining(directory)
    const known = this.ofSession(sessionId)
    if (!known || known.primaryIsWorktree || !projectFolder) return null
    return resolve(resolveHomePath(projectFolder)) === resolve(known.primaryRepositoryPath) ? known : null
  }

  /**
   * The plan of the task folder of a new worktree session, or null when the
   * session gets a worktree inside its repository, as before: a session with
   * no codebase, a project folder that is not a member of the codebase on
   * this host, and a repository with no other repository chosen. A project
   * is one folder, so a session with no codebase has one checkout. A session
   * in a container works in its codebase (decision 14), so its plan has each
   * repository of the container. A choice that cannot be made is an error
   * with the reason for the person.
   */
  async plan(sessionId: string, turn: TaskFolderTurn): Promise<TaskFolderPlan | null> {
    const codebaseId = await this.rt.sessionFolders.codebaseIdForTurn(sessionId, turn.codebaseId)
    const members = codebaseId ? await this.membersOf(codebaseId, turn.actor) : []
    if (!codebaseId || members.length === 0) return null
    const projectFolder = await realPathOf(resolveHomePath(turn.projectFolder))
    let workingMember: CodebaseMember | null = null
    for (const member of members) {
      if (member.state !== 'missing' && await realPathOf(member.path) === projectFolder) { workingMember = member; break }
    }
    if (!workingMember) {
      log.info('task_folder_not_planned', { sessionId, codebaseId, reason: 'project_folder_is_not_a_member' })
      return null
    }
    return planTaskFolder({ codebaseId, workingMember: workingMember.path, members, repositories: turn.repositories })
  }

  /**
   * Make the task folder of `plan` for a session. The branch gets its first
   * name as the branch of a new worktree does: the name that a model made, else
   * the temporary name of the naming. The naming is kept with the branch, so
   * the later rename from the title uses it.
   */
  async create(sessionId: string, plan: TaskFolderPlan, options: CreateSessionTaskFolder): Promise<CreatedSessionTaskFolder> {
    // The sweep removes each task folder of an interrupted creation, and a creation in progress looks like one.
    await this.swept
    options.signal?.throwIfAborted()
    const namer = await resolveWorktreeBranchNamer(plan.workingMember, options.naming)
    const branchId = randomBytes(4).toString('hex')
    const firstName = options.exactBranch
      ?? (options.generatedName ? generatedWorktreeBranchName(options.generatedName, namer, branchId) : null)
      ?? initialWorktreeBranchName(namer, branchId)
    const { taskFolder, branch } = await createTaskFolder(plan, {
      ...taskFolderBaseFor(options.actor.principal),
      branch: firstName,
      baseBranch: options.baseBranch,
      siblingBaseBranch: options.siblingBaseBranch,
      sessionId,
      signal: options.signal,
      onRepository: options.onRepository,
    })
    this.made.set(sessionId, taskFolder.root)
    const namingRepository = options.exactBranch ? null : namingRepositoryOf(taskFolder)
    if (namingRepository) {
      await captureWorktreeBranchNaming(namingRepository.repositoryPath, branch, namer.naming)
        .catch((error) => log.warn('task_folder_naming_capture_failed', { sessionId, branch, error: messageOf(error) }))
    }
    log.info('session_task_folder_created', { sessionId, root: taskFolder.root, branch, repositoryCount: checkoutsOf(taskFolder).length })
    if (!taskFolder.primaryIsWorktree) return { taskFolder, checkout: null }
    const repository = taskFolder.primaryRepositoryPath
    const targetBranch = await taskFolderBaseRef(repository, options.baseBranch) ?? await getDefaultBranch(repository)
    return { taskFolder, checkout: { branch, targetBranch, worktreePath: taskFolder.primaryPath, repoRoot: repository } }
  }

  /** True when a new worktree for a session in `projectFolder` is a task folder. */
  async plansFor(sessionId: string, projectFolder: string, actor: Actor): Promise<boolean> {
    return await this.plan(sessionId, { projectFolder, repositories: null, actor }).then((plan) => plan !== null, () => false)
  }

  /**
   * A new worktree for a session that moves (`WorktreeMover`): the task folder
   * of its plan, with the default set of repositories, as a checkout that the
   * checkout service knows. Null when the session gets one worktree inside
   * its repository, as before.
   */
  async createForMove(sessionId: string, projectFolder: string, options: CreateSessionTaskFolder): Promise<GitCheckout | null> {
    const plan = await this.plan(sessionId, { projectFolder, repositories: null, actor: options.actor })
    if (!plan) return null
    const { taskFolder, checkout } = await this.create(sessionId, plan, options)
    // A session that moves is in a repository, so its working member is one.
    return checkout && this.rt.checkouts.attach(taskFolder.primaryPath, checkout)
  }

  /**
   * Replace the temporary branch of a task folder with a name made from the
   * prompt, in each repository or in none. As for one worktree, this runs
   * beside the first turn of the agent and only logs a failure: the temporary
   * branch is a correct branch.
   */
  async nameBranch(sessionId: string, root: string, prompt: string, actor: Actor | undefined, preferences?: ExecutionPreferences): Promise<void> {
    const record = findTaskFolderContaining(root)
    if (!record) return
    try {
      const from = record.branch
      const namingRepository = namingRepositoryOf(record)
      const namer = (namingRepository && await capturedWorktreeBranchNamer(namingRepository.worktreePath, from))
        ?? await resolveWorktreeBranchNamer(record.primaryRepositoryPath, preferences?.worktreeBranchNaming)
      // Ask the model only when the naming the task folder was made with uses its answer.
      const branchId = temporaryWorktreeBranchId(from, namer)
      if (!branchId) return
      const name = await generateWorktreeName(this.rt, prompt, record.primaryPath, undefined, (provider) => this.rt.seatForTurn(actor, provider), preferences, await organizationOfSession(sessionId))
      const to = name ? generatedWorktreeBranchName(name, namer, branchId) : null
      if (!to) return
      const branch = await renameBranch(record.root, from, to)
      if (!branch) return
      log.info('session_task_folder_branch_renamed', { sessionId, root: record.root, from, branch })
      await this.rereadCheckouts(record)
    } catch (error) {
      log.warn('task_folder_branch_rename_failed', { sessionId, root, error: messageOf(error) })
    }
  }

  /** True when a worktree, or the working folder, of the task folder is not on the disk. */
  private isIncomplete(taskFolder: TaskFolder): boolean {
    return !existsSync(taskFolder.primaryPath) || checkoutsOf(taskFolder).some((checkout) => !existsSync(join(checkout.worktreePath, '.git')))
  }

  /** Put back what is missing in the task folder of a session, before its next turn starts there. A task folder that has all its parts is not changed. */
  async restore(sessionId: string, taskFolder: TaskFolder, actor: Actor): Promise<void> {
    if (!this.isIncomplete(taskFolder)) return
    const others = await this.repositoriesWithoutWorktree(sessionId, taskFolder, actor)
    await restoreTaskFolder(taskFolder, others.map((member) => member.path))
    log.info('session_task_folder_restored', { sessionId, root: taskFolder.root })
    await this.rereadCheckouts(taskFolder)
  }

  /**
   * The repositories of the session's codebase on this host that can get a
   * worktree in the task folder of the session and have none. Empty for a
   * session that is not in a task folder.
   */
  async candidates(sessionId: string, actor: Actor): Promise<CodebaseMember[]> {
    const taskFolder = this.ofSession(sessionId)
    if (!taskFolder) return []
    const others = await this.repositoriesWithoutWorktree(sessionId, taskFolder, actor)
    // What `addRepository` refuses is not offered: no commit, a submodule, and a place outside the task folder.
    return others.filter((member) => member.hasCommit && !member.submodule && isInsideRoot(taskFolder.anchor, member.path))
  }

  /**
   * Give a repository of the session's codebase its worktree in the task
   * folder of the session, on the branch of the session, and publish the new
   * folders. Refused for a session that is not in a task folder, and for a
   * path that is not a repository of its codebase.
   */
  async addRepository(sessionId: string, repositoryPath: string, actor: Actor): Promise<SessionFolder[]> {
    const taskFolder = this.ofSession(sessionId)
    if (!taskFolder) {
      throw new Error('This session works in one worktree inside its repository, which cannot hold a second repository. Start a new worktree session to work in more than one repository.')
    }
    const wanted = await realPathOf(resolveHomePath(repositoryPath))
    let member: CodebaseMember | null = null
    for (const each of await this.repositoriesWithoutWorktree(sessionId, taskFolder, actor)) {
      if (await realPathOf(each.path) === wanted) { member = each; break }
    }
    if (!member) throw new Error(`${repositoryPath} is not a repository of this session's codebase that has no worktree in its task folder.`)
    // A repository that has the base branch of the session starts from it, as at the creation.
    const baseBranch = this.rt.sessionCheckouts.getGitContext(sessionId)?.targetBranch ?? null
    await addRepository(taskFolder.root, member.path, { baseBranch })
    log.info('session_task_folder_repository_added', { sessionId, root: taskFolder.root, repositoryPath: member.path })
    return this.rt.sessionFolders.reread(sessionId, actor)
  }

  /**
   * A session leaves its task folder and asks to remove it. The task folder
   * stays when a different session works in it. A worktree that has uncommitted
   * changes stays, with its reason, and so does a file that exists only in
   * the task folder.
   */
  async leave(sessionId: string, root: string, options: { deleteBranch?: boolean } = {}): Promise<TaskFolderRemoval> {
    const record = findTaskFolderContaining(root)
    if (!record) return { removed: [], kept: [] }
    const others = this.sessionsIn(record, sessionId)
    if (others.length > 0) {
      return { removed: [], kept: [{ path: record.root, reason: `${others.length === 1 ? 'a different session works' : `${others.length} different sessions work`} in it` }] }
    }
    this.made.delete(sessionId)
    const removal = await removeTaskFolder(record.root, { force: false, deleteBranch: options.deleteBranch })
    log.info('session_task_folder_left', { sessionId, root: record.root, removedCount: removal.removed.length, keptCount: removal.kept.length })
    return removal
  }

  /**
   * At the start of the host: remove each task folder that no session names.
   * That is a creation that the last process did not finish, or one whose
   * session did not start. A session names a task folder when its index has a
   * working directory there. A session that moved into a new task folder has
   * that directory in its index only after its next turn, so the record of
   * the task folder names that session (`sessionId`), and the folder stays
   * while the index knows the session. A worktree with changes stays. A
   * creation in this process waits for this to end. No person asked for this
   * work, so the caller runs it in the scope of the host.
   */
  sweepUnnamed(): Promise<void> {
    this.swept = (async () => {
      const named = indexedTaskFolderDirectories()
      for (const record of listTaskFolders()) {
        if (named.some((session) => isNamedBy(record, session.cwd))) continue
        if (record.sessionId && isIndexedSession(record.sessionId)) continue
        try {
          const removal = await removeTaskFolder(record.root, { force: false })
          log.info('task_folder_swept', { root: record.root, removedCount: removal.removed.length, keptCount: removal.kept.length })
        } catch (error) {
          log.warn('task_folder_sweep_failed', { root: record.root, error: messageOf(error) })
        }
      }
      // A failure of the sweep does not stop the host: a task folder that it left stays until the next start.
    })().catch((error) => log.warn('task_folders_sweep_failed', { error: messageOf(error) }))
    return this.swept
  }

  /**
   * The other sessions that work in a task folder now: bound to a checkout in
   * it, in a turn there, or given it by this process. As for one worktree, a
   * session that only its record names does not keep the task folder.
   */
  private sessionsIn(record: TaskFolderRecord, exceptSessionId: string): string[] {
    const sessions = new Set<string>()
    for (const [sessionId, directory] of this.rt.sessionCheckouts.sessionCheckoutPaths) {
      if (isNamedBy(record, directory)) sessions.add(sessionId)
    }
    for (const [sessionId, session] of this.rt.activeSessions) {
      const directory = session.runInput?.workingDirectory
      if (directory && isSessionBusyStatus(session.status) && isNamedBy(record, directory)) sessions.add(sessionId)
    }
    for (const [sessionId, root] of this.made) {
      if (root === record.root) sessions.add(sessionId)
    }
    sessions.delete(exceptSessionId)
    return [...sessions]
  }

  /** The `git` members of the session's codebase on this host that have no worktree in `taskFolder`. */
  private async repositoriesWithoutWorktree(sessionId: string, taskFolder: TaskFolder, actor: Actor): Promise<CodebaseMember[]> {
    const codebaseId = await this.rt.sessionFolders.codebaseIdOf(sessionId)
    if (!codebaseId) return []
    const held = new Set(await Promise.all(checkoutsOf(taskFolder).map((checkout) => realPathOf(checkout.repositoryPath))))
    const without: CodebaseMember[] = []
    for (const member of await this.membersOf(codebaseId, actor)) {
      if (member.state === 'git' && !held.has(await realPathOf(member.path))) without.push(member)
    }
    return without
  }

  private async membersOf(codebaseId: string, actor: Actor): Promise<CodebaseMember[]> {
    const codebase = await codebasesFor(actor).get(codebaseId)
    return codebase && codebase.deletedAt === null ? membersOf(codebase, getInstallationId()) : []
  }

  /** The checkout service reads each worktree again: its listeners tell the sessions that work there. */
  private async rereadCheckouts(taskFolder: TaskFolder): Promise<void> {
    for (const checkout of checkoutsOf(taskFolder)) {
      if (!this.rt.checkouts.get(checkout.worktreePath)) continue
      await this.rt.checkouts.refresh(checkout.worktreePath)
        .catch((error) => log.warn('task_folder_checkout_refresh_failed', { cwd: checkout.worktreePath, error: messageOf(error) }))
    }
  }
}

/** The worktree whose branch keeps the naming of the task folder: the one of the working member, else the first one. */
function namingRepositoryOf(taskFolder: TaskFolder): { repositoryPath: string; worktreePath: string } | null {
  return checkoutsOf(taskFolder)[0] ?? null
}

/** True when a turn of the session reached its provider on this host: the session has a place in the index. */
function isIndexedSession(sessionId: string): boolean {
  return resolveSessionLineageById(sessionId) !== null || getIndexedSession(sessionId) !== null
}

/** True when `directory` is in the task folder, in the spelling Solus made or in the one after links are resolved. */
function isNamedBy(record: TaskFolderRecord, directory: string): boolean {
  return isTaskFolderPath(directory) && findTaskFolderContaining(directory)?.root === record.root
}
