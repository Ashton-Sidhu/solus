import { randomUUID } from 'node:crypto'
import { resolveHomePath } from '../platform/paths'
import type { CheckoutChange, CheckoutSnapshot, CheckoutState } from '@solus/contracts/checkout'
import { gitCheckoutFromState, sameGitCheckout, type GitCheckout, type GitState } from '@solus/contracts/types'
import { computeGitState } from './git-helpers'
import { runAsync } from './exec'
import { createWorktree, ensureBranchWorktree, fetchAndCheckoutPr, renameWorktreeBranch, type CreateWorktreeOptions } from './worktree-manager'
import type { AgentDispatcher } from '../agents/agent-runner'
import { generateWorktreeName } from './worktree-name'
import { isTemporaryWorktreeBranch } from './worktree-branch-name'
import { GitWatcher } from './git-watcher'
import { createLogger } from '../logger'

const log = createLogger('CheckoutService', 'checkout-service.ts')

/** Owns checkout identity independently of sessions and providers. Git is the
 * durable source; snapshots reconcile it after reconnect or host restart. */
export class CheckoutService {
  readonly generation = randomUUID()
  private revision = 0
  private states = new Map<string, CheckoutState>()
  private listeners = new Set<(change: CheckoutChange) => void>()
  private statusListeners = new Set<(cwd: string, status: GitState | null) => void>()
  private statuses = new Map<string, string>()
  private reads = new Map<string, Promise<CheckoutState>>()
  private pending = new Set<string>()
  private deferred = new Set<string>()
  private watched = new Set<string>()
  private disposed = false
  private watcher = new GitWatcher((cwd) => {
    if (!this.isForeground()) { this.deferred.add(cwd); return }
    void this.refresh(cwd).catch((error) => log.warn('checkout_refresh_failed', { cwd, error: String(error) }))
  })

  constructor(
    private isForeground: () => boolean = () => true,
    private readState: typeof computeGitState = computeGitState,
  ) {}

