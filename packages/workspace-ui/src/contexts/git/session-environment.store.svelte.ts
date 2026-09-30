import { CheckoutStore } from './checkout.store.svelte'
import { createAppContext } from '../app/create-app-context'
import { gitCheckoutFromState, sameGitCheckout, worktreeProjectRoot, type GitCheckout, type GitProjectRefs, type GitState, type GitStateOptions, type IpcContext, type RunConfig, type Session, type WorktreeEntry } from '@solus/contracts/types'
import { formatBranchDisplayName } from '../../lib/git-context'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { hostRolesStore } from '../connections/host-roles.store.svelte'

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

interface GitStatusOutcome extends GitFacetOutcome {
  /** The status answer carried the project's refs too, so no refs scan is owed. */
  refsApplied?: boolean
}

/** What the host was last told a session's checkout is, and on which
 *  connection, so an unchanged checkout is not registered again. */
interface RegisteredGitEnvironment {
  serverId: string
  generation: number
  cwd: string
  gitContext: GitCheckout | null
}

/** Which reads of a checkout another open session already keeps current. */
interface LiveFacets {
  status: boolean
  details: boolean
  refs: boolean
}

const NO_LIVE_FACETS: LiveFacets = { status: false, details: false, refs: false }

/** How long a details read of a watched checkout is trusted without a change. */
const DETAILS_CURRENT_MS = 60_000

