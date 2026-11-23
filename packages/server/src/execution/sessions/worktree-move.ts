import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { GitCheckout, GitCheckoutBranchResult } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import type { CheckoutService } from '../../git/checkout-service'
import { gitOutputPath, runAsync } from '../../git/exec'
import { resolveRepoRoot } from '../../git/git-helpers'
import { getDefaultBranch } from '../../git/worktree-manager'
import { worktreePathFor } from '../../git/worktree-path'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'

const log = createLogger('worktree', 'worktree-move.ts')

/**
 * Moves a session into another checkout of its repository (docs/worktree-names.md,
 * "Agent worktrees"). One path for the user's "Continue in worktree", the
 * agent's `move_checkout` tool, and the Switch action of a worktree offer: the
 * session's checkout, diff, status, and branch follow, and the next turn forks
 * the provider thread into the new directory (`SessionCheckouts.continueInMovedCheckout`).
 */

export type WorktreeMoveTarget =
  /** A new Solus worktree. `branchName` is the semantic name the branch-naming
   *  settings shape; without one, `namePrompt` names the branch afterwards. */
  | { kind: 'new'; baseBranch?: string; branchName?: string; namePrompt?: string }
  /** A checkout of the session's repository that already exists: a linked
   *  worktree, or the project folder. */
  | { kind: 'existing'; path: string }

export interface WorktreeMoveRequest {
  sessionId: string
  /** The caller's view of the session's directory. The host's binding wins. */
  cwd: string
  target: WorktreeMoveTarget
  actor: Actor
  preferences?: ExecutionPreferences
  /** Aborts the move with its caller, for example an agent turn that stopped. */
  signal?: AbortSignal
}

/**
 * The agent's `move_checkout`: the checkout the session works in next, and the
 * branch that checkout must be on. The host works out the Git steps. A step
 * that changes a checkout runs when the turn that asked for it ends, as T3
 * Code's worktree handoff does: the agent's process still runs in its folder.
 */
export interface AgentMoveRequest extends Omit<WorktreeMoveRequest, 'target'> {
  /** A checkout of the session's repository, by path, or 'new_worktree'. */
  checkout: string
  /** The branch the checkout must be on. Required for an existing checkout;
   *  omitted for a new worktree, the naming settings name a new branch. */
  branch?: string
  /** Only for a branch that does not exist yet: where it starts. Default: the target branch. */
  baseBranch?: string
  /** Remove the linked worktree the session leaves. */
  removeWorktree?: boolean
  /** The prompt that starts the next turn, sent when this turn ends. */
  continueWith?: string
}

export interface AgentMoveResult {
  success: boolean
  error?: string
  /** Where the session works from the next turn. */
  directory?: string
  branch?: string | null
  /** The Git steps that run when this turn ends, in order, as the agent reads them. */
  steps: string[]
  /** The session moves when the steps finish; false when it moved at once. */
  movesAtTurnEnd: boolean
}

/** One Git step of an agent move: what it does, the checkout it changes, and the work. */
interface MoveStep {
  says: string
  /** The checkout whose files the step changes; it must be clean and free. */
  changes?: string
  run: () => Promise<void>
}

interface AgentMoveStart {
  from: string
  fromReal: string
  checkouts: Array<RepositoryCheckout & { real: string | null }>
  projectFolder: string
  leavesWorktree: boolean
  removeFrom: MoveStep
}

type AgentMovePlan =
  | { refusal: string }
  /** The session moves now; the steps (removing the worktree it left) wait. */
  | { moveNow: WorktreeMoveTarget; steps: MoveStep[] }
  /** The steps run when the turn ends, and the session then works in `directory`. */
  | { directory: string; branch: string; steps: MoveStep[]; sameCheckout: boolean; from: string; projectFolder: string }

