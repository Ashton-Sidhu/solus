import type { AgentMetadata, TextGenerationModelSelection } from '@solus/contracts/types'

/**
 * Whether a host offers a model the person chose. The choice is the person's
 * and stays saved when a host lacks it; the host then runs its own fallback,
 * which Settings names rather than writing it back as a new choice.
 */
export function isModelOffered(agents: readonly AgentMetadata[], selection: TextGenerationModelSelection): boolean {
  return agents.some((agent) => agent.id === selection.provider && agent.available !== false && agent.models.some((model) => model.id === selection.model))
}
