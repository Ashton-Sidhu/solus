import { createContext } from 'svelte'
import { gitCheckoutFromState, type GitCheckout, type GitState, type IpcContext, type Session, type WorktreeEntry } from '../../shared/types'
import { formatBranchDisplayName } from '../lib/git-context'

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

const WORKSPACE_NAME = 'Workspace'
const PENDING_WORKTREE_NAME = 'New worktree'

/** Renderer authority for session environment identity and live Git state. */
export class SessionEnvironmentStore {
  byCwd = $state<Record<string, GitState | null>>({})
  refsByRoot = $state<Record<string, GitProjectRefs>>({})
  private workspace: SessionEnvironmentWorkspace | null = null
  private inflight = new Map<string, Promise<boolean>>()
  private refsInflight = new Map<string, Promise<boolean>>()
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
    if (!cwd || cwd === '~') return { status: false, details: false, refs: false, registration: false, ok: false }

    const worktreePath = session?.gitContext?.worktreePath
    const worktreeRequested = opts.worktreeRequested
      ?? (session ? !!session.worktreeBaseBranch : workspace.settings.worktreeEnabled)
    const sessionStartTarget = await this.resolveSessionStartTarget(cwd, {
      force: opts.force,
      worktreePath,
      worktreeRequested,
      fallbackGitContext: session?.gitContext ?? null,
    })
    if (!sessionStartTarget) return { status: false, details: false, refs: false, registration: false, ok: false }
    const { gitContext, worktreeBaseBranch } = sessionStartTarget

    if (session) {
      const current = workspace.sessionFor(tabId)
      const currentCwd = current?.gitContext?.worktreePath ?? current?.workingDirectory
      if (current !== session || currentCwd !== cwd) {
        return { status: true, details: false, refs: false, registration: false, ok: false }
      }
      session.gitContext = gitContext
      session.worktreeBaseBranch = worktreeBaseBranch
      let registration = true
      try {
        await window.solus.gitRegisterEnvironment(
          $state.snapshot(workspace.ctxFor(tabId)),
          cwd,
          $state.snapshot(gitContext),
        )
      } catch {
        registration = false
      }
      if (!registration) {
        return { status: true, details: false, refs: false, registration: false, ok: false }
      }
    } else if (workspace.tabOrder.length === 0) {
      if (workspace.globalDefaults.workingDirectory !== cwd) {
        return { status: true, details: false, refs: false, registration: true, ok: false }
      }
      workspace.globalDefaults.gitContext = gitContext
      workspace.globalDefaults.worktreeBaseBranch = worktreeBaseBranch
    }

    const detailsOk = level === 'status'
      ? true
      : await this.refresh(cwd, { force: true, details: true, bypassCache: true })
    const currentStatus = this.statusFor(cwd)
    const projectRoot = currentStatus?.repoRoot ?? gitContext?.repoRoot
    const refsOk = level !== 'full' || !projectRoot
      ? true
      : await this.refreshRefs(projectRoot, workspace.ctxFor(tabId), { force: true })
    return { status: true, details: detailsOk, refs: refsOk, registration: true, ok: detailsOk && refsOk }
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
  ): Promise<SessionStartTarget | null> {
    const statusOk = await this.refresh(workingDirectory, { force: options.force ?? true })
    if (!statusOk) return null

    const status = this.statusFor(workingDirectory) ?? null
    const detected = gitCheckoutFromState(status, options.worktreePath)
    // Retain worktree routing while detached instead of treating a valid
    // checkout as a non-repository.
    const gitContext = detected
      ?? (status && options.worktreePath ? options.fallbackGitContext ?? null : null)
    return {
      workingDirectory,
      gitContext,
      worktreeBaseBranch: options.worktreeRequested && !gitContext?.worktreePath
        ? gitContext?.targetBranch ?? null
        : null,
    }
  }

  /** Resolves to true when the status fetch succeeded, false when it threw. */
  async refresh(cwd: string, opts: { force?: boolean; details?: boolean; bypassCache?: boolean } = {}): Promise<boolean> {
    const includeDetails = opts.details === true
    const now = Date.now()
    const refreshTimes = includeDetails ? this.detailsLastRefresh : this.lastRefresh
    const last = refreshTimes.get(cwd) ?? 0
    if (!opts.force && now - last < 2_000) return true
    const inflightKey = `${cwd}\0${includeDetails ? 'details' : 'summary'}`
    const existing = this.inflight.get(inflightKey)
    // A forced lifecycle refresh must observe state after the existing scan,
    // rather than silently joining a request that may predate a Git mutation.
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refresh(cwd, opts)
    }
    const version = this.versions.get(cwd) ?? 0
    const promise = window.solus.gitRefreshState(cwd, includeDetails
      ? { includeDetails: true, bypassCache: opts.bypassCache === true }
      : undefined)
      .then((status) => {
        // A watcher push that landed while this request ran is newer.
        if ((this.versions.get(cwd) ?? 0) === version) this.applyStatus(cwd, status, includeDetails)
        this.lastRefresh.set(cwd, Date.now())
        if (includeDetails) this.detailsLastRefresh.set(cwd, Date.now())
        else this.scheduleDetailsRefresh(cwd)
        return true
      })
      .catch(() => false)
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
    const now = Date.now()
    const last = this.refsLastRefresh.get(projectRoot) ?? 0
    if (!opts.force && now - last < 5_000) return true
    const existing = this.refsInflight.get(projectRoot)
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshRefs(projectRoot, ctx, opts)
    }
    const promise = Promise.allSettled([
      window.solus.worktreeListProject($state.snapshot(ctx)),
      window.solus.worktreeBranches($state.snapshot(ctx)),
    ])
      .then(([worktreesResult, branchesResult]) => {
        const previous = this.refsFor(projectRoot)
        const worktrees = worktreesResult.status === 'fulfilled' ? worktreesResult.value : previous.worktrees
        const branches = branchesResult.status === 'fulfilled' ? branchesResult.value : previous.branches
        this.refsByRoot[projectRoot] = { worktrees, branches }
        const ok = worktreesResult.status === 'fulfilled' && branchesResult.status === 'fulfilled'
        if (ok) this.refsLastRefresh.set(projectRoot, Date.now())
        return ok
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