/** What a move needs from the SessionRuntime, which owns session state. */
export interface WorktreeMoveRuntime {
  readonly checkouts: Pick<CheckoutService, 'create' | 'refresh'>
  getGitContext(sessionId: string): GitCheckout | undefined
  trackWorktreeMove(sessionId: string, controller: AbortController): () => void
  moveSessionCheckout(sessionId: string, directory: string, checkout: GitCheckout): void
  /** The directory each session is bound to. */
  boundDirectories(): Iterable<[sessionId: string, directory: string]>
  /** The session's next turn waits for `finish`; null releases it. */
  holdNextTurn(sessionId: string, finish: (() => Promise<void>) | null): void
  /** Start the session's next turn with `prompt`, the agent's own follow-up. */
  continueSession(sessionId: string, prompt: string): Promise<void>
  recordActivity(subject: ActivitySubject & { kind: 'session' }, actor: Actor, kind: ActivityKind): Promise<Activity>
  nameWorktreeBranch(sessionId: string, checkout: GitCheckout, prompt: string, actor: Actor | undefined, preferences?: ExecutionPreferences): Promise<void>
}

export interface WorktreeStatus {
  /** The directory the session is bound to. */
  directory: string
  /** The host's binding; null before the session's first checkout. */
  checkout: GitCheckout | null
  /** The main checkout first. `holdsSession` marks the one the session is bound to. */
  checkouts: Array<RepositoryCheckout & {
    holdsSession: boolean
    /** Uncommitted changes, as `git status --porcelain` lines. */
    changes: number
    /** The other live sessions bound to this checkout. */
    sessions: string[]
  }>
}

/** Git steps a turn asked for, waiting for that turn to end. */
interface TurnEndMove {
  work: () => Promise<void>
  continueWith?: string
  started?: Promise<string | null>
}

export class WorktreeMover {
  /** The last move per session. A move waits for the one before it. */
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly turnEndMoves = new Map<string, TurnEndMove>()

  constructor(private readonly runtime: WorktreeMoveRuntime) {}

  /** The directory the session is bound to, or the caller's view of it. */
  boundDirectory(sessionId: string, fallback: string): string | null {
    const bound = this.runtime.getGitContext(sessionId)
    const directory = bound?.worktreePath ?? bound?.repoRoot ?? fallback
    // `~` and a new chat's placeholder name no folder yet.
    return directory && directory !== '~' && directory !== NEW_CHAT_DIRECTORY ? resolveHomePath(directory) : null
  }

  /** Where the session is bound and the checkouts of its repository, or null
   *  when the session is not in a git repository. */
  async status(sessionId: string, fallback: string): Promise<WorktreeStatus | null> {
    const directory = this.boundDirectory(sessionId, fallback)
    if (!directory) return null
    const checkouts = await repositoryCheckouts(directory)
    if (checkouts.length === 0) return null
    const realDirectory = await realpathOrNull(directory)
    return {
      directory,
      checkout: this.runtime.getGitContext(sessionId) ?? null,
      checkouts: await Promise.all(checkouts.map(async (checkout) => ({
        ...checkout,
        holdsSession: !!realDirectory && await realpathOrNull(checkout.path) === realDirectory,
        changes: await changedFiles(checkout.path),
        sessions: await this.sessionsIn(checkout.path, sessionId),
      }))),
    }
  }

  move(request: WorktreeMoveRequest): Promise<GitCheckoutBranchResult> {
    return this.queue(request.sessionId, () => this.moveNow(request))
  }

  /**
   * The agent's move. A move that only changes the binding happens at once.
   * Steps that change a checkout wait for the turn to end: the agent's process
   * still runs in its folder until then. The checks run now, so a refusal
   * reaches the agent in this turn, and again before the steps run.
   */
  async moveForAgent(request: AgentMoveRequest): Promise<AgentMoveResult> {
    const plan = await this.agentMovePlan(request)
    if ('refusal' in plan) return refused(plan.refusal)
    const busy = await this.refusalForSteps(plan.steps, request.sessionId)
    if (busy) return refused(busy)
    const { sessionId, continueWith } = request
    const steps = plan.steps.map((step) => step.says)
    if ('moveNow' in plan) {
      const moved = await this.move({ ...request, target: plan.moveNow })
      if (!moved.success || !moved.gitContext) return refused(moved.error ?? 'The move failed.')
      const directory = moved.gitContext.worktreePath ?? moved.gitContext.repoRoot
      if (plan.steps.length > 0 || continueWith) {
        this.holdForTurnEnd(sessionId, { work: () => this.runSteps(plan.steps, sessionId), continueWith })
      }
      return { success: true, directory, branch: moved.gitContext.branch ?? moved.gitContext.detachedHeadSha ?? null, steps, movesAtTurnEnd: false }
    }
    const work = async () => {
      try {
        await this.runSteps(plan.steps, sessionId)
      } catch (error) {
        // A step after the removal of the session's folder failed: work in the project folder, not in a folder that is gone.
        if (!existsSync(plan.from)) await this.bindExisting(request, plan.projectFolder)
        throw error
      }
      // A branch switch in the session's own checkout is no move: the checkout service reads the new branch.
      if (plan.sameCheckout) await this.runtime.checkouts.refresh(plan.directory)
      else await this.bindExisting(request, plan.directory)
    }
    this.holdForTurnEnd(sessionId, { work, continueWith })
    return { success: true, directory: plan.directory, branch: plan.branch, steps, movesAtTurnEnd: true }
  }

