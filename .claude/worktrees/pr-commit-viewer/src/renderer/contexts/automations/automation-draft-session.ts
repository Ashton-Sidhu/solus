import type {
  AgentId,
  HeadlessSessionRequest,
  ModelConfig,
} from '../../../shared/types'

/** Automation authoring is lightweight background work, independent of tabs. */
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
  }
}
