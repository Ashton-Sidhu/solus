import { createAppContext } from './create-app-context'
import { MODEL_PROFILES } from '@solus/contracts/types'
import type { StatusBarCtx, RunConfig } from '@solus/contracts/types'
import type { AgentContext } from './agent.context.svelte'
import type { SettingsContext } from './settings.context.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'

export class StatusBarContext {
  private settings: SettingsContext
  private _session: WorkspaceContext | null = null
  private _agent: AgentContext | null = null

  constructor(settings: SettingsContext) {
    this.settings = settings
  }

  bind(session: WorkspaceContext): void {
    this._session = session
  }

  bindAgent(agent: AgentContext): void {
    this._agent = agent
  }

  get ctx(): StatusBarCtx {
    return this.ctxForRun(this._session?.activeSession?.run)
  }

  /** Status ctx for a specific tab's session — the split pane's status strip. */
  ctxFor(tabId: string): StatusBarCtx {
    return this.ctxForRun(this._session?.sessionFor(tabId)?.run)
  }

  /** Status ctx for a run that has no tab to name it — a session draft's. The
   *  ctx is a reading of the run alone, so a draft and a started session give
   *  the same answer without the caller knowing which it holds. */
  ctxForRun(run: RunConfig | undefined): StatusBarCtx {
    const defaults = this._session?.globalDefaults
    const effectiveAgent = run?.provider ?? this.settings.activeAgent
    const models = this._agent?.metadata[effectiveAgent]?.models ?? []
    const metaDefault = this._agent?.metadata[effectiveAgent]?.defaultModel ?? null
    const mc = run?.modelConfig ?? defaults?.modelConfig
    const preferredModel = mc?.modelId ?? null
    const model = preferredModel && models.some((m) => m.id === preferredModel)
      ? preferredModel
      : metaDefault ?? models[0]?.id ?? ''
    const profile = MODEL_PROFILES[effectiveAgent]?.[model]
    return {
      workingDirectory: run?.workingDirectory ?? defaults?.workingDirectory ?? '~',
      activeAgent: effectiveAgent,
      permissionMode: run?.permissionMode ?? defaults?.permissionMode ?? 'auto',
      model,
      reasoningEffort: mc?.reasoningEffort ?? 'high',
      defaultReasoningEffort: profile?.defaultReasoningEffort ?? 'high',
      reasoningLevels: profile?.reasoningLevels ?? ['low', 'medium', 'high'],
      supportsFastMode: profile?.supportsFastMode ?? false,
      fastMode: mc?.fastMode ?? false,
      contextWindows: profile?.contextWindows ?? [200_000],
    }
  }
}

export const [getStatusBarContext, setStatusBarContext] = createAppContext<StatusBarContext>('status-bar')
