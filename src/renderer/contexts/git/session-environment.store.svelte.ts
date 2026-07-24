import { createContext } from 'svelte'
import { gitCheckoutFromState, type GitCheckout, type GitState, type IpcContext, type Session, type WorktreeEntry } from '../../../shared/types'
import { formatBranchDisplayName } from '../../lib/git-context'

export interface GitProjectRefs {
  branches: string[]
  worktrees: WorktreeEntry[]
}

export type GitRefreshLevel = 'status' | 'details' | 'full'

export interface GitRefreshResult {
  status: boolean
  details: boolean
  refs: boolean
  registration: boolean
  ok: boolean
  /** First meaningful failure reason, surfaced to the user when `ok` is false. */
  error?: string
}

interface GitFacetOutcome {
  ok: boolean
  error?: string
}

function gitErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Compose a self-describing failure: what we were doing, then the raw Git
 *  reason when there is one. Callers surface this verbatim in a toast. */
function gitFailure(doing: string, reason?: string): string {
  const detail = reason?.trim()
  return detail ? `${doing}: ${detail}` : doing
}

export interface SessionStartTarget {
  workingDirectory: string
  gitContext: GitCheckout | null
  worktreeBaseBranch: string | null
}

interface SessionEnvironmentWorkspace {
  activeTabId: string
  tabOrder: string[]
  globalDefaults: {
    workingDirectory: string
    gitContext: GitCheckout | null
    worktreeBaseBranch: string | null
  }
  config: {
    applyGlobalStartTarget(target: {
      gitContext: GitCheckout | null
      worktreeBaseBranch: string | null
    }): void
  }
  settings: { worktreeEnabled: boolean }
  sessionFor(tabId: string): Session | undefined
  ctxFor(tabId: string): IpcContext
}

export type EnvironmentKind = 'workspace' | 'branch' | 'worktree'

export interface SessionEnvironment {
  cwd: string
  checkout: GitCheckout | null
  kind: EnvironmentKind
  name: string
  branch: string | null
  targetBranch: string | null
  isolated: boolean
  pending: boolean
  repoRoot: string | null
  worktreePath: string | null
  status: GitState | null | undefined
}

export function environmentProjectKey(environment: SessionEnvironment): string {
  return environment.repoRoot ?? environment.cwd ?? '~'
}

export function environmentBranchKey(environment: SessionEnvironment): string {
  const branch = environment.branch ?? 'no branch'
  const worktreeSuffix = environment.isolated ? ' (worktree)' : ''
  return `${environmentProjectKey(environment)}::${branch}${worktreeSuffix}`
}

const WORKSPACE_NAME = 'Workspace'
const PENDING_WORKTREE_NAME = 'New worktree'

/** Renderer authority for session environment identity and live Git state. */
export class SessionEnvironmentStore {
  byCwd = $state<Record<string, GitState | null>>({})
  refsByRoot = $state<Record<string, GitProjectRefs>>({})
  private workspace: SessionEnvironmentWorkspace | null = null
  private inflight = new Map<string, Promise<GitFacetOutcome>>()
  private refsInflight = new Map<string, Promise<GitFacetOutcome>>()
  private lastRefresh = new Map<string, number>()
  private detailsLastRefresh = new Map<string, number>()
  private refsLastRefresh = new Map<string, number>()
  private detailWatchers = new Map<string, number>()
  private detailRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private versions = new Map<string, number>()

  bindWorkspace(workspace: SessionEnvironmentWorkspace): void {
    this.workspace = workspace
  }

  /** One projection for every surface that displays a session's environment. */
  environmentFor(tabId?: string | null): SessionEnvironment {
    if (!this.workspace) throw new Error('SessionEnvironmentStore must be bound to a workspace')
    const session = tabId ? this.workspace.sessionFor(tabId) : undefined
    const attachedCheckout = session ? session.gitContext : this.workspace.globalDefaults.gitContext
    const worktreeBaseBranch = session
      ? session.worktreeBaseBranch
      : this.workspace.globalDefaults.worktreeBaseBranch
    const cwd = session?.gitContext?.worktreePath
      ?? session?.workingDirectory
      ?? this.workspace.globalDefaults.gitContext?.worktreePath
      ?? this.workspace.globalDefaults.workingDirectory
    const status = this.statusFor(cwd)
    const checkout = gitCheckoutFromState(status, attachedCheckout?.worktreePath) ?? attachedCheckout
    const isolated = !!checkout?.worktreePath
    const pending = !!worktreeBaseBranch && !isolated

    if (!checkout) {
      return {
        cwd,
        checkout: null,
        kind: 'workspace',
        name: pending ? PENDING_WORKTREE_NAME : WORKSPACE_NAME,
        branch: null,
        targetBranch: worktreeBaseBranch ?? null,
        isolated: false,
        pending,
        repoRoot: status?.repoRoot ?? null,
        worktreePath: null,
        status,
      }
    }

    return {
      cwd,
      checkout,
      kind: isolated ? 'worktree' : 'branch',
      name: pending ? PENDING_WORKTREE_NAME : checkout.branch
        ? formatBranchDisplayName(checkout.branch, checkout.targetBranch, isolated)
        : 'Detached HEAD',
      branch: checkout.branch,
      targetBranch: checkout.targetBranch,
      isolated,
      pending,
      repoRoot: checkout.repoRoot ?? status?.repoRoot ?? null,
      worktreePath: checkout.worktreePath ?? null,
      status,
    }
  }