function withoutRefs({ refs: _refs, ...status }: GitState): GitState {
  return status
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

export interface SessionEnvironmentWorkspace {
  activeTabId: string
  tabOrder: string[]
  /** Where work happens when no source names a run of its own. */
  readonly defaultRunConfig: RunConfig
  /** The run a source owns. A tab and a session draft both hold one in the same
   *  position, which is why neither needs its own environment refresh. */
  runFor(sourceId: string): RunConfig | undefined
  /** Only a started session has one — the answer to "is there something for the
   *  host to register this environment against". */
  sessionFor(sourceId: string): Session | undefined
  ctxFor(sourceId: string): IpcContext
  apiFor?(sourceId: string): HostApi
  /** The host that surface belongs to, named by the run rather than recovered
   *  from the API object. Present exactly when `apiFor` is. */
  serverIdFor?(sourceId: string): string
  apiForSession?(sessionId: string): HostApi
  /** The branch the organization set for new worktrees of this run's project,
   *  or null to use the repository's own default (docs/plans/project-model.md §7). */
  projectDefaultBranchFor?(run: RunConfig): string | null
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
  constructor(readonly checkouts = new CheckoutStore()) {}
  byCwd = $state<Record<string, GitState | null>>({})
  refsByRoot = $state<Record<string, GitProjectRefs>>({})
  private workspace: SessionEnvironmentWorkspace | null = null
  private inflight = new Map<string, Promise<GitFacetOutcome>>()
  private refsInflight = new Map<string, Promise<GitFacetOutcome>>()
  private refsLoading = new SvelteSet<string>()
  private lastRefresh = new Map<string, number>()
  private detailsLastRefresh = new Map<string, number>()
  private refsLastRefresh = new Map<string, number>()
  private detailWatchers = new Map<string, number>()
  private detailRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private versions = new Map<string, number>()
  private dispatchRootByTarget = new SvelteMap<string, string | null>()
  private dispatchBranchesByTarget = new SvelteMap<string, string[]>()
  private dispatchBranchesLoading = new SvelteSet<string>()
  private dispatchRefsInflight = new Map<string, Promise<boolean>>()
  private registrations = new WeakMap<Session, RegisteredGitEnvironment>()
  /** A registration still on the wire. Boot runs several refreshes for one
   *  session at once; the later ones join this rather than asking again. */
  private registrationsInflight = new WeakMap<Session, { fingerprint: string; promise: Promise<string | undefined> }>()
  private readonly registrationGenerationByServerId = new Map<string, number>()

  bindWorkspace(workspace: SessionEnvironmentWorkspace): void {
    this.workspace = workspace
  }

  /** A restarted host has forgotten its session-to-checkout registry. The next
   * environment refresh must restore it even when the checkout did not change. */
  invalidateRegistrationsForHost(serverId: string): void {
    const generation = this.registrationGenerationByServerId.get(serverId) ?? 0
    this.registrationGenerationByServerId.set(serverId, generation + 1)
  }

  private statusForHost(serverId: string, cwd: string): GitState | null | undefined {
    return this.byCwd[hostKey(serverId, cwd)]
  }

  private refsForHost(serverId: string, projectRoot: string): GitProjectRefs {
    const refs = this.refsByRoot[hostKey(serverId, projectRoot)]
    if (!refs) return { worktrees: [], branches: [] }
    return {
      branches: refs.branches,
      worktrees: refs.worktrees.map((entry) => {
        const state = this.checkouts.get(serverId, entry.path)
        return state ? { ...entry, branch: state.checkout?.branch ?? '' } : entry
      }),
    }
  }

  /**
   * One projection for every surface that displays where a session runs.
   *
   * Takes the run config rather than a tab id: an environment is a function of
   * three of its fields and nothing else, so a session draft — which has no tab
   * and no session — projects through exactly the same path as a started tab.
   * `undefined` means "nothing chosen yet", which falls back to the default run.
   */
  environmentFor(run?: RunConfig | null): SessionEnvironment {
    if (!this.workspace) throw new Error('SessionEnvironmentStore must be bound to a workspace')
    const target = run ?? this.workspace.defaultRunConfig
    const attachedCheckout = target.gitContext
    // "Will branch" and "branches from X" are separate questions: a run can want
    // a worktree before the host has said which branch it would fork from.
    const wantsWorktree = !!target.worktree
    const worktreeBaseBranch = target.worktree?.baseBranch ?? null
    const cwd = target.gitContext?.worktreePath ?? target.workingDirectory
    const status = this.statusFor(target.serverId, cwd)
    const checkout = this.checkouts.resolve(target.serverId, cwd, gitCheckoutFromState(status, attachedCheckout?.worktreePath, attachedCheckout?.repoRoot) ?? attachedCheckout)
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
   *
   * A refresh reads the host by default, which is what a caller needs after a
   * Git mutation. `force: false` accepts the store's live state: when an open
   * session is registered on the same host, directory, and checkout, the host's
   * watcher already keeps that status live, so the source takes it instead of
   * reading it again.
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
      ?? workspace.defaultRunConfig.workingDirectory
    const level = opts.level ?? 'status'
    if (!cwd || cwd === '~') return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no Git working directory.' }
    // The host that holds the directory is the only one that can read it, and
    // the run is what names that host. A host this client does not know (it was
    // deleted) or one that runs nothing (the workspace service) has no checkout.
    const serverId = workspace.serverIdFor?.(sourceId)
    if (serverId && !hostRolesStore.hasExecution(serverId)) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no machine to read Git from.' }
    }
    const api = workspace.apiFor?.(sourceId)
    if (!api || !serverId) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: 'This session has no host binding.' }
    }

    const worktreePath = run?.gitContext?.worktreePath
    const worktreeRequested = opts.worktreeRequested
      ?? !!run?.worktree
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
    // provisional answer is always a plain branch. With no run there is nothing
    // to land it on: the default run projects from the status cache alone.
    if (run && run.gitContext === null && this.statusForHost(serverId, cwd) === undefined) {
      const identity = await api.gitIdentity(cwd).catch(() => null)
      if (identity && !movedAway()) {
        run.gitContext = gitCheckoutFromState(identity)
        run.worktree = worktreeRequested ? { baseBranch: identity.targetBranch } : null
      }
    }

    const reused = opts.force === false
      ? this.liveFacets(workspace, serverId, cwd, run?.gitContext ?? null)
      : NO_LIVE_FACETS

    const resolved = await this.resolveSessionStartTarget(serverId, cwd, {
      force: opts.force,
      reuseKnownStatus: reused.status,
      worktreePath,
      worktreeRequested,
      fallbackGitContext: run?.gitContext ?? null,
    })
    if (!resolved.target) {
      return { status: false, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t read the working tree', resolved.error) }
    }
    const { gitContext } = resolved.target
    // The project's shared default branch, when the organization set one, is
    // where a new worktree starts; else the branch the host detected.
    const worktreeBaseBranch = (run && worktreeRequested ? workspace.projectDefaultBranchFor?.(run) : null)
      ?? resolved.target.worktreeBaseBranch

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
      const session = workspace.sessionFor(sourceId)
      if (session) {
        const registrationError = await this.registerCheckout(api, serverId, session, workspace.ctxFor(sourceId), cwd, gitContext)
        if (registrationError !== undefined) {
          return { status: true, details: false, refs: false, registration: false, ok: false, error: gitFailure('Couldn’t register the Git environment', registrationError) }
        }
      }
    }

    // A full refresh asks for refs on the same round trip as the details. A
    // reused checkout skips each facet another source has already read.
    const detailsOutcome: GitStatusOutcome = level === 'status' || reused.details
      ? { ok: true }
      : await this.refreshStatusForHost(serverId, cwd, { force: true, details: true, bypassCache: true, refs: level === 'full' && !reused.refs })
    const currentStatus = this.statusForHost(serverId, cwd)
    const projectRoot = currentStatus?.repoRoot ?? gitContext?.repoRoot
    // A host that predates refs-with-status answers without them; scan separately.
    const refsOutcome: GitFacetOutcome = level !== 'full' || !projectRoot || reused.refs || detailsOutcome.refsApplied
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

  /** Tell the host which checkout a session runs in, once per distinct answer
   *  per connection. Resolves to the failure text, or undefined when the host
   *  now knows — including when it already did. */
  private async registerCheckout(
    api: HostApi,
    serverId: string,
    session: Session,
    ctx: IpcContext,
    cwd: string,
    gitContext: GitCheckout | null,
  ): Promise<string | undefined> {
    const effectiveCwd = gitContext?.worktreePath ?? cwd
    const generation = this.registrationGenerationByServerId.get(serverId) ?? 0
    const previous = this.registrations.get(session)
    const unchanged = previous?.serverId === serverId
      && previous.generation === generation
      && previous.cwd === effectiveCwd
      && sameGitCheckout(previous.gitContext, gitContext)
    if (unchanged) return undefined
    const fingerprint = JSON.stringify([serverId, generation, effectiveCwd, gitContext])
    const inflight = this.registrationsInflight.get(session)
    if (inflight?.fingerprint === fingerprint) return inflight.promise
    const promise = api.gitRegisterEnvironment($state.snapshot(ctx), cwd, $state.snapshot(gitContext))
      .then((): undefined => {
        // A copy: the same object becomes the run's reactive checkout, and a
        // later in-place branch update must not rewrite this record.
        this.registrations.set(session, {
          serverId,
          generation,
          cwd: effectiveCwd,
          gitContext: gitContext ? { ...gitContext } : null,
        })
        return undefined
      }, gitErrorText)
      .finally(() => {
        if (this.registrationsInflight.get(session)?.promise === promise) this.registrationsInflight.delete(session)
      })
    this.registrationsInflight.set(session, { fingerprint, promise })
    return promise
  }

  /** The facets of a checkout this store already holds live, so a source there
   *  need not read them again. Nothing is live unless an open session keeps the
   *  host watching the checkout. */
  private liveFacets(
    workspace: SessionEnvironmentWorkspace,
    serverId: string,
    cwd: string,
    gitContext: GitCheckout | null,
  ): LiveFacets {
    const status = this.statusForHost(serverId, cwd)
    if (status === undefined || !this.isWatchedByHost(workspace, serverId, cwd, gitContext)) {
      return NO_LIVE_FACETS
    }
    return {
      status: true,
      details: this.hasCurrentDetails(hostKey(serverId, cwd)),
      refs: !!status && hostKey(serverId, status.repoRoot) in this.refsByRoot,
    }
  }

  /** Details are not pushed. A details read stays current until a status change
   *  lands with no surface watching details, or until it is too old to trust. */
  private hasCurrentDetails(key: string): boolean {
    const readAt = this.detailsLastRefresh.get(key)
    return readAt !== undefined && Date.now() - readAt < DETAILS_CURRENT_MS
  }

  /** Whether an open session is registered on this checkout with the current
   *  host generation. The host watches every registered checkout and pushes its
   *  status, so this is when a cached status is still live. A source with no
   *  checkout yet is a new tab in that directory, which shares it. */
  private isWatchedByHost(
    workspace: SessionEnvironmentWorkspace,
    serverId: string,
    cwd: string,
    gitContext: GitCheckout | null,
  ): boolean {
    const generation = this.registrationGenerationByServerId.get(serverId) ?? 0
    return workspace.tabOrder.some((tabId) => {
      const session = workspace.sessionFor(tabId)
      const registered = session ? this.registrations.get(session) : undefined
      return registered?.serverId === serverId
        && registered.generation === generation
        && registered.cwd === cwd
        && (!gitContext || sameGitCheckout(registered.gitContext, gitContext))
    })
  }

  /** Register a checkout the caller resolved itself — a resume reads identity on
   *  its critical path — so the refresh that follows finds it already known and
   *  does not register it a second time. Failure is left to that refresh. */
  async registerEnvironment(
    workspace: SessionEnvironmentWorkspace,
    sourceId: string,
    cwd: string,
    gitContext: GitCheckout | null,
  ): Promise<void> {
    const session = workspace.sessionFor(sourceId)
    const api = workspace.apiFor?.(sourceId)
    const serverId = workspace.serverIdFor?.(sourceId)
    if (!session || !api || !serverId) return
    await this.registerCheckout(api, serverId, session, workspace.ctxFor(sourceId), cwd, gitContext)
  }

  /** Resolve where a session will start. Callers apply this snapshot as one unit
   * so directory, checkout, and worktree intent cannot come from different
   * refresh ticks. */
  private async resolveSessionStartTarget(
    serverId: string,
    workingDirectory: string,
    options: {
      force?: boolean
      reuseKnownStatus?: boolean
      worktreePath?: string
      worktreeRequested: boolean
      fallbackGitContext?: GitCheckout | null
    },
  ): Promise<{ target: SessionStartTarget | null; error?: string }> {
    if (!options.reuseKnownStatus) {
      const statusOutcome = await this.refreshStatusForHost(serverId, workingDirectory, { force: options.force ?? true })
      if (!statusOutcome.ok) return { target: null, error: statusOutcome.error }
    }

    await this.checkouts.ensure(serverId, workingDirectory)
    const status = this.statusForHost(serverId, workingDirectory) ?? null
    const detected = gitCheckoutFromState(status, options.worktreePath, options.fallbackGitContext?.repoRoot)
    // Retain worktree routing while detached instead of treating a valid
    // checkout as a non-repository.
    const gitContext = this.checkouts.resolve(serverId, workingDirectory, detected
      ?? (status && options.worktreePath ? options.fallbackGitContext ?? null : null))
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
  async refresh(serverId: string, cwd: string, opts: { force?: boolean; details?: boolean; bypassCache?: boolean } = {}): Promise<boolean> {
    return (await this.refreshStatusForHost(serverId, cwd, opts)).ok
  }

  /** Status/details scan that also carries the failure reason, for callers that
   *  report it (e.g. the Environment panel's refresh button). */
  private async refreshStatusForHost(
    serverId: string,
    cwd: string,
    opts: { force?: boolean; details?: boolean; bypassCache?: boolean; refs?: boolean } = {},
  ): Promise<GitStatusOutcome> {
    const key = hostKey(serverId, cwd)
    const includeDetails = opts.details === true
    // Refs only ride along with a details scan; a summary stays the cheap read
    // the watcher and every completed edit can afford.
    const includeRefs = includeDetails && opts.refs === true
    const now = Date.now()
    const refreshTimes = includeDetails ? this.detailsLastRefresh : this.lastRefresh
    const last = refreshTimes.get(key) ?? 0
    if (!opts.force && now - last < 2_000) return { ok: true }
    // The host pushes a watched checkout's status, so the cache already holds it.
    if (!opts.force && !includeDetails && this.isLive(serverId, cwd)) return { ok: true }
    const inflightKey = `${key}\0${includeRefs ? 'details+refs' : includeDetails ? 'details' : 'summary'}`
    const existing = this.inflight.get(inflightKey)
    // A forced lifecycle refresh must observe state after the existing scan,
    // rather than silently joining a request that may predate a Git mutation.
    if (existing) {
      if (!opts.force) return existing
      await existing
      return this.refreshStatusForHost(serverId, cwd, opts)
    }
    const version = this.versions.get(key) ?? 0
    // A path names a folder on one machine only, so the read goes to its host.
    const api = serverConnections.apiFor(serverId)
    if (includeRefs) this.refsLoading.add(key)
    let requestOptions: GitStateOptions | undefined
    if (includeDetails) {
      requestOptions = { includeDetails: true, bypassCache: opts.bypassCache === true }
      if (includeRefs) requestOptions.includeRefs = true
    }
    const promise = api.gitRefreshState(cwd, requestOptions)
      .then((answer): GitStatusOutcome => {
        // Refs are not status: they are keyed by project, not checkout, and a
        // watcher push never supersedes them.
        const refs = answer?.refs
        const plainStatus = answer ? withoutRefs(answer) : null
        // A watcher push that landed while this request ran is newer.
        const superseded = (this.versions.get(key) ?? 0) !== version
        const applied = !superseded && this.applyStatus(serverId, cwd, plainStatus, includeDetails)
        this.lastRefresh.set(key, Date.now())
        // Details count as current only once they reach the store. A read a
        // push superseded is read again for a surface that still shows them.
        if (includeDetails && applied) this.detailsLastRefresh.set(key, Date.now())
        else if (includeDetails && superseded) this.scheduleDetailsRefresh(serverId, cwd)
        if (plainStatus && refs) {
          const refsKey = hostKey(serverId, plainStatus.repoRoot)
          this.refsByRoot[refsKey] = refs
          this.refsLastRefresh.set(refsKey, Date.now())
          return { ok: true, refsApplied: true }
        }
        return { ok: true }
      })
      .catch((error): GitStatusOutcome => ({ ok: false, error: gitErrorText(error) }))
      .finally(() => {
        this.inflight.delete(inflightKey)
        if (includeRefs) this.refsLoading.delete(key)
      })
    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** Land a status pushed from the main-process Git watcher. */
  set(serverId: string, cwd: string, status: GitState | null): void {
    const key = hostKey(serverId, cwd)
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
    const prev = this.byCwd[key]
    const next = this.statusWithVisibleDetails(serverId, cwd, status)
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) {
      this.lastRefresh.set(key, Date.now())
      return
    }
    this.byCwd[key] = next
    this.lastRefresh.set(key, Date.now())
    this.onStatusChanged(serverId, cwd)
  }

  /** Whether the cached status of this checkout is kept current by host pushes. */
  private isLive(serverId: string, cwd: string): boolean {
    return !!this.workspace
      && this.statusForHost(serverId, cwd) !== undefined
      && this.isWatchedByHost(this.workspace, serverId, cwd, null)
  }

  /** A status change moves the details too: re-read them for a watching
   *  surface, or mark them stale so the next surface to watch reads them. */
  private onStatusChanged(serverId: string, cwd: string): void {
    const key = hostKey(serverId, cwd)
    if (this.detailWatchers.has(key)) this.scheduleDetailsRefresh(serverId, cwd)
    else this.detailsLastRefresh.delete(key)
  }

  watchDetails(serverId: string, cwd: string): () => void {
    const key = hostKey(serverId, cwd)
    const previousCount = this.detailWatchers.get(key) ?? 0
    this.detailWatchers.set(key, previousCount + 1)
    // A reactive consumer can unsubscribe and subscribe again while the same
    // checkout remains visible. Only the first live consumer starts a scan;
    // later consumers share the same status and refresh timer. A tab switch
    // back to a watched checkout whose details are current reads nothing.
    if (previousCount === 0 && !(this.isLive(serverId, cwd) && this.hasCurrentDetails(key))) {
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

  /** Whether the answer landed; a details answer for another checkout does not. */
  private applyStatus(serverId: string, cwd: string, status: GitState | null, includeDetails: boolean): boolean {
    const key = hostKey(serverId, cwd)
    const current = this.byCwd[key]
    if (includeDetails) {
      // The Environment panel can be the first consumer for a cwd. Its detail
      // request must establish the terminal non-repository state instead of
      // leaving the panel on its `undefined` (loading) sentinel forever.
      if (!status) {
        if (current === undefined) this.byCwd[key] = null
        return true
      }
      if (current === null) return false
      if (current && (current.repoRoot !== status.repoRoot || current.branch !== status.branch)) return false
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
      return true
    }
    const next = this.statusWithVisibleDetails(serverId, cwd, status)
    if (JSON.stringify(this.byCwd[key]) === JSON.stringify(next)) return true
    this.byCwd[key] = next
    this.onStatusChanged(serverId, cwd)
    return true
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
      if (this.detailWatchers.has(key)) void this.refreshStatusForHost(serverId, cwd, { details: true })
    }, 150)
    this.detailRefreshTimers.set(key, timer)
  }

  statusFor(serverId: string, cwd: string | null | undefined): GitState | null | undefined {
    if (!cwd) return undefined
    const status = this.statusForHost(serverId, cwd)
    const state = this.checkouts.get(serverId, cwd)
    if (!state || !status) return status
    if (!state.checkout) return null
    const checkout = state.checkout
    if (status.branch === checkout.branch && (!checkout.detachedHeadSha || status.headSha === checkout.detachedHeadSha)) return status
    return { ...status, branch: checkout.branch, headSha: checkout.detachedHeadSha ?? status.headSha, targetBranch: checkout.targetBranch, prUrl: undefined }
  }

  async refreshRefs(serverId: string, projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<boolean> {
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
    const api = serverConnections.apiFor(serverId)
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
      .finally(() => {
        this.refsInflight.delete(key)
        this.refsLoading.delete(key)
      })
    this.refsInflight.set(key, promise)
    this.refsLoading.add(key)
    return promise
  }

  refsFor(serverId: string, projectRoot: string | null | undefined): GitProjectRefs {
    if (!projectRoot) return { worktrees: [], branches: [] }
    return this.refsForHost(serverId, projectRoot)
  }

  /** Whether a worktree/branch scan is in flight for this project, so a picker
   *  that has nothing cached yet can say it is loading rather than say the repo
   *  has no branches. */
  refsLoadingFor(serverId: string, projectRoot: string | null | undefined): boolean {
    if (!projectRoot) return false
    return this.refsLoading.has(hostKey(serverId, projectRoot))
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
