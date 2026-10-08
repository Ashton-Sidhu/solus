import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { GitCheckout, GitCheckoutBranchResult } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import type { CheckoutService } from '../../git/checkout-service'
import { runAsync } from '../../git/exec'
import { resolveRepoRoot } from '../../git/git-helpers'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'

const log = createLogger('worktree', 'worktree-move.ts')

/**
 * Moves a session into another git worktree (docs/worktree-names.md, "Agent worktrees"). One path for
 * the user's "Continue in worktree", the agent's `move_to_worktree` tool, and
 * the Switch action of a worktree offer: the session's checkout, diff, status,
 * and branch follow, and the next turn forks the provider thread into the new
 * directory (`SessionRuntime.moveSessionCheckout`).
 */

export type WorktreeMoveTarget =
  /** A new Solus worktree. `branchName` is the semantic name the branch-naming
   *  settings shape; without one, `namePrompt` names the branch afterwards. */
  | { kind: 'new'; baseBranch?: string; branchName?: string; namePrompt?: string }
  /** A linked worktree of the session's repository that already exists. */
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

/** What a move needs from the SessionRuntime, which owns session state. */
export interface WorktreeMoveRuntime {
  readonly checkouts: Pick<CheckoutService, 'create' | 'refresh'>
  getGitContext(sessionId: string): GitCheckout | undefined
  trackWorktreeMove(sessionId: string, controller: AbortController): () => void
  moveSessionCheckout(sessionId: string, checkout: GitCheckout & { worktreePath: string }): void
  recordActivity(subject: ActivitySubject & { kind: 'session' }, actor: Actor, kind: ActivityKind): Promise<Activity>
  nameWorktreeBranch(sessionId: string, checkout: GitCheckout, prompt: string, actor: Actor | undefined, preferences?: ExecutionPreferences): Promise<void>
}

export interface WorktreeStatus {
  /** The directory the session is bound to. */
  directory: string
  /** The host's binding; null before the session's first checkout. */
  checkout: GitCheckout | null
  /** The main checkout first. `holdsSession` marks the one the session is bound to. */
  checkouts: Array<RepositoryCheckout & { holdsSession: boolean }>
}

export class WorktreeMover {
  /** The last move per session. A move waits for the one before it. */
  private readonly tails = new Map<string, Promise<GitCheckoutBranchResult>>()

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
    const realPaths = await Promise.all(checkouts.map((checkout) => realpathOrNull(checkout.path)))
    return {
      directory,
      checkout: this.runtime.getGitContext(sessionId) ?? null,
      checkouts: checkouts.map((checkout, index) => ({ ...checkout, holdsSession: !!realDirectory && realPaths[index] === realDirectory })),
    }
  }

  move(request: WorktreeMoveRequest): Promise<GitCheckoutBranchResult> {
    const previous = this.tails.get(request.sessionId)
    const next = (previous ?? Promise.resolve(null)).then(() => this.moveNow(request))
    this.tails.set(request.sessionId, next)
    void next.finally(() => {
      if (this.tails.get(request.sessionId) === next) this.tails.delete(request.sessionId)
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
      const target = await this.targetCheckout(request, boundDirectory, repoRoot, controller.signal)
      if ('refusal' in target) return { success: false, error: target.refusal }
      controller.signal.throwIfAborted()
      await this.bind(request, target.checkout)
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
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<{ checkout: GitCheckout & { worktreePath: string } } | { refusal: string }> {
    const { target } = request
    const bound = this.runtime.getGitContext(request.sessionId)
    let checkout: GitCheckout | null
    if (target.kind === 'new') {
      if (bound?.worktreePath) return { refusal: 'This session is already in a worktree. Give the path of a worktree to move to it.' }
      checkout = await this.runtime.checkouts.create(repoRoot, target.baseBranch || bound?.targetBranch, {
        signal,
        naming: request.preferences?.worktreeBranchNaming,
        generatedName: target.branchName || null,
      })
    } else {
      const worktree = await worktreeOfRepository(boundDirectory, target.path)
      if (!worktree) return { refusal: `${target.path} is not a linked worktree of this session's repository.` }
      if (await realpathOrNull(boundDirectory) === worktree) return { refusal: 'This session is already in that worktree.' }
      checkout = (await this.runtime.checkouts.refresh(worktree)).checkout
    }
    return checkout?.worktreePath
      ? { checkout: { ...checkout, worktreePath: checkout.worktreePath } }
      : { refusal: 'The worktree has no checkout Solus can read.' }
  }

  /** Bind the session, record the move, and name a new branch. */
  private async bind(request: WorktreeMoveRequest, checkout: GitCheckout & { worktreePath: string }): Promise<void> {
    const { sessionId, target } = request
    this.runtime.moveSessionCheckout(sessionId, checkout)
    // Recorded before the branch is named: a reader resolves the checkout's current branch by its path.
    const activity: Extract<ActivityKind, { kind: 'moved_to_worktree' }> = { kind: 'moved_to_worktree', path: checkout.worktreePath }
    const branch = checkout.branch ?? checkout.detachedHeadSha
    if (branch) activity.branch = branch
    await this.runtime.recordActivity({ kind: 'session', id: sessionId }, request.actor, activity)
    if (target.kind === 'new' && !target.branchName && target.namePrompt) {
      void this.runtime.nameWorktreeBranch(sessionId, checkout, target.namePrompt, request.actor, request.preferences)
    }
    log.info('session_moved_to_worktree', { sessionId, worktreePath: checkout.worktreePath, target: target.kind })
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
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
    return [{ path, branch: ref ? ref.replace(/^refs\/heads\//, '') : null }]
  })
}

/** The real paths of the linked worktrees of the repository at `repoDirectory`.
 *  The main checkout, the first entry, is not one. */
export async function linkedWorktrees(repoDirectory: string): Promise<string[]> {
  const checkouts = await repositoryCheckouts(repoDirectory)
  const real = await Promise.all(checkouts.slice(1).map((checkout) => realpathOrNull(checkout.path)))
  return real.filter((path): path is string => !!path)
}

/**
 * The linked worktree of the repository at `repoDirectory` that holds
 * `rawPath`, or null. Git answers, not the string: a path counts only when it
 * is, or is inside, a worktree that `git worktree list` names. A relative path
 * is read from `repoDirectory`; `~` is the host user's home.
 */
export async function worktreeOfRepository(repoDirectory: string, rawPath: string): Promise<string | null> {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === NEW_CHAT_DIRECTORY) return null
  const expanded = resolveHomePath(trimmed)
  const requested = await realpathOrNull(isAbsolute(expanded) ? expanded : resolve(repoDirectory, expanded))
  if (!requested) return null
  let match: string | null = null
  for (const worktree of await linkedWorktrees(repoDirectory)) {
    const holds = requested === worktree || requested.startsWith(worktree + sep)
    if (holds && (!match || worktree.length > match.length)) match = worktree
  }
  return match
}
