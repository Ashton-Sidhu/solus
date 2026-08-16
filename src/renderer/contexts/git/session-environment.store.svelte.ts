import { createAppContext } from '../app/create-app-context'
import { gitCheckoutFromState, worktreeProjectRoot, type GitCheckout, type GitState, type IpcContext, type RunConfig, type Session, type WorktreeEntry } from '../../../shared/types'
import { formatBranchDisplayName } from '../../lib/git-context'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import { serverConnections } from '@client-core/server-connections'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

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

function gitErrorText(error: Parameters<typeof String>[0]): string {
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
  apiFor?(sourceId: string): HostApi
  apiForSession?(sessionId: string): HostApi
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
  private apiByCwd = new Map<string, HostApi>()
  private serverIdByCwd = new Map<string, string>()
  private dispatchRootByTarget = new SvelteMap<string, string | null>()
  private dispatchBranchesByTarget = new SvelteMap<string, string[]>()
  private dispatchBranchesLoading = new SvelteSet<string>()
  private dispatchRefsInflight = new Map<string, Promise<boolean>>()

  bindWorkspace(workspace: SessionEnvironmentWorkspace): void {
    this.workspace = workspace
  }

  bindCwd(serverId: string, cwd: string | null | undefined, api: HostApi): void {
    if (!cwd || cwd === '~') return
    this.serverIdByCwd.set(cwd, serverId)
    this.apiByCwd.set(hostKey(serverId, cwd), api)
  }

  private apiForCwd(serverId: string, cwd: string): HostApi | undefined {
    return this.apiByCwd.get(hostKey(serverId, cwd))
  }

  private boundServerIdFor(cwd: string): string | undefined {
    return this.serverIdByCwd.get(cwd)
  }

  private statusForHost(serverId: string, cwd: string): GitState | null | undefined {
    return this.byCwd[hostKey(serverId, cwd)]
  }

  private refsForHost(serverId: string, projectRoot: string): GitProjectRefs {
    return this.refsByRoot[hostKey(serverId, projectRoot)] ?? { worktrees: [], branches: [] }
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
    const api = workspace.apiFor?.(sourceId)
    if (!api) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no host binding.' }
    }
    const serverId = run?.serverId
      ? serverConnections.resolveId(run.serverId)
      : serverConnections.serverIdForApi(api)
    this.bindCwd(serverId, cwd, api)

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
    if (coldTarget && this.statusForHost(serverId, cwd) === undefined) {
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

    const resolved = await this.resolveSessionStartTargetForHost(serverId, cwd, {
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
      : await this.refreshStatusForHost(serverId, cwd, { force: true, details: true, bypassCache: true })
    const currentStatus = this.statusForHost(serverId, cwd)
    const projectRoot = currentStatus?.repoRoot ?? gitContext?.repoRoot
    if (projectRoot) this.bindCwd(serverId, projectRoot, api)
    const refsOutcome: GitFacetOutcome = level !== 'full' || !projectRoot
      ? { ok: true }
      : await this.refreshRefsOutcomeForHost(serverId, projectRoot, workspace.ctxFor(sourceId), { force: true })
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
    const serverId = this.boundServerIdFor(workingDirectory)
    if (!serverId) return { target: null }
    return this.resolveSessionStartTargetForHost(serverId, workingDirectory, options)
  }

  private async resolveSessionStartTargetForHost(
    serverId: string,
    workingDirectory: string,
    options: {
      force?: boolean
      worktreePath?: string
      worktreeRequested: boolean
      fallbackGitContext?: GitCheckout | null
    },
  ): Promise<{ target: SessionStartTarget | null; error?: string }> {
    const statusOutcome = await this.refreshStatusForHost(serverId, workingDirectory, { force: options.force ?? true })
    if (!statusOutcome.ok) return { target: null, error: statusOutcome.error }

    const status = this.statusForHost(serverId, workingDirectory) ?? null
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
    const serverId = this.boundServerIdFor(cwd)
    if (!serverId) return false
    return (await this.refreshStatusForHost(serverId, cwd, opts)).ok
  }

  /** Status/details scan that also carries the failure reason, for callers that
   *  report it (e.g. the Environment panel's refresh button). */
  private async refreshStatusForHost(serverId: string, cwd: string, opts: { force?: boolean; details?: boolean; bypassCache?: boolean } = {}): Promise<GitFacetOutcome> {
    const key = hostKey(serverId, cwd)
    const includeDetails = opts.details === true
    const now = Date.now()
    const refreshTimes = includeDetails ? this.detailsLastRefresh : this.lastRefresh
    const last = refreshTimes.get(key) ?? 0
    if (!opts.force && now - last < 2_000) return { ok: true }
    const inflightKey = `${key}\0${includeDetails ? 'details' : 'summary'}`
    const existing = this.inflight.get(inflightKey)
    // A forced lifecycle refresh must observe state after the existing scan,
    // rather than silently joining a request that may predate a Git mutation.
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshStatusForHost(serverId, cwd, opts)
    }
    const version = this.versions.get(key) ?? 0
    const api = this.apiForCwd(serverId, cwd)
    if (!api) return { ok: false }
    const promise = api.gitRefreshState(cwd, includeDetails
      ? { includeDetails: true, bypassCache: opts.bypassCache === true }
      : undefined)
      .then((status): GitFacetOutcome => {
        // A watcher push that landed while this request ran is newer.
        if ((this.versions.get(key) ?? 0) === version) this.applyStatus(serverId, cwd, status, includeDetails)
        this.lastRefresh.set(key, Date.now())
        if (includeDetails) this.detailsLastRefresh.set(key, Date.now())
        else this.scheduleDetailsRefresh(serverId, cwd)
        return { ok: true }
      })
      .catch((error): GitFacetOutcome => ({ ok: false, error: gitErrorText(error) }))
      .finally(() => this.inflight.delete(inflightKey))
    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** Land a status pushed from the main-process Git watcher. */
  set(cwd: string, status: GitState | null): void {
    const serverId = this.boundServerIdFor(cwd)
    if (!serverId) return
    const key = hostKey(serverId, cwd)
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
    const prev = this.byCwd[key]
    const next = this.statusWithVisibleDetails(serverId, cwd, status)
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) {
      this.lastRefresh.set(key, Date.now())
      this.scheduleDetailsRefresh(serverId, cwd)
      return
    }
    this.byCwd[key] = next
    this.lastRefresh.set(key, Date.now())
    this.scheduleDetailsRefresh(serverId, cwd)
  }

  watchDetails(serverId: string, cwd: string): () => void {
    const key = hostKey(serverId, cwd)
    const previousCount = this.detailWatchers.get(key) ?? 0
    this.detailWatchers.set(key, previousCount + 1)
    // A reactive consumer can unsubscribe and subscribe again while the same
    // checkout remains visible. Only the first live consumer starts a scan;
    // later consumers share the same status and refresh timer.
    if (previousCount === 0) {
      void this.refreshStatusForHost(serverId, cwd, { force: true, details: true })
    }
    return () => {
      const remaining = (this.detailWatchers.get(key) ?? 1) - 1
      if (remaining > 0) {
        this.detailWatchers.set(key, remaining)
        return
      }
      this.detailWatchers.delete(key)
      const timer = this.detailRefreshTimers.get(key)
      if (timer) clearTimeout(timer)
      this.detailRefreshTimers.delete(key)
    }
  }

  private applyStatus(serverId: string, cwd: string, status: GitState | null, includeDetails: boolean): void {
    const key = hostKey(serverId, cwd)
    const current = this.byCwd[key]
    if (includeDetails) {
      // The Environment panel can be the first consumer for a cwd. Its detail
      // request must establish the terminal non-repository state instead of
      // leaving the panel on its `undefined` (loading) sentinel forever.
      if (!status) {
        if (current === undefined) this.byCwd[key] = null
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
            targetAheadCount: status.targetAheadCount,
            prUrl: status.prUrl,
          }
        : status
      if (JSON.stringify(current) !== JSON.stringify(next)) this.byCwd[key] = next
      return
    }
    const next = this.statusWithVisibleDetails(serverId, cwd, status)
    if (JSON.stringify(this.byCwd[key]) !== JSON.stringify(next)) this.byCwd[key] = next
  }

  private statusWithVisibleDetails(serverId: string, cwd: string, status: GitState | null): GitState | null {
    const key = hostKey(serverId, cwd)
    const previous = this.byCwd[key]
    if (!status || !previous || !this.detailWatchers.has(key) || previous.branch !== status.branch) return status
    const visibleStatus: GitState = {
      ...status,
      uncommittedChanges: {
        ...status.uncommittedChanges,
        insertions: previous.uncommittedChanges.insertions,
        deletions: previous.uncommittedChanges.deletions,
      },
    }
    if (previous.targetAheadCount !== undefined) visibleStatus.targetAheadCount = previous.targetAheadCount
    if (previous.prUrl) visibleStatus.prUrl = previous.prUrl
    return visibleStatus
  }

  private scheduleDetailsRefresh(serverId: string, cwd: string): void {
    const key = hostKey(serverId, cwd)
    if (!this.detailWatchers.has(key) || this.detailRefreshTimers.has(key)) return
    const timer = setTimeout(() => {
      this.detailRefreshTimers.delete(key)
      if (this.detailWatchers.has(key)) void this.refreshStatusForHost(serverId, cwd, { force: true, details: true })
    }, 150)
    this.detailRefreshTimers.set(key, timer)
  }

  statusFor(cwd: string | null | undefined): GitState | null | undefined {
    if (!cwd) return undefined
    const serverId = this.boundServerIdFor(cwd)
    return serverId ? this.statusForHost(serverId, cwd) : undefined
  }

  async refreshRefs(projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<boolean> {
    const serverId = this.boundServerIdFor(projectRoot)
    if (!serverId) return false
    return (await this.refreshRefsOutcomeForHost(serverId, projectRoot, ctx, opts)).ok
  }

  /** Refs scan that also carries the failure reason, for callers that report it. */
  private async refreshRefsOutcomeForHost(serverId: string, projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<GitFacetOutcome> {
    const key = hostKey(serverId, projectRoot)
    const now = Date.now()
    const last = this.refsLastRefresh.get(key) ?? 0
    if (!opts.force && now - last < 5_000) return { ok: true }
    const existing = this.refsInflight.get(key)
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshRefsOutcomeForHost(serverId, projectRoot, ctx, opts)
    }
    const api = this.apiForCwd(serverId, projectRoot)
    if (!api) return { ok: false }
    const promise = Promise.allSettled([
      api.worktreeListProject($state.snapshot(ctx)),
      api.worktreeBranches($state.snapshot(ctx)),
    ])
      .then(([worktreesResult, branchesResult]): GitFacetOutcome => {
        const previous = this.refsForHost(serverId, projectRoot)
        const worktrees = worktreesResult.status === 'fulfilled' ? worktreesResult.value : previous.worktrees
        const branches = branchesResult.status === 'fulfilled' ? branchesResult.value : previous.branches
        this.refsByRoot[key] = { worktrees, branches }
        const ok = worktreesResult.status === 'fulfilled' && branchesResult.status === 'fulfilled'
        if (ok) this.refsLastRefresh.set(key, Date.now())
        const rejected = worktreesResult.status === 'rejected'
          ? worktreesResult.reason
          : branchesResult.status === 'rejected'
            ? branchesResult.reason
            : undefined
        return { ok, error: ok ? undefined : gitErrorText(rejected) }
      })
      .finally(() => this.refsInflight.delete(key))
    this.refsInflight.set(key, promise)
    return promise
  }

  refsFor(projectRoot: string | null | undefined): GitProjectRefs {
    if (!projectRoot) return { worktrees: [], branches: [] }
    const serverId = this.boundServerIdFor(projectRoot)
    return serverId ? this.refsForHost(serverId, projectRoot) : { worktrees: [], branches: [] }
  }

  /** Existing isolated worktrees from this device's checkout on the selected
   * host. The base checkout is absent because dispatched sessions stay isolated. */
  dispatchWorktreesFor(run: RunConfig | null | undefined): WorktreeEntry[] {
    const pending = run?.pendingHostDispatch
    if (pending?.intent !== 'dispatch') return []
    const serverId = serverConnections.resolveId(pending.serverId)
    const root = this.dispatchRootByTarget.get(hostKey(serverId, pending.repoKey))
    if (!root) return []
    return this.refsForHost(serverId, root).worktrees.filter((worktree) => worktree.path !== root)
  }

  /** Origin branches that do not already have a worktree on the target. A
   * branch appears once in the picker: as its existing worktree when present,
   * otherwise as the source for a new target worktree. */
  dispatchBranchesFor(run: RunConfig | null | undefined): string[] {
    const pending = run?.pendingHostDispatch
    if (pending?.intent !== 'dispatch') return []
    const serverId = serverConnections.resolveId(pending.serverId)
    const key = hostKey(serverId, pending.repoKey)
    const branches = this.dispatchBranchesByTarget.get(key) ?? []
    const root = this.dispatchRootByTarget.get(key)
    if (!root) return branches
    const worktreeBranches = new Set(
      this.refsForHost(serverId, root).worktrees
        .filter((worktree) => worktree.path !== root)
        .map((worktree) => worktree.branch),
    )
    return branches.filter((branch) => !worktreeBranches.has(branch))
  }

  dispatchBranchesLoadingFor(run: RunConfig | null | undefined): boolean {
    const pending = run?.pendingHostDispatch
    if (pending?.intent !== 'dispatch') return false
    const serverId = serverConnections.resolveId(pending.serverId)
    return this.dispatchBranchesLoading.has(hostKey(serverId, pending.repoKey))
  }

  /** Load device-scoped target worktrees and source origin branches together. */
  async refreshDispatchWorktrees(
    run: RunConfig | null | undefined,
    ctxForDirectory: (cwd: string) => IpcContext,
  ): Promise<boolean> {
    const pending = run?.pendingHostDispatch
    if (pending?.intent !== 'dispatch') return false
    const serverId = serverConnections.resolveId(pending.serverId)
    const key = hostKey(serverId, pending.repoKey)
    const existing = this.dispatchRefsInflight.get(key)
    if (existing) return existing
    const targetApi = serverConnections.apiFor(serverId)
    const sourceServerId = serverConnections.resolveId(run.serverId)
    const sourceApi = serverConnections.apiFor(sourceServerId)
    const sourceRoot = run.gitContext?.repoRoot
      ?? (run.workingDirectory && run.workingDirectory !== '~' ? worktreeProjectRoot(run.workingDirectory) : null)
    this.dispatchBranchesLoading.add(key)
    const branchesPromise = sourceRoot
      ? sourceApi.worktreeBranches(ctxForDirectory(sourceRoot), { remoteOnly: true })
      : Promise.resolve([])
    const promise = Promise.allSettled([
      targetApi.resolveDispatchHistoryRoots([pending.repoKey]),
      branchesPromise,
    ])
      .then(async ([rootsResult, branchesResult]): Promise<boolean> => {
        const root = rootsResult.status === 'fulfilled'
          ? rootsResult.value.find((candidate) => candidate.repoKey === pending.repoKey)?.path ?? null
          : null
        const branches = branchesResult.status === 'fulfilled' ? branchesResult.value : []
        this.dispatchRootByTarget.set(key, root)
        if (!root) {
          this.dispatchBranchesByTarget.set(key, branches)
          return rootsResult.status === 'fulfilled' && branchesResult.status === 'fulfilled'
        }
        this.bindCwd(serverId, root, targetApi)
        const worktreesOutcome = await this.refreshRefsOutcomeForHost(
          serverId,
          root,
          ctxForDirectory(root),
          { force: true },
        )
        // Do not expose an origin branch until the target worktrees are known.
        // Otherwise a branch that already has a worktree briefly looks new and
        // can create a duplicate when selected during the refresh.
        this.dispatchBranchesByTarget.set(key, branches)
        return worktreesOutcome.ok && branchesResult.status === 'fulfilled'
      })
      .catch(() => false)
      .finally(() => {
        this.dispatchBranchesLoading.delete(key)
        this.dispatchRefsInflight.delete(key)
      })
    this.dispatchRefsInflight.set(key, promise)
    return promise
  }
}

export const [getSessionEnvironmentStore, setSessionEnvironmentStore] = createAppContext<SessionEnvironmentStore>('session-environment')
