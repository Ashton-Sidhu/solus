import type { ProviderConversation } from './agent-runner'
import type { AgentId, IpcContext, SessionRunInput } from '@solus/contracts/types'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'

/**
 * The instruction fields for a run with no renderer behind it — an automation,
 * an agent-created session, a handoff, a background review. Instructions are
 * the person's (plans/018 §3.1): they come from the preferences captured for
 * the work, never from this host's config, so one person's instructions never
 * reach another person's run. No preferences means no instructions.
 */
export function instructionsFor(
  preferences: ExecutionPreferences | undefined,
  model: string | null | undefined,
): Pick<SessionRunInput, 'extraInstructions' | 'modelInstructions'> {
  return {
    extraInstructions: preferences?.extraInstructions ?? '',
    // A run with no resolved model simply has nothing scoped to it.
    modelInstructions: model ? preferences?.modelInstructions?.[model] : undefined,
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
export function unattendedModelInputFor(
  provider: AgentId | null | undefined,
  modelId: string | null | undefined,
  preferences: ExecutionPreferences | undefined,
): Pick<SessionRunInput, 'contextWindow' | 'model' | 'preferredModel' | 'extraInstructions' | 'modelInstructions'> {
  const profiles = provider ? MODEL_PROFILES[provider] ?? {} : {}
  const model = modelId || Object.entries(profiles).find(([, p]) => p.isDefault)?.[0] || null
  return {
    contextWindow: model ? profiles[model]?.defaultContextWindow ?? null : null,
    model: model ?? '',
    preferredModel: modelId || null,
    ...instructionsFor(preferences, model),
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
 * Resolves the provider/model fallbacks from the composer's choices, so
 * downstream code never reaches back into UI state. `preferences` are the
 * person's, from this host's copy (`actingPreferences`), never from the client.
 */
export function runInputFromContext(ctx: IpcContext, preferences: ExecutionPreferences): SessionRunInput {
  const { session, statusBar } = ctx
  return {
    provider: session.provider ?? statusBar.activeAgent,
    agentSessionId: session.agentSessionId,
    forked: session.forked ?? false,
    forkExcludeLatestTurn: session.forkExcludeLatestTurn ?? false,
    workingDirectory: session.workingDirectory,
    projectPath: session.projectPath,
    codebaseId: session.codebaseId,
    noCodebase: session.noCodebase,
    gitContext: session.gitContext,
    worktreeBaseBranch: session.worktreeBaseBranch,
    worktreeRepositories: session.worktreeRepositories,
    contextWindow: session.contextWindow,
    model: statusBar.model,
    preferredModel: session.preferredModel,
    reasoningEffort: statusBar.reasoningEffort,
    fastMode: statusBar.fastMode,
    permissionMode: session.permissionMode,
    // The sender's own choice, carried with the run and its queue entry: a
    // process-wide value would let another client change it while this drains.
    rateLimitBehavior: preferences.rateLimitBehavior ?? DEFAULT_EXECUTION_PREFERENCES.rateLimitBehavior,
    ...instructionsFor(preferences, statusBar.model),
    executionPreferences: preferences,
  }
}

/** Resolve the legacy client snapshot once. A fork source is never the new thread id. */
export function providerConversationFor(input: Pick<SessionRunInput, 'agentSessionId' | 'forked' | 'forkExcludeLatestTurn' | 'forkPointId'>): ProviderConversation {
  if (!input.agentSessionId) return { kind: 'start' }
  if (input.forked) {
    return { kind: 'fork', sourceThreadId: input.agentSessionId, excludeLatestTurn: input.forkExcludeLatestTurn, ...(input.forkPointId && { pointId: input.forkPointId }) }
  }
  return { kind: 'resume', threadId: input.agentSessionId }
}
