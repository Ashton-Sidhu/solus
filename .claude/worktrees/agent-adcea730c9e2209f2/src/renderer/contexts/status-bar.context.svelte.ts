import { createContext } from 'svelte'
import { MODEL_PROFILES } from '../../shared/types'
import type { StatusBarCtx, AgentId, Session } from '../../shared/types'
import type { AgentContext } from './agent.context.svelte'
import type { SettingsContext } from './settings.context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'

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
    return this.buildCtx(this._session?.activeSession)
  }

  /** Status ctx for a specific tab's session — the split pane's status strip. */
  ctxFor(tabId: string): StatusBarCtx {
    return this.buildCtx(this._session?.sessionFor(tabId))
  }

  private buildCtx(sess: Session | undefined): StatusBarCtx {
    const defaults = this._session?.globalDefaults
    const effectiveAgent = (sess?.provider ?? this.settings.activeAgent) as AgentId
    const models = this._agent?.metadata[effectiveAgent]?.models ?? []
    const metaDefault = this._agent?.metadata[effectiveAgent]?.defaultModel ?? null
    const mc = sess?.modelConfig ?? defaults?.modelConfig
    const preferredModel = mc?.modelId ?? null
    const model = preferredModel && models.some((m) => m.id === preferredModel)
      ? preferredModel
      : metaDefault ?? models[0]?.id ?? ''
    const profile = MODEL_PROFILES[effectiveAgent]?.[model]
    return {
      workingDirectory: sess?.workingDirectory ?? defaults?.workingDirectory ?? '~',
      activeAgent: effectiveAgent,
      permissionMode: sess?.permissionMode ?? defaults?.permissionMode ?? 'auto',
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

export const [getStatusBarContext, setStatusBarContext] = createContext<StatusBarContext>()