  onChange(listener: (change: CheckoutChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onStatus(listener: (cwd: string, status: GitState | null) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  get(cwd: string): CheckoutState | undefined { return this.states.get(resolveHomePath(cwd)) }

  /** Client/session attachment is a hint only; it cannot overwrite known state. */
  attach(cwd: string, checkout: GitCheckout): GitCheckout {
    cwd = resolveHomePath(cwd)
    const current = this.states.get(cwd)
    if (current) {
      if (!current.checkout) throw new Error(`Checkout is no longer available: ${cwd}`)
      return current.checkout
    }
    return this.commit(cwd, checkout, 'observed').checkout!
  }

  async create(projectRoot: string, baseBranch?: string, options?: CreateWorktreeOptions): Promise<GitCheckout> {
    const checkout = await createWorktree(resolveHomePath(projectRoot), baseBranch, options)
    return this.commit(checkout.worktreePath!, checkout, 'created').checkout!
  }

  async name(cwd: string, prompt: string, dispatcher: AgentDispatcher): Promise<void> {
    cwd = resolveHomePath(cwd)
    const branch = this.get(cwd)?.checkout?.branch
    if (!branch || !isTemporaryWorktreeBranch(branch)) return
    try {
      const name = await generateWorktreeName(dispatcher, prompt, cwd)
      if (name) await this.rename(cwd, branch, name)
    } catch (error) {
      log.warn('worktree_branch_rename_failed', { cwd, branch, error: String(error) })
    }
  }

  async ensureBranch(projectRoot: string, branch: string): Promise<GitCheckout> {
    const checkout = await ensureBranchWorktree(resolveHomePath(projectRoot), branch)
    return this.commit(checkout.worktreePath!, checkout, 'observed').checkout!
  }

  async preparePullRequest(...args: Parameters<typeof fetchAndCheckoutPr>): ReturnType<typeof fetchAndCheckoutPr> {
    const result = await fetchAndCheckoutPr(resolveHomePath(args[0]), args[1], args[2], args[3])
    await this.refresh(result.worktreePath)
    return result
  }

  async createNamed(projectRoot: string, prompt: string, dispatcher: AgentDispatcher, signal: AbortSignal): Promise<GitCheckout> {
    projectRoot = resolveHomePath(projectRoot)
    const generatedName = await generateWorktreeName(dispatcher, prompt, projectRoot, signal)
    return this.create(projectRoot, undefined, { generatedName, signal })
  }

  async rename(cwd: string, previousBranch: string, name: string): Promise<CheckoutState | null> {
    cwd = resolveHomePath(cwd)
    const branch = await renameWorktreeBranch(cwd, previousBranch, name)
    if (!branch) return null
    const current = this.states.get(cwd)?.checkout
    if (!current) {
      await this.refresh(cwd)
    }
    const checkout = this.states.get(cwd)?.checkout
    if (!checkout) return null
    const state = this.commit(cwd, { ...checkout, branch }, 'renamed', { previousBranch, branch, at: Date.now() })
    log.info('worktree_branch_renamed', { cwd, ...state.lastRename, revision: state.revision })
    // A scan started before the mutation must not put its old identity back.
    await this.refresh(cwd)
    return state
  }

  async refresh(cwd: string): Promise<CheckoutState> {
    cwd = resolveHomePath(cwd)
    const existing = this.reads.get(cwd)
    if (existing) { this.pending.add(cwd); return existing }
    const read = (async () => {
      do {
        this.pending.delete(cwd)
        const revision = this.states.get(cwd)?.revision
        const status = await this.readState(cwd)
        const checkoutRoot = status ? await runAsync('git', ['rev-parse', '--show-toplevel'], cwd) : null
        if (this.states.get(cwd)?.revision !== revision) { this.pending.add(cwd); continue }
        const projectRoot = this.states.get(cwd)?.checkout?.repoRoot ?? status?.repoRoot
        const checkout = status ? gitCheckoutFromState(status, checkoutRoot !== status.repoRoot ? cwd : undefined, projectRoot) : null
        this.commit(cwd, checkout, 'observed')
        const serialized = JSON.stringify(status)
        if (this.statuses.get(cwd) !== serialized) {
          this.statuses.set(cwd, serialized)
          for (const listener of this.statusListeners) listener(cwd, status)
        }
      } while (this.pending.has(cwd))
      return this.states.get(cwd)!
    })().finally(() => this.reads.delete(cwd))
    this.reads.set(cwd, read)
    return read
  }

  async snapshot(paths: string[]): Promise<CheckoutSnapshot> {
    // Re-read known paths too: a rename while all clients were disconnected is
    // still visible when the first client returns.
    for (const cwd of new Set(paths.length ? paths.map(resolveHomePath) : this.states.keys())) await this.refresh(cwd)
    return { generation: this.generation, revision: this.revision, states: structuredClone([...this.states.values()]) }
  }

  flushDeferred(): void {
    if (this.isForeground()) {
      for (const [cwd, state] of this.states) {
        if (state.checkout && !this.watched.has(cwd)) {
          this.watched.add(cwd)
          this.watcher.register(cwd)
          this.deferred.add(cwd)
        }
      }
    }
    const paths = [...this.deferred]
    this.deferred.clear()
    for (const cwd of paths) void this.refresh(cwd).catch((error) => log.warn('checkout_refresh_failed', { cwd, error: String(error) }))
  }

  dispose(): void {
    this.disposed = true
    this.watcher.dispose()
    this.listeners.clear()
    this.statusListeners.clear()
  }

  private watch(cwd: string): void {
    if (this.disposed || !this.isForeground() || this.watched.has(cwd)) return
    this.watched.add(cwd)
    this.watcher.register(cwd)
  }

  private commit(cwd: string, checkout: GitCheckout | null, cause: CheckoutChange['cause'], lastRename?: CheckoutState['lastRename']): CheckoutState {
    const previous = this.states.get(cwd)
    if (previous && sameGitCheckout(previous.checkout, checkout) && !lastRename) return previous
    // Existing run inputs can hold this canonical object while startup awaits.
    // Update it in place; sessions do not maintain separate branch copies.
    if (previous?.checkout && checkout) {
      Object.assign(previous.checkout, checkout)
      if (!checkout.detachedHeadSha) delete previous.checkout.detachedHeadSha
    }
    const state: CheckoutState = {
      cwd, checkout: previous?.checkout && checkout ? previous.checkout : checkout,
      revision: ++this.revision,
    }
    const rename = lastRename ?? previous?.lastRename
    if (rename) state.lastRename = rename
    this.states.set(cwd, state)
    if (!checkout && this.watched.delete(cwd)) this.watcher.deregister(cwd)
    if (checkout) this.watch(cwd)
    const change: CheckoutChange = { generation: this.generation, state: structuredClone(state), cause }
    for (const listener of this.listeners) listener(change)
    return state
  }
}
