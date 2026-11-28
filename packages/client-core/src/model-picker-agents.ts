import { SESSION_AGENT_IDS, type AgentId, type AgentMetadata } from '@solus/contracts/types'

/**
 * The host registers the providers it can run, so a picker shows every one it
 * reports. A development host must not expose Replay in a production client's picker.
 */
export function isModelPickerAgentVisible(provider: AgentId, isDevelopment: boolean): boolean {
  return provider !== 'replay' || isDevelopment
}

/** The agents that can back an automation. One not installed here stays on the
 *  list, so the model picker can show it disabled and say why. */
export function automationAgents(agents: AgentMetadata[]): AgentMetadata[] {
  // Only providers with a headless runner can back an automation.
  return agents.filter((agent) => SESSION_AGENT_IDS.some((id) => id === agent.id))
}
