import type { GitCheckout, IpcContext, PrReviewContext, Session, SessionCtx, Tab } from '../../../shared/types'
import { worktreeProjectRoot } from '../../../shared/types'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import type { WindowContext } from '../app/window.context.svelte'
import type { StaticInfo } from './workspace-lifecycle.store.svelte'

export interface IpcContextBuilderDeps {
  tabs(): Record<string, Tab>
  sessionFor(tabId: string): Session | undefined
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

  sessionCtx(tabId: string): SessionCtx {
    const tab = this.deps.tabs()[tabId]
    const session = this.deps.sessionFor(tabId)
    const globalDefaults = this.deps.globalDefaults
    const staticInfo = session ? null : this.deps.staticInfo()
    const workingDirectory = session
      ? session.workingDirectory
      : globalDefaults.workingDirectory
        || staticInfo?.projectPath
        || staticInfo?.workspacePath
        || '~'
    const modelConfig = session ? session.modelConfig : globalDefaults.modelConfig
    const gitContext = session ? session.gitContext : globalDefaults.gitContext
    const sessionExtras = session
      ? {
          forked: session.forked ?? false,
          // Deep plain-object copy: session.prReview is a Svelte $state proxy with a
          // nested headRepo, and proxies aren't structured-cloneable over IPC. A
          // shallow spread wouldn't unwrap headRepo; this file is plain .ts so no
          // $state.snapshot — JSON round-trip is safe for this pure-data struct.
          prReview: session.prReview ? (JSON.parse(JSON.stringify(session.prReview)) as PrReviewContext) : null,
        }
      : {}

    return {
      tabId,
      provider: session ? session.provider ?? null : null,
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
      permissionMode: session ? session.permissionMode : globalDefaults.permissionMode,
      gitContext: gitContext ? { ...gitContext } : null,
      worktreeBaseBranch: session ? session.worktreeBaseBranch : globalDefaults.worktreeBaseBranch,
      sessionChangedFiles: session ? [...session.sessionChangedFiles] : [],
      readOnlyReason: session ? session.readOnlyReason : null,
      latestCheckpointId: session ? session.latestCheckpointId : null,
      title: tab?.title ?? null,
      ...sessionExtras,
    }
  }
}
