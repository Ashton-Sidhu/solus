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
import { getWorkingBranch } from '../../git/worktree-manager'
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
  /** The repository's main checkout. */
  | { kind: 'project-folder' }

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
 * What the agent's `move_checkout` adds to a move. These steps change the
 * folder the agent's process still runs in, so they run when the turn that
 * asked for them ends, as T3 Code's worktree handoff does.
 */
export interface AgentMoveOptions {
  /** Take the session's branch along: from a linked worktree into the project
   *  folder, or from the project folder into a new worktree. */
  bringBranch?: boolean
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
  /** The move, or part of it, runs when this turn ends. */
  atTurnEnd: boolean
}

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
   * Taking the branch along or removing the worktree left behind waits for the
   * turn to end: the agent's process still runs in that folder until then. The
   * checks run now, so a refusal reaches the agent in this turn, and again
   * before the Git steps run.
   */
  async moveForAgent(request: WorktreeMoveRequest, options: AgentMoveOptions): Promise<AgentMoveResult> {
    const start = await this.agentMoveStart(request, options)
    if ('refusal' in start) return refused(start.refusal)
    const { from, projectFolder, inProjectFolder } = start
    if (!options.bringBranch) return this.moveAndHoldForAgent(request, options, from, projectFolder)
    const plan = inProjectFolder
      ? await this.branchToNewWorktree(request, projectFolder)
      : await this.branchToProjectFolder(request, from, projectFolder)
    if ('refusal' in plan) return refused(plan.refusal)
    this.holdForTurnEnd(request.sessionId, { work: plan.work, continueWith: options.continueWith })
    return { success: true, directory: plan.directory, branch: plan.branch, atTurnEnd: true }
  }

  /** Where an agent move starts, or why it cannot. */
  private async agentMoveStart(request: WorktreeMoveRequest, options: AgentMoveOptions): Promise<{ from: string; projectFolder: string; inProjectFolder: boolean } | { refusal: string }> {
    if (this.turnEndMoves.has(request.sessionId)) return { refusal: 'A move already waits for this turn to end.' }
    const from = this.boundDirectory(request.sessionId, request.cwd)
    const projectFolder = from ? (await repositoryCheckouts(from))[0]?.path : undefined
    if (!from || !projectFolder) return { refusal: 'This session is not in a git repository.' }
    const inProjectFolder = await realpathOrNull(from) === await realpathOrNull(projectFolder)
    if (options.removeWorktree && inProjectFolder) return { refusal: 'This session is in the project folder. There is no worktree to remove.' }
    const busy = options.removeWorktree ? await this.refusalToChange(from, request.sessionId) : null
    return busy ? { refusal: busy } : { from, projectFolder, inProjectFolder }
  }

  /** Move the session now; removing the worktree it left and the continuation wait for the turn to end. */
  private async moveAndHoldForAgent(request: WorktreeMoveRequest, options: AgentMoveOptions, from: string, projectFolder: string): Promise<AgentMoveResult> {
    const moved = await this.move(request)
    if (!moved.success || !moved.gitContext) return refused(moved.error ?? 'The move failed.')
    const directory = moved.gitContext.worktreePath ?? projectFolder
    const branch = moved.gitContext.branch ?? moved.gitContext.detachedHeadSha ?? null
    const removeWorktree = options.removeWorktree ? () => this.removeWorktree(from, projectFolder) : null
    if (!removeWorktree && !options.continueWith) return { success: true, directory, branch, atTurnEnd: false }
    this.holdForTurnEnd(request.sessionId, { work: removeWorktree ?? (async () => {}), continueWith: options.continueWith })
    return { success: true, directory, branch, atTurnEnd: !!removeWorktree }
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

  /** The session's branch goes from its linked worktree into the project folder:
   *  the worktree is removed, and the project folder switches to the branch. */
  private async branchToProjectFolder(request: WorktreeMoveRequest, from: string, projectFolder: string): Promise<TurnEndPlan> {
    const { target } = request
    const toProjectFolder = target.kind === 'project-folder'
      || (target.kind === 'existing' && await realpathOrNull(resolveHomePath(target.path)) === await realpathOrNull(projectFolder))
    if (!toProjectFolder) return { refusal: 'A branch moves from a worktree into the project folder, or from the project folder into a new worktree.' }
    const branch = await getWorkingBranch(from)
    if (!branch) return { refusal: 'This worktree has a detached HEAD, so there is no branch to bring.' }
    const busy = await this.refusalToChange(from, request.sessionId) ?? await this.refusalToChange(projectFolder, request.sessionId)
    if (busy) return { refusal: busy }
    const work = async () => {
      const busyNow = await this.refusalToChange(from, request.sessionId) ?? await this.refusalToChange(projectFolder, request.sessionId)
      if (busyNow) throw new Error(busyNow)
      await runAsync('git', ['worktree', 'remove', from], projectFolder)
      await runAsync('git', ['switch', branch], projectFolder)
      await this.bindExisting(request, projectFolder)
    }
    return { work, directory: projectFolder, branch }
  }

  /** The project folder's branch goes into a new worktree: the project folder
   *  switches to the target branch, and the worktree checks out the branch. */
  private async branchToNewWorktree(request: WorktreeMoveRequest, projectFolder: string): Promise<TurnEndPlan> {
    const { target } = request
    if (target.kind !== 'new') return { refusal: 'A branch moves from a worktree into the project folder, or from the project folder into a new worktree.' }
    if (target.baseBranch || target.branchName) return { refusal: 'The branch keeps its name and commits, so base_branch and branch_name do not apply.' }
    const branch = await getWorkingBranch(projectFolder)
    if (!branch) return { refusal: 'The project folder has a detached HEAD, so there is no branch to bring.' }
    const targetBranch = this.runtime.getGitContext(request.sessionId)?.targetBranch
    if (!targetBranch) return { refusal: 'Solus does not know the target branch the project folder goes back to.' }
    if (branch === targetBranch) return { refusal: `The project folder is on the target branch ${branch}. Move to a new worktree without bringing the branch.` }
    const path = worktreePathFor(projectFolder, branch.replace(/\//g, '-'))
    if (existsSync(path)) return { refusal: `${path} already exists.` }
    const busy = await this.refusalToChange(projectFolder, request.sessionId)
    if (busy) return { refusal: busy }
    const work = async () => {
      const busyNow = await this.refusalToChange(projectFolder, request.sessionId)
      if (busyNow) throw new Error(busyNow)
      await runAsync('git', ['switch', targetBranch], projectFolder)
      await runAsync('git', ['worktree', 'add', path, branch], projectFolder)
      await this.bindExisting(request, path)
    }
    return { work, directory: path, branch }
  }

  /** Remove a linked worktree no session uses. Git refuses one with changes. */
  private async removeWorktree(worktree: string, projectFolder: string): Promise<void> {
    const busy = await this.refusalToChange(worktree, null)
    if (busy) throw new Error(busy)
    await runAsync('git', ['worktree', 'remove', worktree], projectFolder)
    log.info('session_left_worktree_removed', { worktreePath: worktree })
  }

  private async bindExisting(request: WorktreeMoveRequest, directory: string): Promise<void> {
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
    const directory = target.kind === 'project-folder' ? await realpathOrNull(projectFolder) : await checkoutOfRepository(boundDirectory, target.path)
    if (!directory) return { refusal: `${target.kind === 'existing' ? target.path : projectFolder} is not a checkout of this session's repository.` }
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
  return { success: false, error, atTurnEnd: false }
}

type TurnEndPlan = { work: () => Promise<void>; directory: string; branch: string } | { refusal: string }

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