  /** Refresh every Git facet requested for one captured tab/checkout identity. */
  async refreshTab(
    workspace: SessionEnvironmentWorkspace,
    opts: { tabId?: string; cwd?: string; level?: GitRefreshLevel; force?: boolean; worktreeRequested?: boolean } = {},
  ): Promise<GitRefreshResult> {
    const tabId = opts.tabId ?? workspace.activeTabId
    const session = workspace.sessionFor(tabId)
    const cwd = opts.cwd
      ?? session?.gitContext?.worktreePath
      ?? session?.workingDirectory
      ?? workspace.globalDefaults.gitContext?.worktreePath
      ?? workspace.globalDefaults.workingDirectory
    const level = opts.level ?? 'status'
    if (!cwd || cwd === '~') return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no Git working directory.' }

    const worktreePath = session?.gitContext?.worktreePath
    const worktreeRequested = opts.worktreeRequested
      ?? (session ? !!session.worktreeBaseBranch : workspace.settings.worktreeEnabled)
    // On a genuinely cold load nothing can render a session's environment until
    // Git answers: the sidebar can't group it, the home can't offer the worktree
    // toggle. Land identity first — repo + branch, all O(1) — and let the
    // working-tree scan below overwrite it. Both passes agree on every field, so
    // nothing re-keys or flickers. A cold target has no checkout yet, so the
    // provisional answer is always a plain branch.
    const coldTarget = session
      ? session.gitContext === null
      : workspace.tabOrder.length === 0 && !workspace.globalDefaults.gitContext
    if (coldTarget && this.statusFor(cwd) === undefined) {
      const identity = await window.solus.gitIdentity(cwd).catch(() => null)
      const current = workspace.sessionFor(tabId)
      const currentCwd = current?.gitContext?.worktreePath ?? current?.workingDirectory
      const stale = session
        ? current !== session || currentCwd !== cwd
        : workspace.globalDefaults.workingDirectory !== cwd
      if (identity && !stale) {
        const provisional = {
          gitContext: gitCheckoutFromState(identity),
          worktreeBaseBranch: worktreeRequested ? identity.targetBranch : null,
        }
        if (session) {
          session.gitContext = provisional.gitContext
          session.worktreeBaseBranch = provisional.worktreeBaseBranch
        } else {
          workspace.config.applyGlobalStartTarget(provisional)
        }
      }
    }

    const resolved = await this.resolveSessionStartTarget(cwd, {
      force: opts.force,
      worktreePath,
      worktreeRequested,
      fallbackGitContext: session?.gitContext ?? null,
    })
    if (!resolved.target) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t read the working tree', resolved.error) }
    }
    const { gitContext, worktreeBaseBranch } = resolved.target

    // The tab/session moved to a different checkout while this refresh was in
    // flight — the result would land on the wrong environment. Not a failure;
    // report it as superseded so callers don't flash a misleading error.
    const supersededError = 'The environment changed during refresh — try again.'
    if (session) {
      const current = workspace.sessionFor(tabId)
      const currentCwd = current?.gitContext?.worktreePath ?? current?.workingDirectory
      if (current !== session || currentCwd !== cwd) {
        return { status: true, details: false, refs: false, registration: false, ok: false, error: supersededError }
      }
      session.gitContext = gitContext
      session.worktreeBaseBranch = worktreeBaseBranch
      let registrationError: string | undefined
      try {
        await window.solus.gitRegisterEnvironment(
          $state.snapshot(workspace.ctxFor(tabId)),
          cwd,
          $state.snapshot(gitContext),
        )
      } catch (error) {
        registrationError = gitErrorText(error)
      }
      if (registrationError !== undefined) {
        return { status: true, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t register the Git environment', registrationError) }
      }
    } else if (workspace.tabOrder.length === 0) {
      if (workspace.globalDefaults.workingDirectory !== cwd) {
        return { status: true, details: false, refs: false, registration: true, ok: false, error: supersededError }
      }
      workspace.config.applyGlobalStartTarget({ gitContext, worktreeBaseBranch })
    }

    const detailsOutcome: GitFacetOutcome = level === 'status'
      ? { ok: true }
      : await this.refreshStatus(cwd, { force: true, details: true, bypassCache: true })
    const currentStatus = this.statusFor(cwd)
    const projectRoot = currentStatus?.repoRoot ?? gitContext?.repoRoot
    const refsOutcome: GitFacetOutcome = level !== 'full' || !projectRoot
      ? { ok: true }
      : await this.refreshRefsOutcome(projectRoot, workspace.ctxFor(tabId), { force: true })
    const error = !detailsOutcome.ok
      ? gitFailure('Couldn’t read working-tree changes', detailsOutcome.error)
      : !refsOutcome.ok
        ? gitFailure('Couldn’t list branches and worktrees', refsOutcome.error)
        : undefined
    return {
      status: true,
      details: detailsOutcome.ok,
      refs: refsOutcome.ok,
      registration: true,
      ok: detailsOutcome.ok && refsOutcome.ok,
      error,
    }
  }

