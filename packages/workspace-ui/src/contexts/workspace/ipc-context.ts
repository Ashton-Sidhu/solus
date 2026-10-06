import type { GitCheckout, IpcContext, PrReviewContext, RunConfig, Session, SessionCtx } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import { isDispatch } from './run-config'

export interface IpcContextBuilderDeps {
  sessionFor(tabId: string): Session | undefined
  /** The run behind a source id, whether a tab or a draft owns it. */
  runFor(sourceId: string): RunConfig | undefined
  /** Whether a source id names a draft rather than a tab. */
  hasDraft(sourceId: string): boolean
  /** The run a source with none of its own stands on — `WorkspaceContext.defaultRunConfig`. */
  defaultRunConfig(): RunConfig
  checkoutForRun?(run: RunConfig): GitCheckout | null
  /** The organization this window works in (organization-scope R11); null with none. */
  activeOrganizationId?(): string | null
  settings: SettingsContext
  statusBar: StatusBarContext
}

export class IpcContextBuilder {
  constructor(private deps: IpcContextBuilderDeps) {}

  forTab(tabId: string): IpcContext {
    const session = this.sessionCtx(tabId)
    return {
      session,
      settings: this.deps.settings.ctxForProject?.(this.serverIdOf(tabId), session.projectPath) ?? this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctxFor(tabId),
    }
  }

  forDirectory(tabId: string, workingDirectory: string): IpcContext {
    const base = this.sessionCtx(tabId)
    return {
      session: { ...base, workingDirectory, projectPath: worktreeProjectRoot(workingDirectory) },
      settings: this.deps.settings.ctxForProject?.(this.serverIdOf(tabId), worktreeProjectRoot(workingDirectory)) ?? this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  /** Context for project/environment operations that do not require a chat tab. */
  forEnvironment(tabId: string, workingDirectory: string, gitContext: GitCheckout | null): IpcContext {
    const context = this.forDirectory(tabId, workingDirectory)
    context.session.gitContext = gitContext ? { ...gitContext } : null
    return context
  }

  /**
   * Context for a session the surface knows only by its Solus id — Insights
   * reading a turn's change with no tab for the session. It names the session
   * and nothing else: the host resolves the provider thread and the checkout
   * from the id, so no field of the active tab can stand in for them.
   */
  forSessionRecord(sessionId: string): IpcContext {
    const base = this.sessionCtx('')
    return {
      session: {
        ...base,
        sessionId,
        agentSessionId: null,
        handoffFrom: undefined,
        workingDirectory: '',
        projectPath: '',
        additionalDirs: [],
        gitContext: null,
        sessionChangedFiles: [],
      },
      settings: this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  /** The host a source's run is on: review warming is that host's per-project setting. */
  private serverIdOf(sourceId: string): string {
    return (this.deps.runFor(sourceId) ?? this.deps.defaultRunConfig()).serverId
  }

  /** The window's organization rides every prompt (R11): the host assigns an
   *  unassigned session to it once, when Insights apply, and never reassigns. */
  private windowOrganizationId(): string | undefined {
    return this.deps.activeOrganizationId?.() ?? undefined
  }

  sessionCtx(sourceId: string): SessionCtx {
    const session = this.deps.sessionFor(sourceId)
    // Where the work happens comes from the run — a started session's or a
    // draft's, else the default one — while everything below it describes a
    // conversation and so only exists once one has started.
    const ownRun = this.deps.runFor(sourceId)
    const run = ownRun ?? this.deps.defaultRunConfig()
    const { workingDirectory, modelConfig } = run
    const gitContext = this.deps.checkoutForRun ? this.deps.checkoutForRun(run) : run.gitContext
    const sessionExtras = session
      ? {
          forked: session.forked ?? false,
          forkExcludeLatestTurn: session.forkExcludeLatestTurn,
          // Deep plain-object copy: session.prReview is a Svelte $state proxy with a
          // nested headRepo, and proxies aren't structured-cloneable over IPC. A
          // shallow spread wouldn't unwrap headRepo; this file is plain .ts so no
          // $state.snapshot — JSON round-trip is safe for this pure-data struct.
          // SAFETY: the JSON round-trip only unwraps the Svelte proxy from this PrReviewContext.
          prReview: session.prReview ? (JSON.parse(JSON.stringify(session.prReview)) as PrReviewContext) : null,
        }
      : {}

    const context: SessionCtx = {
      sessionId: session?.id ?? '',
      provider: ownRun?.provider ?? null,
      agentSessionId: session ? session.agentSessionId : null,
      handoffFrom: session?.handoffFrom,
      status: session ? session.status : 'idle',
      workingDirectory,
      projectPath: worktreeProjectRoot(workingDirectory),
      additionalDirs: session ? [...session.additionalDirs] : [],
      preferredModel: modelConfig.modelId,
      reasoningEffort: modelConfig.reasoningEffort,
      contextWindow: modelConfig.contextWindow,
      fastMode: modelConfig.fastMode,
      permissionMode: run.permissionMode,
      gitContext: gitContext ? { ...gitContext } : null,
      worktreeBaseBranch: run.worktree?.baseBranch ?? null,
      sessionChangedFiles: session ? [...session.sessionChangedFiles] : [],
      readOnlyReason: session ? session.readOnlyReason : null,
      title: session?.title ?? null,
      organizationId: this.windowOrganizationId(),
      ...sessionExtras,
    }
    if (ownRun && isDispatch(ownRun)) context.origin = 'dispatch'
    // A draft names itself so host-side per-conversation storage — attachment
    // uploads — has a bucket before a session id exists.
    if (!session && sourceId && this.deps.hasDraft(sourceId)) context.draftId = sourceId
    return context
  }
}