  /** The Git steps that bring the session to the checkout and branch it asked for, or why not. */
  private async agentMovePlan(request: AgentMoveRequest): Promise<AgentMovePlan> {
    const start = await this.agentMoveStart(request)
    if ('refusal' in start) return start
    const target = request.checkout === 'new_worktree' ? null : await checkoutOfRepository(start.from, request.checkout)
    if (request.checkout !== 'new_worktree' && !target) return { refusal: `${request.checkout} is not a checkout of this session's repository. checkout_status lists them.` }
    if (target === start.fromReal && request.removeWorktree) return { refusal: 'You cannot remove the worktree you stay in.' }
    const targetBranch = start.checkouts.find((checkout) => checkout.real === target)?.branch ?? null
    // A move to an existing checkout states the branch it ends on, so a checkout on an unexpected branch is never a silent result.
    if (target && !request.branch) {
      return { refusal: `Name the branch ${target} must be on. It is on ${targetBranch ?? 'a detached HEAD'}; pass that branch to keep it.` }
    }
    if (!request.branch || request.branch === targetBranch) return this.plainMovePlan(request, start, target)
    return this.branchMovePlan(request, start, target, request.branch)
  }

  /** Where an agent move starts: the session's checkout, the repository's checkouts, and the step that removes the one it leaves. */
  private async agentMoveStart(request: AgentMoveRequest): Promise<AgentMoveStart | { refusal: string }> {
    if (this.turnEndMoves.has(request.sessionId)) return { refusal: 'A move already waits for this turn to end.' }
    const from = this.boundDirectory(request.sessionId, request.cwd)
    const checkouts = from ? await withRealPaths(await repositoryCheckouts(from)) : []
    const fromReal = from ? await realpathOrNull(from) : null
    const project = checkouts[0]
    if (!from || !fromReal || !project) return { refusal: 'This session is not in a git repository.' }
    const leavesWorktree = fromReal !== project.real
    if (request.removeWorktree && !leavesWorktree) return { refusal: 'This session is in the project folder. There is no worktree to remove.' }
    const removeFrom: MoveStep = { says: `remove the worktree ${from}`, changes: from, run: () => this.removeWorktree(from, project.path) }
    return { from, fromReal, checkouts, projectFolder: project.path, leavesWorktree, removeFrom }
  }

  /** A move that changes no branch: the session moves now. */
  private plainMovePlan(request: AgentMoveRequest, start: AgentMoveStart, target: string | null): AgentMovePlan {
    const steps = request.removeWorktree ? [start.removeFrom] : []
    if (!target) return { moveNow: { kind: 'new', baseBranch: request.baseBranch }, steps }
    if (target === start.fromReal) return { refusal: 'This session is already in that checkout, on that branch.' }
    if (request.baseBranch) return { refusal: 'base_branch applies only to a branch that does not exist yet.' }
    return { moveNow: { kind: 'existing', path: target }, steps }
  }

