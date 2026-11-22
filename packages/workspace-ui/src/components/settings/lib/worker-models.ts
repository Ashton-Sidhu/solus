import type { AgentId, AgentMetadata, ReasoningEffort } from '@solus/contracts/types'
import type { WorkerModelSelection } from '@solus/contracts/settings'
import { defaultReasoningFor, type PickerSelection } from '../../pickers/lib/picker-selection'

function isWorkerModelAgent(provider: AgentId): provider is WorkerModelSelection['provider'] {
  return provider === 'claude-code' || provider === 'codex'
}

export function workerModelAgents(metadata: Record<string, AgentMetadata | null>): AgentMetadata[] {
  return Object.values(metadata).filter((agent): agent is AgentMetadata => !!agent && isWorkerModelAgent(agent.id))
}

/** The selection to save for an agent, model and reasoning level, or null
 *  when there is no model or host config cannot store the agent. No level
 *  means the model's own default. */
export function workerModelFor(
  provider: AgentId,
  model: string | null,
  reasoningEffort: ReasoningEffort | null = defaultReasoningFor(provider, model),
): WorkerModelSelection | null {
  if (!model || !isWorkerModelAgent(provider)) return null
  return { provider, model, reasoningEffort: reasoningEffort ?? undefined }
}

/** A saved selection as the chip edits it. One saved without a level shows
 *  the model's default level, which is what it runs at. */
export function pickerFromWorkerModel(selection: WorkerModelSelection): PickerSelection {
  return {
    provider: selection.provider,
    modelId: selection.model,
    reasoningEffort: selection.reasoningEffort ?? defaultReasoningFor(selection.provider, selection.model) ?? 'high',
    fastMode: false,
  }
}
