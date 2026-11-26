import type { AgentHistoryProject } from '@solus/contracts/agent-history'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The folders a person used with Claude Code and Codex on one host
 * (docs/plans/one-page-onboarding.md §3.2), for the Projects step. One read per
 * host; a second read keeps the last answer on screen while it runs (stale),
 * and an answer for a host the page no longer asks about is dropped.
 */
class AgentHistoryStore {
  serverId = $state<string | null>(null)
  projects = $state<AgentHistoryProject[] | null>(null)
  error = $state<string | null>(null)
  /** A read is running. With `projects` set, the list on screen is stale until it ends. */
  isLoading = $state(false)

  get hasAnswered(): boolean {
    return this.projects !== null || this.error !== null
  }

  async load(serverId: string): Promise<void> {
    if (!serverId) return
    if (this.serverId !== serverId) {
      this.serverId = serverId
      this.projects = null
      this.error = null
    }
    this.isLoading = true
    try {
      const projects = await serverConnections.apiFor(serverId).agentHistoryProjects()
      if (this.serverId !== serverId) return
      this.projects = projects
      this.error = null
    } catch (error) {
      if (this.serverId !== serverId) return
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.serverId === serverId) this.isLoading = false
    }
  }
}

export const agentHistoryStore = new AgentHistoryStore()
