import type {
  AgentId,
  HeadlessSessionRequest,
  ModelConfig,
} from '@solus/contracts/types'

/** Automation authoring is lightweight background work, independent of tabs.
 *  The automation it saves is the artifact, so the session mints no task. */
export function automationDraftSessionRequest(
  prompt: string,
  cwd: string,
  provider: AgentId,
  modelConfig: ModelConfig,
): HeadlessSessionRequest {
  return {
    prompt,
    provider,
    modelId: modelConfig.modelId,
    reasoningEffort: 'low',
    contextWindow: modelConfig.contextWindow,
    cwd,
    skipTaskCreation: true,
  }
}