  /** A move that puts `wanted` in `target`, or in a new worktree when `target` is null. */
  private async branchMovePlan(request: AgentMoveRequest, start: AgentMoveStart, target: string | null, wanted: string): Promise<AgentMovePlan> {
    const { projectFolder } = start
    const validName = await runAsync('git', ['check-ref-format', '--branch', wanted], projectFolder).then(() => true, () => false)
    if (!validName) return { refusal: `${wanted} is not a valid branch name.` }
    const holder = start.checkouts.find((checkout) => checkout.branch === wanted)
    const exists = !!holder || await refExists(projectFolder, `refs/heads/${wanted}`)
    if (exists && request.baseBranch) return { refusal: `${wanted} already exists, so base_branch does not apply.` }
    const sessionTarget = this.runtime.getGitContext(request.sessionId)?.targetBranch || await getDefaultBranch(projectFolder)
    const freeing = holder ? this.freeBranch(request, start, holder, wanted, sessionTarget) : []
    if ('refusal' in freeing) return freeing
    const base = request.baseBranch || sessionTarget
    const from = exists ? null : await startPoint(projectFolder, base)
    if (!exists && !from) return { refusal: `The base branch ${base} does not exist.` }
    const directory = target ?? worktreePathFor(projectFolder, wanted.replace(/\//g, '-'))
    if (!target && existsSync(directory)) return { refusal: `${directory} already exists.` }
    const checkout = target ? switchStep(target, wanted, from) : this.newWorktreeStep(request, projectFolder, directory, wanted, exists ? null : base, sessionTarget)
    const steps = [...freeing, checkout]
    if (request.removeWorktree && !freeing.includes(start.removeFrom)) steps.push(start.removeFrom)
    return { directory, branch: wanted, steps, sameCheckout: directory === start.fromReal, from: start.from, projectFolder }
  }

  /** The step that makes a worktree on `branch`, through the same setup as every
   *  new worktree: start point, `.worktreeinclude` files, and submodules. */
  private newWorktreeStep(request: AgentMoveRequest, projectFolder: string, directory: string, branch: string, base: string | null, sessionTarget: string): MoveStep {
    const run = async () => {
      await this.runtime.checkouts.create(projectFolder, base ?? sessionTarget, {
        naming: request.preferences?.worktreeBranchNaming,
        branch: { name: branch, exists: !base },
      })
    }
    return base
      ? { says: `make a worktree at ${directory} on a new branch ${branch} from ${base}`, run }
      : { says: `make a worktree at ${directory} on ${branch}`, run }
  }

  /**
   * The step that frees `wanted` from the checkout that has it. Git checks a
   * branch out in one checkout at a time, and only the checkout the session
   * leaves can give it up: its worktree is removed, which needs
   * `remove_worktree`, or the project folder goes back to the target branch.
   */
  private freeBranch(request: AgentMoveRequest, start: AgentMoveStart, holder: RepositoryCheckout & { real: string | null }, wanted: string, sessionTarget: string): MoveStep[] | { refusal: string } {
    if (holder.real !== start.fromReal) return { refusal: `${wanted} is checked out in ${holder.path}. Choose that checkout, or another branch.` }
    if (start.leavesWorktree) {
      return request.removeWorktree
        ? [start.removeFrom]
        : { refusal: `${wanted} is checked out in ${start.from}, the worktree you leave. Pass remove_worktree to free it.` }
    }
    if (sessionTarget === wanted) return { refusal: `${wanted} is the target branch, and the project folder must keep it.` }
    return [{ says: `switch the project folder ${start.projectFolder} to ${sessionTarget}`, changes: start.projectFolder, run: () => gitIn(start.projectFolder, ['switch', sessionTarget]) }]
  }

  /** Check every checkout the steps change, then run them in order. */
  private async runSteps(steps: MoveStep[], sessionId: string): Promise<void> {
    const busy = await this.refusalForSteps(steps, sessionId)
    if (busy) throw new Error(busy)
    for (const step of steps) await step.run()
  }

  /** Why one of the checkouts the steps change cannot change now, or null. */
  private async refusalForSteps(steps: MoveStep[], sessionId: string): Promise<string | null> {
    for (const checkout of new Set(steps.flatMap((step) => step.changes ? [step.changes] : []))) {
      const busy = await this.refusalToChange(checkout, sessionId)
      if (busy) return busy
    }
    return null
  }

  /**
   * The turn that asked for a move ended. A completed turn runs what waits and
   * then sends its continuation prompt. A turn that was stopped or failed
   * cancels it: the person or the error ended the work before the move.
   */
  turnSettled(sessionId: string, outcome: 'completed' | 'failed' | 'interrupted' | 'dead'): void {
    const move = this.turnEndMoves.get(sessionId)
    if (!move || move.started) return
    if (outcome !== 'completed') {
      this.turnEndMoves.delete(sessionId)
      this.runtime.holdNextTurn(sessionId, null)
      log.info('session_move_cancelled', { sessionId, outcome })
      return
    }
    void this.finishTurnEndMove(sessionId)
      .then((error) => {
        if (!move.continueWith) return
        const prompt = error ? `The move did not finish: ${error}\n\n${move.continueWith}` : move.continueWith
        return this.runtime.continueSession(sessionId, prompt)
      })
      .catch((error) => log.warn('session_move_continuation_failed', { sessionId, error: error instanceof Error ? error.message : String(error) }))
  }

  private holdForTurnEnd(sessionId: string, move: TurnEndMove): void {
    this.turnEndMoves.set(sessionId, move)
    this.runtime.holdNextTurn(sessionId, async () => { await this.finishTurnEndMove(sessionId) })
  }

  /** Run the steps waiting for the session's turn to end, once. The error, or null. */
  private finishTurnEndMove(sessionId: string): Promise<string | null> {
    const move = this.turnEndMoves.get(sessionId)
    if (!move) return Promise.resolve(null)
    move.started ??= this.queue(sessionId, move.work)
      .then(() => null, (error: Error) => {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('session_move_at_turn_end_failed', { sessionId, error: message })
        return message
      })
      .finally(() => {
        this.turnEndMoves.delete(sessionId)
        this.runtime.holdNextTurn(sessionId, null)
      })
    return move.started
  }

  /** Remove a linked worktree. Git refuses one with uncommitted changes. */
  private async removeWorktree(worktree: string, projectFolder: string): Promise<void> {
    await gitIn(projectFolder, ['worktree', 'remove', worktree])
    log.info('session_left_worktree_removed', { worktreePath: worktree })
  }

  private async bindExisting(request: Omit<WorktreeMoveRequest, 'target'>, directory: string): Promise<void> {
    const checkout = (await this.runtime.checkouts.refresh(directory)).checkout
    if (!checkout) throw new Error(`${directory} has no checkout Solus can read.`)
    await this.bind({ ...request, target: { kind: 'existing', path: directory } }, directory, checkout)
  }

  /** Why the checkout cannot change now, or null: another session works there,
   *  or it has uncommitted changes. */
  private async refusalToChange(directory: string, exceptSessionId: string | null): Promise<string | null> {
    const others = await this.sessionsIn(directory, exceptSessionId)
    if (others.length > 0) return `Another session works in ${directory}.`
    const changes = await changedFiles(directory)
    if (changes > 0) return `${directory} has uncommitted changes (${changes}). Commit them first.`
    return null
  }

  /** The live sessions bound to `directory`, without `exceptSessionId`. */
  private async sessionsIn(directory: string, exceptSessionId: string | null): Promise<string[]> {
    const real = await realpathOrNull(directory)
    if (!real) return []
    const sessions: string[] = []
    for (const [sessionId, bound] of this.runtime.boundDirectories()) {
      if (sessionId !== exceptSessionId && await realpathOrNull(bound) === real) sessions.push(sessionId)
    }
    return sessions
  }

  private queue<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    this.tails.set(sessionId, next)
    void next.catch(() => {}).finally(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId)
    })
    return next
  }

  private async moveNow(request: WorktreeMoveRequest): Promise<GitCheckoutBranchResult> {
    const { sessionId, target } = request
    const boundDirectory = this.boundDirectory(sessionId, request.cwd)
    if (!boundDirectory) return { success: false, error: 'This session has no git repository.' }
    const repoRoot = await resolveRepoRoot(boundDirectory)
    if (!repoRoot) return { success: false, error: 'This session is not in a git repository.' }

    const controller = new AbortController()
    const abortWithCaller = () => controller.abort(request.signal?.reason ?? new Error('Interrupted'))
    if (request.signal?.aborted) abortWithCaller()
    else request.signal?.addEventListener('abort', abortWithCaller, { once: true })
    const release = this.runtime.trackWorktreeMove(sessionId, controller)
    try {
      const target = await this.targetCheckout(request, boundDirectory, controller.signal)
      if ('refusal' in target) return { success: false, error: target.refusal }
      controller.signal.throwIfAborted()
      await this.bind(request, target.directory, target.checkout)
      return { success: true, gitContext: target.checkout }
    } catch (error) {
      const message = controller.signal.aborted ? 'The move was stopped.' : error instanceof Error ? error.message : String(error)
      log.warn('session_move_to_worktree_failed', { sessionId, target: target.kind, error: message })
      return { success: false, error: message }
    } finally {
      request.signal?.removeEventListener('abort', abortWithCaller)
      release()
    }
  }

  /** The checkout the session moves into, or why it cannot move. */
  private async targetCheckout(
    request: WorktreeMoveRequest,
    boundDirectory: string,
    signal: AbortSignal,
  ): Promise<{ directory: string; checkout: GitCheckout } | { refusal: string }> {
    const { target } = request
    const checkouts = await repositoryCheckouts(boundDirectory)
    const projectFolder = checkouts[0]?.path
    if (!projectFolder) return { refusal: 'This session is not in a git repository.' }
    if (target.kind === 'new') {
      // A worktree is made from the main checkout: a linked worktree's `.git` is a file.
      const checkout = await this.runtime.checkouts.create(projectFolder, target.baseBranch || this.runtime.getGitContext(request.sessionId)?.targetBranch, {
        signal,
        naming: request.preferences?.worktreeBranchNaming,
        generatedName: target.branchName || null,
      })
      return checkout?.worktreePath
        ? { directory: checkout.worktreePath, checkout }
        : { refusal: 'The worktree has no checkout Solus can read.' }
    }
    const directory = await checkoutOfRepository(boundDirectory, target.path)
    if (!directory) return { refusal: `${target.path} is not a checkout of this session's repository.` }
    const isProjectFolder = directory === await realpathOrNull(projectFolder)
    if (await realpathOrNull(boundDirectory) === directory) {
      return { refusal: isProjectFolder ? 'This session is already in the project folder.' : 'This session is already in that worktree.' }
    }
    const checkout = (await this.runtime.checkouts.refresh(directory)).checkout
    return checkout ? { directory, checkout } : { refusal: `${directory} has no checkout Solus can read.` }
  }

  /** Bind the session, record the move, and name a new branch. */
  private async bind(request: WorktreeMoveRequest, directory: string, checkout: GitCheckout): Promise<void> {
    const { sessionId, target } = request
    this.runtime.moveSessionCheckout(sessionId, directory, checkout)
    // Recorded before the branch is named: a reader resolves the checkout's current branch by its path.
    const activity: Extract<ActivityKind, { kind: 'moved_to_worktree' }> = { kind: 'moved_to_worktree', path: directory }
    const branch = checkout.branch ?? checkout.detachedHeadSha
    if (branch) activity.branch = branch
    if (!checkout.worktreePath) activity.projectFolder = true
    await this.runtime.recordActivity({ kind: 'session', id: sessionId }, request.actor, activity)
    if (target.kind === 'new' && !target.branchName && target.namePrompt) {
      void this.runtime.nameWorktreeBranch(sessionId, checkout, target.namePrompt, request.actor, request.preferences)
    }
    log.info('session_moved_to_worktree', { sessionId, directory, target: target.kind })
  }
}