  /** Resolve where a session will start. Callers apply this snapshot as one unit
   * so directory, checkout, and worktree intent cannot come from different
   * refresh ticks. */
  async resolveSessionStartTarget(
    workingDirectory: string,
    options: {
      force?: boolean
      worktreePath?: string
      worktreeRequested: boolean
      fallbackGitContext?: GitCheckout | null
    },
  ): Promise<{ target: SessionStartTarget | null; error?: string }> {
    const statusOutcome = await this.refreshStatus(workingDirectory, { force: options.force ?? true })
    if (!statusOutcome.ok) return { target: null, error: statusOutcome.error }

    const status = this.statusFor(workingDirectory) ?? null
    const detected = gitCheckoutFromState(status, options.worktreePath)
    // Retain worktree routing while detached instead of treating a valid
    // checkout as a non-repository.
    const gitContext = detected
      ?? (status && options.worktreePath ? options.fallbackGitContext ?? null : null)
    return {
      target: {
        workingDirectory,
        gitContext,
        worktreeBaseBranch: options.worktreeRequested && !gitContext?.worktreePath
          ? gitContext?.targetBranch ?? null
          : null,
      },
    }
  }

  /** Resolves to true when the status fetch succeeded, false when it threw. */
  async refresh(cwd: string, opts: { force?: boolean; details?: boolean; bypassCache?: boolean } = {}): Promise<boolean> {
    return (await this.refreshStatus(cwd, opts)).ok
  }

