import type { GitCheckout, IpcContext, PrReviewContext, RunConfig, Session, SessionCtx } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import type { WindowContext } from '../app/window.context.svelte'
import type { StaticInfo } from './workspace-lifecycle.store.svelte'
import { isDispatch } from './run-config'

export interface IpcContextBuilderDeps {
  sessionFor(tabId: string): Session | undefined
  /** The run behind a source id, whether a tab or a draft owns it. */
  runFor(sourceId: string): RunConfig | undefined
  globalDefaults: {
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: GitCheckout | null
    worktreeBaseBranch: string | null
    modelConfig: {
      modelId: string | null
      reasoningEffort: SessionCtx['reasoningEffort']
      contextWindow: number | null
      fastMode: boolean
    }
  }
  staticInfo(): StaticInfo | null
  window: WindowContext
  settings: SettingsContext
  statusBar: StatusBarContext
}

export class IpcContextBuilder {
  constructor(private deps: IpcContextBuilderDeps) {}

  forActive(tabId: string): IpcContext {
    return this.forTab(tabId)
  }

  forTab(tabId: string): IpcContext {
    const session = this.sessionCtx(tabId)
    return {
      session,
      window: { viewMode: this.deps.window.viewMode },
      settings: this.deps.settings.ctxForProject?.(session.projectPath) ?? this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctxFor(tabId),
    }
  }

  forDirectory(tabId: string, workingDirectory: string): IpcContext {
    const base = this.sessionCtx(tabId)
    return {
      session: { ...base, workingDirectory, projectPath: worktreeProjectRoot(workingDirectory) },
      window: { viewMode: this.deps.window.viewMode },
      settings: this.deps.settings.ctxForProject?.(worktreeProjectRoot(workingDirectory)) ?? this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  /** Context for project/environment operations that do not require a chat tab. */
  forEnvironment(tabId: string, workingDirectory: string, gitContext: GitCheckout | null): IpcContext {
    const context = this.forDirectory(tabId, workingDirectory)
    context.session.gitContext = gitContext ? { ...gitContext } : null
    return context
  }

  sessionCtx(sourceId: string): SessionCtx {
    const session = this.deps.sessionFor(sourceId)
    const globalDefaults = this.deps.globalDefaults
    // Where the work happens comes from the run — a started session's or a
    // draft's — while everything below it describes a conversation and so only
    // exists once one has started.
    const run = this.deps.runFor(sourceId)
    const staticInfo = run ? null : this.deps.staticInfo()
    const workingDirectory = run
      ? run.workingDirectory
      : globalDefaults.workingDirectory
        || staticInfo?.projectPath
        || staticInfo?.workspacePath
        || '~'
    const modelConfig = run ? run.modelConfig : globalDefaults.modelConfig
    const gitContext = run ? run.gitContext : globalDefaults.gitContext
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

    return {
      sessionId: session?.id ?? '',
      ...(run && isDispatch(run) ? { origin: 'dispatch' as const } : {}),
      provider: run ? run.provider ?? null : null,
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
      permissionMode: run ? run.permissionMode : globalDefaults.permissionMode,
      gitContext: gitContext ? { ...gitContext } : null,
      worktreeBaseBranch: run ? run.worktree?.baseBranch ?? null : globalDefaults.worktreeBaseBranch,
      sessionChangedFiles: session ? [...session.sessionChangedFiles] : [],
      readOnlyReason: session ? session.readOnlyReason : null,
      latestCheckpointId: session ? session.latestCheckpointId : null,
      title: session?.title ?? null,
      ...sessionExtras,
    }
  }
}