function refused(error: string): AgentMoveResult {
  return { success: false, error, steps: [], movesAtTurnEnd: false }
}

/** The step that checks `branch` out in `target`. `from` starts a new branch. */
function switchStep(target: string, branch: string, from: string | null): MoveStep {
  return from
    ? { says: `switch ${target} to a new branch ${branch} from ${from}`, changes: target, run: () => gitIn(target, ['switch', '-c', branch, from]) }
    : { says: `switch ${target} to ${branch}`, changes: target, run: () => gitIn(target, ['switch', branch]) }
}

/** Run one Git step of a move; its error is the step's error. */
async function gitIn(directory: string, args: string[]): Promise<void> {
  await runAsync('git', args, directory)
}

async function refExists(directory: string, ref: string): Promise<boolean> {
  return runAsync('git', ['show-ref', '--verify', '--quiet', ref], directory).then(() => true, () => false)
}

/** Where a new branch starts: the local branch `base`, else `origin/<base>`, else null. */
async function startPoint(directory: string, base: string): Promise<string | null> {
  if (await refExists(directory, `refs/heads/${base}`)) return base
  return await refExists(directory, `refs/remotes/origin/${base}`) ? `origin/${base}` : null
}

async function withRealPaths(checkouts: RepositoryCheckout[]): Promise<Array<RepositoryCheckout & { real: string | null }>> {
  return Promise.all(checkouts.map(async (checkout) => ({ ...checkout, real: await realpathOrNull(checkout.path) })))
}

