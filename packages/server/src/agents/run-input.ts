import type { IpcContext, SessionRunInput } from '@solus/contracts/types'
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
    prReview: session.prReview ?? null,
  }
}
