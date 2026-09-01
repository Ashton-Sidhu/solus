import type { AgentId, AgentMetadata } from '@solus/contracts/types'

/** Only providers with a headless runner can back an automation. */
const RUNNABLE_AGENT_IDS: AgentId[] = ['claude-code', 'codex']

/** The agents this host can run an automation on, in the order it reports them. */
export function runnableAutomationAgents(agents: AgentMetadata[]): AgentMetadata[] {
  return agents.filter(
    (agent) => RUNNABLE_AGENT_IDS.includes(agent.id) && agent.available !== false,
  )
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
