import type { IpcContext, PrReviewContext, Session, SessionCtx, Tab, TabGitContext } from '../../shared/types'
import { worktreeProjectRoot } from '../../shared/types'
import type { SettingsContext } from './settings.context.svelte'
import type { StatusBarContext } from './status-bar.context.svelte'
import type { WindowContext } from './window.context.svelte'
import type { StaticInfo } from './environment.store.svelte'

export interface IpcContextBuilderDeps {
  tabs(): Record<string, Tab>
  sessionFor(tabId: string): Session | undefined
  globalDefaults: {
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: TabGitContext | null
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
    return {
      session: this.sessionCtx(tabId),
      window: { viewMode: this.deps.window.viewMode },
      settings: this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  forDirectory(tabId: string, workingDirectory: string): IpcContext {
    const base = this.sessionCtx(tabId)
    return {
      session: { ...base, workingDirectory, projectPath: worktreeProjectRoot(workingDirectory) },
      window: { viewMode: this.deps.window.viewMode },
      settings: this.deps.settings.ctx,
      statusBar: this.deps.statusBar.ctx,
    }
  }

  sessionCtx(tabId: string): SessionCtx {
    const tab = this.deps.tabs()[tabId]
    const session = this.deps.sessionFor(tabId)
    if (!session) {
      const workingDirectory = this.deps.globalDefaults.workingDirectory || this.deps.staticInfo()?.workspacePath || '~'
      return {
        tabId,
        provider: null,
        agentSessionId: null,
        status: 'idle',
        workingDirectory,
        projectPath: worktreeProjectRoot(workingDirectory),
        additionalDirs: [],
        preferredModel: this.deps.globalDefaults.modelConfig.modelId,
        reasoningEffort: this.deps.globalDefaults.modelConfig.reasoningEffort,
        contextWindow: this.deps.globalDefaults.modelConfig.contextWindow,
        fastMode: this.deps.globalDefaults.modelConfig.fastMode,
        permissionMode: this.deps.globalDefaults.permissionMode,
        gitContext: this.deps.globalDefaults.gitContext ? { ...this.deps.globalDefaults.gitContext } : null,
        worktreeBaseBranch: null,
        changedFiles: [],
        readOnlyReason: null,
        latestCheckpointId: null,
        title: tab?.title ?? null,
      }
    }
    return {
      tabId,
      provider: session.provider ?? null,
      agentSessionId: session.agentSessionId,
      status: session.status,
      workingDirectory: session.workingDirectory,
      projectPath: worktreeProjectRoot(session.workingDirectory),
      additionalDirs: [...session.additionalDirs],
      preferredModel: session.modelConfig.modelId,
      reasoningEffort: session.modelConfig.reasoningEffort,
      contextWindow: session.modelConfig.contextWindow,
      fastMode: session.modelConfig.fastMode,
      permissionMode: session.permissionMode,
      gitContext: session.gitContext ? { ...session.gitContext } : null,
      worktreeBaseBranch: session.worktreeBaseBranch,
      changedFiles: [...session.changedFiles],
      readOnlyReason: session.readOnlyReason,
      latestCheckpointId: session.latestCheckpointId,
      title: tab?.title ?? null,
      forked: session.forked ?? false,
      // Deep plain-object copy: session.prReview is a Svelte $state proxy with a
      // nested headRepo, and proxies aren't structured-cloneable over IPC. A
      // shallow spread wouldn't unwrap headRepo; this file is plain .ts so no
      // $state.snapshot — JSON round-trip is safe for this pure-data struct.
      prReview: session.prReview ? (JSON.parse(JSON.stringify(session.prReview)) as PrReviewContext) : null,
    }
  }
}
