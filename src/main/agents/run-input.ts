import type { IpcContext, SessionRunInput } from '../../shared/types'

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
    tabId: session.tabId || undefined,
    provider: session.provider ?? settings.activeAgent,
    agentSessionId: session.agentSessionId,
    forked: session.forked ?? false,
    workingDirectory: session.workingDirectory,
    projectPath: session.projectPath,
    additionalDirs: session.additionalDirs,
    gitContext: session.gitContext,
    worktreeBaseBranch: session.worktreeBaseBranch,
    changedFiles: session.changedFiles,
    contextWindow: session.contextWindow,
    model: statusBar.model,
    preferredModel: session.preferredModel,
    reasoningEffort: statusBar.reasoningEffort,
    fastMode: statusBar.fastMode,
    permissionMode: session.permissionMode,
    rateLimitBehavior: settings.rateLimitBehavior,
    extraInstructions: settings.extraInstructions,
    prReview: session.prReview ?? null,
  }
}
