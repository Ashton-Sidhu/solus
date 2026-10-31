import { createAppContext } from './create-app-context'
import { agentForProject, modelProfileForAgent } from '@solus/contracts/provider-instance-models'
import { hosts } from '../hosts/hosts.svelte'
import type { StatusBarCtx, RunConfig, AgentId, AgentMetadata, ModelProfile, ModelConfig } from '@solus/contracts/types'
import type { AgentContext } from './agent.context.svelte'
import type { SettingsContext } from './settings.context.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { checkoutPlace, checkoutGit } from '../workspace/run-location'

const DEFAULT_PROFILE: ModelProfile = { label: '', reasoningLevels: ['low', 'medium', 'high'], defaultReasoningEffort: 'high', supportsFastMode: false, contextWindows: [200000], defaultContextWindow: 200000 }

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
    const defaults = this._session?.config.globalDefaults
    const effectiveAgent = run?.provider ?? this.settings.activeAgent
    return {
      workingDirectory: this.workingDirectory(run),
      activeAgent: effectiveAgent,
      permissionMode: run?.permissionMode ?? defaults?.permissionMode ?? 'full-access',
      ...this.modelStatus(run, defaults?.modelConfig, effectiveAgent),
    }
  }

  private workingDirectory(run: RunConfig | undefined): string {
    return checkoutPlace(run)?.path ?? checkoutPlace(this._session?.defaultRunConfig)?.path ?? '~'
  }

  private modelStatus(run: RunConfig | undefined, defaults: ModelConfig | undefined, provider: AgentId) {
    const metadata = this.metadataForRun(run, provider)
    const models = metadata?.models ?? []
    const modelConfig = run?.modelConfig ?? defaults
    const model = modelConfig?.modelId ?? metadata?.defaultModel ?? models[0]?.id ?? ''
    const profile = modelProfileForAgent(provider, model, metadata) ?? DEFAULT_PROFILE
    return {
      model,
      reasoningEffort: modelConfig?.reasoningEffort ?? 'high',
      defaultReasoningEffort: profile.defaultReasoningEffort,
      reasoningLevels: profile.reasoningLevels,
      supportsFastMode: profile.supportsFastMode,
      fastMode: modelConfig?.fastMode ?? false,
      contextWindows: profile.contextWindows,
    }
  }

  private metadataForRun(run: RunConfig | undefined, provider: AgentId): AgentMetadata | null | undefined {
    const serverId = checkoutPlace(run)?.serverId ?? checkoutPlace(this._session?.defaultRunConfig)?.serverId
    const metadata = serverId ? hosts.get(serverId).machineInfo?.agents.find((agent) => agent.id === provider) : undefined
    const effective = metadata ?? this._agent?.metadata[provider]
    return effective ? agentForProject(effective, checkoutGit(run)?.repoRoot ?? this.workingDirectory(run)) : effective
  }

}

export const [getStatusBarContext, setStatusBarContext] = createAppContext<StatusBarContext>('status-bar')