  /** Status/details scan that also carries the failure reason, for callers that
   *  report it (e.g. the Environment panel's refresh button). */
  private async refreshStatus(cwd: string, opts: { force?: boolean; details?: boolean; bypassCache?: boolean } = {}): Promise<GitFacetOutcome> {
    const includeDetails = opts.details === true
    const now = Date.now()
    const refreshTimes = includeDetails ? this.detailsLastRefresh : this.lastRefresh
    const last = refreshTimes.get(cwd) ?? 0
    if (!opts.force && now - last < 2_000) return { ok: true }
    const inflightKey = `${cwd}\0${includeDetails ? 'details' : 'summary'}`
    const existing = this.inflight.get(inflightKey)
    // A forced lifecycle refresh must observe state after the existing scan,
    // rather than silently joining a request that may predate a Git mutation.
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshStatus(cwd, opts)
    }
    const version = this.versions.get(cwd) ?? 0
    const promise = window.solus.gitRefreshState(cwd, includeDetails
      ? { includeDetails: true, bypassCache: opts.bypassCache === true }
      : undefined)
      .then((status): GitFacetOutcome => {
        // A watcher push that landed while this request ran is newer.
        if ((this.versions.get(cwd) ?? 0) === version) this.applyStatus(cwd, status, includeDetails)
        this.lastRefresh.set(cwd, Date.now())
        if (includeDetails) this.detailsLastRefresh.set(cwd, Date.now())
        else this.scheduleDetailsRefresh(cwd)
        return { ok: true }
      })
      .catch((error): GitFacetOutcome => ({ ok: false, error: gitErrorText(error) }))
      .finally(() => this.inflight.delete(inflightKey))
    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** Land a status pushed from the main-process Git watcher. */
  set(cwd: string, status: GitState | null): void {
    this.versions.set(cwd, (this.versions.get(cwd) ?? 0) + 1)
    const prev = this.byCwd[cwd]
    const next = this.statusWithVisibleDetails(cwd, status)
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) {
      this.lastRefresh.set(cwd, Date.now())
      this.scheduleDetailsRefresh(cwd)
      return
    }
    this.byCwd[cwd] = next
    this.lastRefresh.set(cwd, Date.now())
    this.scheduleDetailsRefresh(cwd)
  }

  watchDetails(cwd: string): () => void {
    this.detailWatchers.set(cwd, (this.detailWatchers.get(cwd) ?? 0) + 1)
    void this.refresh(cwd, { force: true, details: true })
    return () => {
      const remaining = (this.detailWatchers.get(cwd) ?? 1) - 1
      if (remaining > 0) {
        this.detailWatchers.set(cwd, remaining)
        return
      }
      this.detailWatchers.delete(cwd)
      const timer = this.detailRefreshTimers.get(cwd)
      if (timer) clearTimeout(timer)
      this.detailRefreshTimers.delete(cwd)
    }
  }

  private applyStatus(cwd: string, status: GitState | null, includeDetails: boolean): void {
    const current = this.byCwd[cwd]
    if (includeDetails) {
      // The Environment panel can be the first consumer for a cwd. Its detail
      // request must establish the terminal non-repository state instead of
      // leaving the panel on its `undefined` (loading) sentinel forever.
      if (!status) {
        if (current === undefined) this.byCwd[cwd] = null
        return
      }
      if (current === null) return
      if (current && (current.repoRoot !== status.repoRoot || current.branch !== status.branch)) return
      const next = current
        ? {
            ...current,
            uncommittedChanges: {
              ...current.uncommittedChanges,
              insertions: status.uncommittedChanges.insertions,
              deletions: status.uncommittedChanges.deletions,
            },
            prUrl: status.prUrl,
          }
        : status
      if (JSON.stringify(current) !== JSON.stringify(next)) this.byCwd[cwd] = next
      return
    }
    const next = this.statusWithVisibleDetails(cwd, status)
    if (JSON.stringify(this.byCwd[cwd]) !== JSON.stringify(next)) this.byCwd[cwd] = next
  }

  private statusWithVisibleDetails(cwd: string, status: GitState | null): GitState | null {
    const previous = this.byCwd[cwd]
    if (!status || !previous || !this.detailWatchers.has(cwd) || previous.branch !== status.branch) return status
    return {
      ...status,
      uncommittedChanges: {
        ...status.uncommittedChanges,
        insertions: previous.uncommittedChanges.insertions,
        deletions: previous.uncommittedChanges.deletions,
      },
      ...(previous.prUrl ? { prUrl: previous.prUrl } : {}),
    }
  }

  private scheduleDetailsRefresh(cwd: string): void {
    if (!this.detailWatchers.has(cwd) || this.detailRefreshTimers.has(cwd)) return
    const timer = setTimeout(() => {
      this.detailRefreshTimers.delete(cwd)
      if (this.detailWatchers.has(cwd)) void this.refresh(cwd, { force: true, details: true })
    }, 150)
    this.detailRefreshTimers.set(cwd, timer)
  }

  statusFor(cwd: string | null | undefined): GitState | null | undefined {
    if (!cwd) return undefined
    return this.byCwd[cwd]
  }

  async refreshRefs(projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<boolean> {
    return (await this.refreshRefsOutcome(projectRoot, ctx, opts)).ok
  }

  /** Refs scan that also carries the failure reason, for callers that report it. */
  private async refreshRefsOutcome(projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<GitFacetOutcome> {
    const now = Date.now()
    const last = this.refsLastRefresh.get(projectRoot) ?? 0
    if (!opts.force && now - last < 5_000) return { ok: true }
    const existing = this.refsInflight.get(projectRoot)
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshRefsOutcome(projectRoot, ctx, opts)
    }
    const promise = Promise.allSettled([
      window.solus.worktreeListProject($state.snapshot(ctx)),
      window.solus.worktreeBranches($state.snapshot(ctx)),
    ])
      .then(([worktreesResult, branchesResult]): GitFacetOutcome => {
        const previous = this.refsFor(projectRoot)
        const worktrees = worktreesResult.status === 'fulfilled' ? worktreesResult.value : previous.worktrees
        const branches = branchesResult.status === 'fulfilled' ? branchesResult.value : previous.branches
        this.refsByRoot[projectRoot] = { worktrees, branches }
        const ok = worktreesResult.status === 'fulfilled' && branchesResult.status === 'fulfilled'
        if (ok) this.refsLastRefresh.set(projectRoot, Date.now())
        const rejected = worktreesResult.status === 'rejected'
          ? worktreesResult.reason
          : branchesResult.status === 'rejected'
            ? branchesResult.reason
            : undefined
        return { ok, error: ok ? undefined : gitErrorText(rejected) }
      })
      .finally(() => this.refsInflight.delete(projectRoot))
    this.refsInflight.set(projectRoot, promise)
    return promise
  }

  refsFor(projectRoot: string | null | undefined): GitProjectRefs {
    if (!projectRoot) return { worktrees: [], branches: [] }
    return this.refsByRoot[projectRoot] ?? { worktrees: [], branches: [] }
  }
}

export const [getSessionEnvironmentStore, setSessionEnvironmentStore] = createContext<SessionEnvironmentStore>()
