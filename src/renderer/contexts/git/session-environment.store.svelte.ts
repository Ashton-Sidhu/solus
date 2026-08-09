import { createAppContext } from '../app/create-app-context'
import { gitCheckoutFromState, type GitCheckout, type GitState, type IpcContext, type RunConfig, type Session, type WorktreeEntry } from '../../../shared/types'
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
  /** The run a source owns. A tab and a session draft both hold one in the same
   *  position, which is why neither needs its own environment refresh. */
  runFor(sourceId: string): RunConfig | undefined
  /** Only a started session has one — the answer to "is there something for the
   *  host to register this environment against". */
  sessionFor(sourceId: string): Session | undefined
  ctxFor(sourceId: string): IpcContext
  apiFor?(sourceId: string): typeof window.solus
  apiForSession?(sessionId: string): typeof window.solus
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

export function environmentProjectKey(environment: SessionEnvironment, projectGroupPath?: string | null): string {
  return projectGroupPath ?? environment.repoRoot ?? environment.cwd ?? '~'
}

export function environmentBranchKey(environment: SessionEnvironment, projectGroupPath?: string | null): string {
  const branch = environment.branch ?? 'no branch'
  const worktreeSuffix = environment.isolated ? ' (worktree)' : ''
  return `${environmentProjectKey(environment, projectGroupPath)}::${branch}${worktreeSuffix}`
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
  private apiByCwd = new Map<string, typeof window.solus>()

  bindWorkspace(workspace: SessionEnvironmentWorkspace): void {
    this.workspace = workspace
  }

  bindCwd(cwd: string | null | undefined, api: typeof window.solus): void {
    if (cwd && cwd !== '~') this.apiByCwd.set(cwd, api)
  }

  private apiForCwd(cwd: string): typeof window.solus {
    return this.apiByCwd.get(cwd) ?? window.solus
  }

  /**
   * One projection for every surface that displays where a session runs.
   *
   * Takes the run config rather than a tab id: an environment is a function of
   * three of its fields and nothing else, so a session draft — which has no tab
   * and no session — projects through exactly the same path as a started tab.
   * `undefined` means "nothing chosen yet", which falls back to the app defaults.
   */
  environmentFor(run?: RunConfig | null): SessionEnvironment {
    if (!this.workspace) throw new Error('SessionEnvironmentStore must be bound to a workspace')
    const attachedCheckout = run ? run.gitContext : this.workspace.globalDefaults.gitContext
    // "Will branch" and "branches from X" are separate questions: a run can want
    // a worktree before the host has said which branch it would fork from.
    const wantsWorktree = run
      ? !!run.worktree
      : !!this.workspace.globalDefaults.worktreeBaseBranch
    const worktreeBaseBranch = run
      ? run.worktree?.baseBranch ?? null
      : this.workspace.globalDefaults.worktreeBaseBranch
    const cwd = run?.gitContext?.worktreePath
      ?? run?.workingDirectory
      ?? this.workspace.globalDefaults.gitContext?.worktreePath
      ?? this.workspace.globalDefaults.workingDirectory
    const status = this.statusFor(cwd)
    const checkout = gitCheckoutFromState(status, attachedCheckout?.worktreePath) ?? attachedCheckout
    const isolated = !!checkout?.worktreePath
    const pending = wantsWorktree && !isolated

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

  /**
   * Refresh every Git facet requested for one source's checkout, and land the
   * answer on the run that source owns.
   *
   * A *source* is a tab or a session draft. Where work will happen is a fact
   * about a run config and the machine it names, never about having a session
   * yet, so both resolve through this one path — including a draft pointed at
   * another host, whose directory only that host can describe. With neither, an
   * empty workspace's own start defaults are the target.
   */
  async refreshEnvironment(
    workspace: SessionEnvironmentWorkspace,
    opts: { sourceId?: string; cwd?: string; level?: GitRefreshLevel; force?: boolean; worktreeRequested?: boolean } = {},
  ): Promise<GitRefreshResult> {
    const sourceId = opts.sourceId ?? workspace.activeTabId
    const run = workspace.runFor(sourceId)
    const cwd = opts.cwd
      ?? run?.gitContext?.worktreePath
      ?? run?.workingDirectory
      ?? workspace.globalDefaults.gitContext?.worktreePath
      ?? workspace.globalDefaults.workingDirectory
    const level = opts.level ?? 'status'
    if (!cwd || cwd === '~') return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no Git working directory.' }
    // The host that holds the directory is the only one that can read it, and
    // the run is what names that host. Resolving its surface also binds it to
    // this directory, so every later status scan follows the same machine.
    const api = run ? (workspace.apiFor?.(sourceId) ?? window.solus) : window.solus
    this.bindCwd(cwd, api)

    const worktreePath = run?.gitContext?.worktreePath
    const worktreeRequested = opts.worktreeRequested
      ?? (run ? !!run.worktree : workspace.settings.worktreeEnabled)
    // The source moved to a different checkout while a read was in flight, so
    // its answer describes a directory the source has left.
    const movedAway = (): boolean => {
      const current = workspace.runFor(sourceId)
      if (!current) return true
      return (current.gitContext?.worktreePath ?? current.workingDirectory) !== cwd
    }

    // On a genuinely cold load nothing can render a session's environment until
    // Git answers: the sidebar can't group it, the home can't offer the worktree
    // toggle. Land identity first — repo + branch, all O(1) — and let the
    // working-tree scan below overwrite it. Both passes agree on every field, so
    // nothing re-keys or flickers. A cold target has no checkout yet, so the
    // provisional answer is always a plain branch.
    const coldTarget = run
      ? run.gitContext === null
      : workspace.tabOrder.length === 0 && !workspace.globalDefaults.gitContext
    if (coldTarget && this.statusFor(cwd) === undefined) {
      const identity = await api.gitIdentity(cwd).catch(() => null)
      const stale = run ? movedAway() : workspace.globalDefaults.workingDirectory !== cwd
      if (identity && !stale) {
        const provisional = {
          gitContext: gitCheckoutFromState(identity),
          worktreeBaseBranch: worktreeRequested ? identity.targetBranch : null,
        }
        if (run) {
          run.gitContext = provisional.gitContext
          run.worktree = worktreeRequested ? { baseBranch: provisional.worktreeBaseBranch } : null
        } else {
          workspace.config.applyGlobalStartTarget(provisional)
        }
      }
    }

    const resolved = await this.resolveSessionStartTarget(cwd, {
      force: opts.force,
      worktreePath,
      worktreeRequested,
      fallbackGitContext: run?.gitContext ?? null,
    })
    if (!resolved.target) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t read the working tree', resolved.error) }
    }
    const { gitContext, worktreeBaseBranch } = resolved.target

    // Landing a result on a source that has moved on is not a failure; report it
    // as superseded so callers don't flash a misleading error.
    const supersededError = 'The environment changed during refresh — try again.'
    if (run) {
      if (movedAway()) {
        return { status: true, details: false, refs: false, registration: false, ok: false, error: supersededError }
      }
      run.gitContext = gitContext
      // Keep the request even when this host named no branch to fork from, or an
      // unresolvable checkout would silently cancel the worktree.
      run.worktree = worktreeRequested ? { baseBranch: worktreeBaseBranch } : null
      // A draft has no session for the host to hold an environment against, and
      // nothing is running in it yet — registration waits until Send makes one.
      if (workspace.sessionFor(sourceId)) {
        let registrationError: string | undefined
        try {
          await api.gitRegisterEnvironment(
            $state.snapshot(workspace.ctxFor(sourceId)),
            cwd,
            $state.snapshot(gitContext),
          )
        } catch (error) {
          registrationError = gitErrorText(error)
        }
        if (registrationError !== undefined) {
          return { status: true, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t register the Git environment', registrationError) }
        }
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
    if (projectRoot) this.bindCwd(projectRoot, api)
    const refsOutcome: GitFacetOutcome = level !== 'full' || !projectRoot
      ? { ok: true }
      : await this.refreshRefsOutcome(projectRoot, workspace.ctxFor(sourceId), { force: true })
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
    const promise = this.apiForCwd(cwd).gitRefreshState(cwd, includeDetails
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
    // A draft has no session to resolve a surface through, so fall back to the
    // host this project root is already bound to rather than to this machine.
    const api = (ctx.session.sessionId ? this.workspace?.apiForSession?.(ctx.session.sessionId) : null)
      ?? this.apiForCwd(projectRoot)
    this.bindCwd(projectRoot, api)
    const promise = Promise.allSettled([
      api.worktreeListProject($state.snapshot(ctx)),
      api.worktreeBranches($state.snapshot(ctx)),
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

export const [getSessionEnvironmentStore, setSessionEnvironmentStore] = createAppContext<SessionEnvironmentStore>('session-environment')
