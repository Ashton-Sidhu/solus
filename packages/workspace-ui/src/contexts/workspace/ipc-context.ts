import type { GitCheckout, IpcContext, PrReviewContext, RunConfig, Session, SessionCtx, StatusBarCtx } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { isTaskFolderPath } from '@solus/contracts/codebases'
import { sameHostPath } from '@solus/contracts/host-path'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import { checkoutGit, checkoutPlace, codebaseOf, isDispatch, pendingClone, projectHome, refusesCodebase, runHost, workingPlace, worktreeBaseBranch, worktreeRepositories } from './run-location'
import { dispatchRepository } from '../../components/servers/run-on'

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

  /** `checkout` is the checkout of the directory, when the caller has it: it names the repository. */
  forDirectory(tabId: string, workingDirectory: string, checkout?: GitCheckout | null): IpcContext {
    const base = this.sessionCtx(tabId)
    const projectPath = isTaskFolderPath(workingDirectory) && checkout?.repoRoot
      ? checkout.repoRoot
      : this.projectPathOfDirectory(tabId, workingDirectory, base)
    return {
      session: { ...base, workingDirectory, projectPath },
      settings: this.deps.settings.ctxForProject?.(this.serverIdOf(tabId), projectPath) ?? this.deps.settings.ctx,
      statusBar: this.statusBarOf(tabId),
    }
  }

  /**
   * The project folder of a directory that a caller names for a source. The
   * path of a place in a task folder does not name its project
   * (docs/plans/codebases.md §7), so the source says it: the working place of
   * its run has the project of the run, and a session folder has its repository.
   */
  private projectPathOfDirectory(sourceId: string, directory: string, base: SessionCtx): string {
    if (!isTaskFolderPath(directory)) return worktreeProjectRoot(directory)
    const run = this.deps.runFor(sourceId)
    if (run && sameHostPath(workingPlace(run).path, directory)) return base.projectPath
    const folder = this.deps.sessionFor(sourceId)?.sessionFolders.find((each) => sameHostPath(each.path, directory))
    return folder?.repositoryPath ?? directory
  }

  /** The status of the source's own run, so the model always belongs to the
   *  run that names the provider. The active surface's model on a Claude
   *  draft once asked Claude for its commands as `gpt-6-astra`, and the draft
   *  lost the commands that only a Claude model has. */
  private statusBarOf(sourceId: string): StatusBarCtx {
    const run = this.deps.runFor(sourceId)
    return run ? this.deps.statusBar.ctxForRun(run) : this.deps.statusBar.ctx
  }

  /** Context for project/environment operations that do not require a chat tab. */
  forEnvironment(tabId: string, workingDirectory: string, gitContext: GitCheckout | null): IpcContext {
    const context = this.forDirectory(tabId, workingDirectory, gitContext)
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
        codebaseId: null,
        gitContext: null,
        worktreeRepositories: null,
      },
      settings: this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  /** The host a source's run is on: review warming is that host's per-project setting. */
  private serverIdOf(sourceId: string): string {
    return runHost(this.deps.runFor(sourceId) ?? this.deps.defaultRunConfig())
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
    const { modelConfig } = run
    const workingDirectory = checkoutPlace(run).path
    const gitContext = this.deps.checkoutForRun ? this.deps.checkoutForRun(run) : checkoutGit(run)
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
      projectPath: projectPathOf(run, workingDirectory, gitContext),
      ...codebaseFieldsOf(run),
      preferredModel: modelConfig.modelId,
      reasoningEffort: modelConfig.reasoningEffort,
      contextWindow: modelConfig.contextWindow,
      fastMode: modelConfig.fastMode,
      permissionMode: run.permissionMode,
      gitContext: gitContext ? { ...gitContext } : null,
      worktreeBaseBranch: worktreeBaseBranch(run),
      worktreeRepositories: worktreeRepositories(run),
      readOnlyReason: session ? session.readOnlyReason : null,
      title: session?.title ?? null,
      organizationId: this.windowOrganizationId(),
      ...sessionExtras,
    }
    if (ownRun && isDispatch(ownRun)) context.origin = 'dispatch'
    // A clone Send has not made yet: the run's host copies the repository first,
    // and the repository says where the run starts in it.
    const clone = pendingClone(ownRun)
    const repository = clone && dispatchRepository(clone)
    if (repository) {
      context.repository = repository
      context.worktreeBaseBranch = null
    }
    // A draft names itself so host-side per-conversation storage — attachment
    // uploads — has a bucket before a session id exists.
    if (!session && sourceId && this.deps.hasDraft(sourceId)) context.draftId = sourceId
    return context
  }
}

/**
 * The project folder of a run on its run host. A folder in a task folder does
 * not name its project (docs/plans/codebases.md §7): the checkout names its
 * repository, and without one the project home of the run is the member that
 * the folder stands in for. A dispatch has its project home on a different
 * host, so its folder is all that it has.
 */
/** The codebase that a prompt names, or the choice of the person to have none: the host then makes none (docs/plans/codebases.md decision 13). */
function codebaseFieldsOf(run: RunConfig): Pick<SessionCtx, 'codebaseId' | 'noCodebase'> {
  return refusesCodebase(run) ? { codebaseId: null, noCodebase: true } : { codebaseId: codebaseOf(run) }
}

function projectPathOf(run: RunConfig, workingDirectory: string, gitContext: GitCheckout | null): string {
  if (!isTaskFolderPath(workingDirectory)) return worktreeProjectRoot(workingDirectory)
  return gitContext?.repoRoot ?? (isDispatch(run) ? workingDirectory : projectHome(run).path)
}
