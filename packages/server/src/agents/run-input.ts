import type { ProviderConversation } from './agent-runner'
import type { AgentId, IpcContext, SessionRunInput } from '@solus/contracts/types'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { getHostConfig } from '../server/settings'

/**
 * The instruction fields for a run with no renderer behind it — an automation,
 * an agent-created session, a handoff, a background review. App-wide
 * instructions live in host config, so these runs read them from the host
 * rather than from an `IpcContext` that does not exist.
 *
 * Before host config, every one of these paths hardcoded an empty string, so a
 * user's instructions applied to turns they typed and silently vanished from
 * turns Solus started for them.
 */
export function hostInstructionsFor(
  model: string | null | undefined,
): Pick<SessionRunInput, 'extraInstructions' | 'modelInstructions'> {
  const { config } = getHostConfig()
  return {
    extraInstructions: config.extraInstructions,
    // A run with no resolved model simply has nothing scoped to it.
    modelInstructions: model ? config.modelInstructions[model] : undefined,
  }
}

/**
 * The model fields for a run with no renderer behind it. An automation stores
 * no model to mean "the provider default", and all four of these fields are
 * derived from the model, so they have to resolve it together — passing the
 * unresolved model through left the window, the model-scoped instructions and
 * the model itself disagreeing, and the backend fell back to whatever its own
 * CLI defaults to instead of ours.
 */
export function hostModelInputFor(
  provider: AgentId | null | undefined,
  modelId: string | null | undefined,
): Pick<SessionRunInput, 'contextWindow' | 'model' | 'preferredModel' | 'extraInstructions' | 'modelInstructions'> {
  const profiles = provider ? MODEL_PROFILES[provider] ?? {} : {}
  const model = modelId || Object.entries(profiles).find(([, p]) => p.isDefault)?.[0] || null
  return {
    contextWindow: model ? profiles[model]?.defaultContextWindow ?? null : null,
    model: model ?? '',
    preferredModel: model,
    ...hostInstructionsFor(model),
  }
}

/**
 * Converts the renderer's UI snapshot (IpcContext) into the caller-agnostic
 * dispatch contract (SessionRunInput). The renderer naturally holds an
 * IpcContext, so it converts inbound here at the control-plane edge; from there
 * the dispatch path and backends speak only SessionRunInput. Non-UI callers
 * (automations, future HTTP/MCP entry points) build a SessionRunInput directly
 * and never construct an IpcContext at all.
 *
 * Resolves the provider/model fallbacks the dispatch path used to read from
 * settings/statusBar, so downstream code never reaches back into UI state.
 */
export function runInputFromContext(ctx: IpcContext): SessionRunInput {
  const { session, settings, statusBar } = ctx
  return {
    provider: session.provider ?? settings.activeAgent,
    agentSessionId: session.agentSessionId,
    forked: session.forked ?? false,
    forkExcludeLatestTurn: session.forkExcludeLatestTurn ?? false,
    workingDirectory: session.workingDirectory,
    projectPath: session.projectPath,
    additionalDirs: session.additionalDirs,
    gitContext: session.gitContext,
    worktreeBaseBranch: session.worktreeBaseBranch,
    sessionChangedFiles: session.sessionChangedFiles,
    contextWindow: session.contextWindow,
    model: statusBar.model,
    preferredModel: session.preferredModel,
    reasoningEffort: statusBar.reasoningEffort,
    fastMode: statusBar.fastMode,
    permissionMode: session.permissionMode,
    rateLimitBehavior: settings.rateLimitBehavior,
    extraInstructions: settings.extraInstructions,
    modelInstructions: settings.modelInstructions?.[statusBar.model],
  }
}

/** Resolve the legacy client snapshot once. A fork source is never the new thread id. */
export function providerConversationFor(input: Pick<SessionRunInput, 'agentSessionId' | 'forked' | 'forkExcludeLatestTurn'>): ProviderConversation {
  if (!input.agentSessionId) return { kind: 'start' }
  if (input.forked) {
    return { kind: 'fork', sourceThreadId: input.agentSessionId, excludeLatestTurn: input.forkExcludeLatestTurn }
  }
  return { kind: 'resume', threadId: input.agentSessionId }
}
