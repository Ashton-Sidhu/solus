import { SESSION_AGENT_IDS, type AgentId, type AgentMetadata } from '@solus/contracts/types'

/** The agents that can back an automation. One not installed here stays on the
 *  list, so the model picker can show it disabled and say why. */
export function automationAgents(agents: AgentMetadata[]): AgentMetadata[] {
  // Only providers with a headless runner can back an automation.
  return agents.filter((agent) => SESSION_AGENT_IDS.some((id) => id === agent.id))
}

/** The agents this host can run an automation on, in the order it reports them. */
function runnableAutomationAgents(agents: AgentMetadata[]): AgentMetadata[] {
  return automationAgents(agents).filter((agent) => agent.available !== false)
}

/**
 * The provider a new automation starts on. A preference — a template's pinned
 * agent, or the one an edited automation already holds — is honored only when
 * this host can run it; otherwise the automation would be saved unrunnable and
 * fail on a schedule nobody is watching.
 */
export function runnableAutomationAgent(
  agents: AgentMetadata[],
  preferred: AgentId | undefined,
): AgentId {
  const runnable = runnableAutomationAgents(agents)
  if (preferred && runnable.some((agent) => agent.id === preferred)) return preferred
  return runnable[0]?.id ?? preferred ?? 'claude-code'
}
