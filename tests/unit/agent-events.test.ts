import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { bindAgentEventSubscriptions } from '@solus/workspace-ui/hooks/agentEvents.svelte'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts'
import type { EnrichedError, WireNormalizedEvent } from '@solus/contracts/types'

describe('agent event host routing', () => {
  test('receives a session event from a secondary host that already exists', () => {
    const localEvents = new HostEventSubscriber()
    const remoteEvents = new HostEventSubscriber()
    const normalizedEvents: Array<{ sessionId: string; event: WireNormalizedEvent }> = []
    const connections = serverConnections as unknown as {
      connectedServerIds: () => string[]
      eventsFor: (serverId: string) => HostEventSubscriber
      onConnectionCreated: (listener: (connection: { serverId: string }) => void) => () => void
      resolveId: (serverId: string) => string
    }
    const originalConnectedServerIds = connections.connectedServerIds
    const originalEventsFor = connections.eventsFor
    const originalOnConnectionCreated = connections.onConnectionCreated
    const originalResolveId = connections.resolveId

    connections.connectedServerIds = () => ['local', 'remote']
    connections.eventsFor = (serverId) => serverId === 'remote' ? remoteEvents : localEvents
    connections.onConnectionCreated = () => () => {}
    connections.resolveId = (serverId) => serverId

    const workspace = {
      sessions: {
        'remote-session': { run: { serverId: 'remote' } },
      },
      handleNormalizedEvent: (sessionId: string, event: WireNormalizedEvent) => {
        normalizedEvents.push({ sessionId, event })
      },
      handleError: (_sessionId: string, _error: EnrichedError) => {},
      applySessionTitleChanged: (_serverId: string) => {},
    } as unknown as WorkspaceContext

    try {
      const unsubscribe = bindAgentEventSubscriptions(workspace)
      const event: WireNormalizedEvent = {
        type: 'status_card',
        card: { id: 'worktree-remote-session', title: 'Preparing worktree', icon: 'git-branch', status: 'active', steps: [] },
      }

      localEvents.receive(hostEvent('session.eventReceived', { sessionId: 'remote-session', event }))
      remoteEvents.receive(hostEvent('session.eventReceived', { sessionId: 'remote-session', event }))

      expect(normalizedEvents).toEqual([{ sessionId: 'remote-session', event }])
      unsubscribe()
    } finally {
      connections.connectedServerIds = originalConnectedServerIds
      connections.eventsFor = originalEventsFor
      connections.onConnectionCreated = originalOnConnectionCreated
      connections.resolveId = originalResolveId
    }
  })
})

function hostEvent(
  type: 'session.eventReceived',
  payload: { sessionId: string; event: WireNormalizedEvent },
) {
  return { type, payload, occurredAt: Date.now() }
}