async function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

/** Uncommitted changes in a checkout, as `git status --porcelain` lines. */
async function changedFiles(directory: string): Promise<number> {
  const output = await runAsync('git', ['status', '--porcelain'], directory).catch(() => '')
  return output.split('\n').filter(Boolean).length
}

export interface RepositoryCheckout {
  path: string
  /** Null for a detached HEAD. */
  branch: string | null
}

/** The checkouts of the repository at `repoDirectory` as `git worktree list`
 *  names them, the main checkout first. Empty outside a repository. */
export async function repositoryCheckouts(repoDirectory: string): Promise<RepositoryCheckout[]> {
  const output = await runAsync('git', ['worktree', 'list', '--porcelain'], repoDirectory).catch(() => '')
  return output.split('\n\n').flatMap((entry) => {
    const lines = entry.split('\n')
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) return []
    const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
    return [{ path: gitOutputPath(repoDirectory, path), branch: ref ? ref.replace(/^refs\/heads\//, '') : null }]
  })
}

/** The real paths of the linked worktrees of the repository at `repoDirectory`.
 *  The main checkout, the first entry, is not one. */
export async function linkedWorktrees(repoDirectory: string): Promise<string[]> {
  const checkouts = await repositoryCheckouts(repoDirectory)
  return realPaths(checkouts.slice(1))
}

/**
 * The linked worktree of the repository at `repoDirectory` that holds
 * `rawPath`, or null. Git answers, not the string: a path counts only when it
 * is, or is inside, a worktree that `git worktree list` names. A relative path
 * is read from `repoDirectory`; `~` is the host user's home.
 */
export async function worktreeOfRepository(repoDirectory: string, rawPath: string): Promise<string | null> {
  return checkoutHolding(repoDirectory, rawPath, await linkedWorktrees(repoDirectory))
}

/** The checkout of the repository at `repoDirectory` — a linked worktree or the
 *  main checkout — that holds `rawPath`, or null. */
export async function checkoutOfRepository(repoDirectory: string, rawPath: string): Promise<string | null> {
  return checkoutHolding(repoDirectory, rawPath, await realPaths(await repositoryCheckouts(repoDirectory)))
}

async function realPaths(checkouts: RepositoryCheckout[]): Promise<string[]> {
  const real = await Promise.all(checkouts.map((checkout) => realpathOrNull(checkout.path)))
  return real.filter((path): path is string => !!path)
}

/** The deepest of `checkouts` that is, or holds, `rawPath`. A linked worktree
 *  can sit inside the main checkout, so the deepest match is the one. */
async function checkoutHolding(repoDirectory: string, rawPath: string, checkouts: string[]): Promise<string | null> {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === NEW_CHAT_DIRECTORY) return null
  const expanded = resolveHomePath(trimmed)
  const requested = await realpathOrNull(isAbsolute(expanded) ? expanded : resolve(repoDirectory, expanded))
  if (!requested) return null
  let match: string | null = null
  for (const checkout of checkouts) {
    const holds = requested === checkout || requested.startsWith(checkout + sep)
    if (holds && (!match || checkout.length > match.length)) match = checkout
  }
  return match
}
