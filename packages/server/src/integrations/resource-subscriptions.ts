import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import type { Integration } from '@solus/contracts/integration-types'
import type { CommandStarter } from './command-admission'
import type { TaskAwareClient } from './mcp-task-requests'

/**
 * The client side of a resource subscription (docs/plans/mcp-first-class.md
 * §11.5). SDK 2.4.0 has no fallback between the two revisions: `listen()`
 * throws `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` on a 2025 connection, and
 * `subscribeResource()` throws the same on a 2026-07-28 connection, where
 * `resources/subscribe` is removed. So Solus chooses by the era. On both, a
 * `notifications/resources/updated` reaches the client's one notification
 * handler, which the gateway installs.
 */

/** The server does not take the subscription: the watch ends with `refused`. */
export class ResourceWatchRefusedError extends Error {}

export interface ResourceSubscription {
  /** Resolves when the stream or the connection ends. The owner ignores it after its own `close()`. */
  readonly ended: Promise<void>
  /** Ends it and tells the server. `unsubscribe: false` keeps a legacy subscription that another watch shares. */
  close(options: { unsubscribe: boolean }): Promise<void>
}

/** Where a change notification came from: one person's upstream session. */
export interface UpstreamAddress {
  integrationId: string
  personKey: string | null
  accountId: string
}

/** What the resource watch owner (`resource-watches.ts`) does for the gateway and the agent tool. */
export interface ResourceWatchCalls {
  /** `watch_integration_resource` with `watching: true`: opens a watch for the call's session. */
  watch(request: WatchRequest): Promise<AgentToolResult>
  /** `watching: false`: ends the session's watch of that resource. */
  unwatch(request: Pick<WatchRequest, 'integration' | 'uri' | 'context'>): Promise<AgentToolResult>
  /** An upstream session with a live watch is not closed when idle (§7.3). */
  holdsUpstream(address: UpstreamAddress): boolean
  /** A server sent `notifications/resources/updated`. */
  updated(address: UpstreamAddress, uri: string): void
}

/** What the owner reads of the watched integration. */
export type WatchedServer = Pick<Integration, 'id' | 'organizationId' | 'kind' | 'name' | 'slug' | 'auth'>

export interface WatchRequest {
  integration: WatchedServer
  uri: string
  /** The resource's name as the server listed it, when the list has it. */
  name?: string
  personKey: string | null
  accountId: string
  context: AgentToolContext
  starter: CommandStarter
}

/** Opens one subscription on the client's era. Throws `ResourceWatchRefusedError` when the server does not take it. */
export async function openResourceSubscription(client: TaskAwareClient, uri: string, timeout: number): Promise<ResourceSubscription> {
  if (client.getProtocolEra() === 'modern') {
    const subscription = await client.listen({ resourceSubscriptions: [uri] }, { timeout })
    if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) {
      await subscription.close()
      throw new ResourceWatchRefusedError('The server does not send changes of this resource.')
    }
    return {
      ended: subscription.closed.then(() => undefined),
      // Closing aborts the stream and sends `notifications/cancelled` for it.
      close: () => subscription.close(),
    }
  }
  await client.subscribeResource({ uri }, { timeout })
  return {
    ended: client.connectionEnded,
    close: async ({ unsubscribe }) => {
      if (unsubscribe) await client.unsubscribeResource({ uri }, { timeout }).catch(() => undefined)
    },
  }
}
