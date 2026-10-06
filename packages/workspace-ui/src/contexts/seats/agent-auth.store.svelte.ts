import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { localApi } from '@solus/client-core/local-api'
import type { AgentAuthMcpTarget, AgentAuthTarget } from '@solus/contracts/agent-auth'
import { toasts } from '../../lib/toasts'

/** One Claude Design or MCP server sign-in, shown in the conversation that asked for it. */
export interface AgentAuthFlowView {
  serverId: string
  sessionId: string
  /** What is being signed in to: "Claude Design" or the MCP server's name. */
  title: string
  phase: 'starting' | 'waiting' | 'external' | 'done' | 'failed'
  url?: string
  input?: 'code' | 'redirect-url'
  flowId?: string
  message?: string
}

/**
 * `/design-login` and `/mcp login` (docs/plans/agent-auth-commands.md): the host
 * runs the sign-in in the caller's seat, this store opens the link on this device,
 * relays what the browser hands back, and hears the end on `host.agentAuthFinished`.
 * It listens only while a flow is shown.
 */
class AgentAuthStore {
  flow = $state<AgentAuthFlowView | null>(null)
  private attempt = 0
  private stopListening: (() => void) | null = null

  visibleFor(serverId: string | undefined, sessionId: string): boolean {
    return this.flow !== null && this.flow.serverId === serverId && this.flow.sessionId === sessionId
  }

  async start(serverId: string, sessionId: string, target: AgentAuthTarget, title: string): Promise<void> {
    await this.cancel()
    const attempt = ++this.attempt
    this.flow = { serverId, sessionId, title, phase: 'starting' }
    this.listen()
    try {
      const result = await serverConnections.apiFor(serverId).agentAuthStart(target)
      // A newer command or a dismiss superseded this one; the host ends the old flow.
      if (attempt !== this.attempt || !this.flow) return
      if (result.state === 'signed-in') {
        this.flow.phase = 'done'
        this.flow.message = result.message
        return
      }
      this.flow.url = result.url
      if (result.state === 'external') {
        this.flow.phase = 'external'
        this.flow.message = result.message
      } else {
        this.flow.phase = 'waiting'
        this.flow.flowId = result.flowId
        this.flow.input = result.input
      }
      // The sign-in happens in the browser on this device, never on the host.
      void localApi.openExternal(result.url)
    } catch (error) {
      if (attempt !== this.attempt || !this.flow) return
      this.flow.phase = 'failed'
      this.flow.message = error instanceof Error ? error.message : 'The sign-in could not start.'
    }
  }

  async submit(value: string): Promise<void> {
    const flow = this.flow
    if (!flow?.flowId) return
    try {
      await serverConnections.apiFor(flow.serverId).agentAuthSubmit({ flowId: flow.flowId, value })
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'The sign-in did not accept that.')
      throw error
    }
  }

  /** Ends a waiting flow on the host, then closes the card. */
  async cancel(): Promise<void> {
    const flow = this.flow
    this.dismiss()
    if (flow?.phase !== 'waiting' || !flow.flowId) return
    await serverConnections.apiFor(flow.serverId).agentAuthCancel({ flowId: flow.flowId }).catch(() => {})
  }

  dismiss(): void {
    this.attempt++
    this.flow = null
    this.stopListening?.()
    this.stopListening = null
  }

  /** `/mcp logout`: answers with the host's own words. */
  async signOut(serverId: string, target: AgentAuthMcpTarget): Promise<string> {
    try {
      return (await serverConnections.apiFor(serverId).agentAuthSignOut(target)).message
    } catch (error) {
      return error instanceof Error ? error.message : `Could not sign out of ${target.server}.`
    }
  }

  private listen(): void {
    if (this.stopListening) return
    this.stopListening = subscribeAllHosts('host.agentAuthFinished', (serverId, event) => {
      const flow = this.flow
      if (!flow || flow.serverId !== serverId || flow.flowId !== event.flowId) return
      flow.phase = event.ok ? 'done' : 'failed'
      flow.message = event.message
    })
  }
}

export const agentAuthStore = new AgentAuthStore()
