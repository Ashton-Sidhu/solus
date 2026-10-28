import type { AgentId, AgentMetadata, ReasoningEffort } from '@solus/contracts/types'
import type { LeadModelSelection } from '@solus/contracts/settings'
import { defaultReasoningFor, type PickerSelection } from '../../pickers/lib/picker-selection'

function isLeadModelAgent(provider: AgentId): provider is LeadModelSelection['provider'] {
  return provider === 'claude-code' || provider === 'codex'
}

export function leadModelAgents(metadata: Record<string, AgentMetadata | null>): AgentMetadata[] {
  return Object.values(metadata).filter((agent): agent is AgentMetadata => !!agent && isLeadModelAgent(agent.id))
}

/** The selection to save for an agent, model and reasoning level, or null
 *  when there is no model or host config cannot store the agent. No level
 *  means the model's own default. */
export function leadModelFor(
  provider: AgentId,
  model: string | null,
  reasoningEffort: ReasoningEffort | null = defaultReasoningFor(provider, model),
): LeadModelSelection | null {
  if (!model || !isLeadModelAgent(provider)) return null
  return { provider, model, reasoningEffort: reasoningEffort ?? undefined }
}

/** A saved selection as the chip edits it. One saved without a level shows
 *  the model's default level, which is what it runs at. */
export function pickerFromLeadModel(selection: LeadModelSelection): PickerSelection {
  return {
    provider: selection.provider,
    modelId: selection.model,
    reasoningEffort: selection.reasoningEffort ?? defaultReasoningFor(selection.provider, selection.model) ?? 'high',
    fastMode: false,
  }
}
