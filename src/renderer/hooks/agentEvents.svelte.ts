import { onDestroy } from 'svelte'
import type { WorkspaceContext } from '../contexts'
import type { NormalizedEvent, SkillStatus } from '../../shared/types'
import { resyncRuntime } from '../contexts/workspace/session-bootstrap'
import { serverConnections, type ManagedConnection } from '@client-core/server-connections'

/**
 * Bridges ControlPlane IPC events into the session context. Call from App.svelte's top-level script,
 * not inside $effect — the unsubscribes are tied to the component's lifetime.
 *
 * `text_chunk` volume is already tamed upstream: ControlPlane coalesces chunks into
 * ~300ms batches before broadcasting, so no renderer-side batching is needed here.
 */
export function setupAgentEvents(session: WorkspaceContext): void {
  const connectionUnsubscribes = new Map<string, () => void>()

  const bindConnection = (connection: ManagedConnection) => {
    connectionUnsubscribes.get(connection.serverId)?.()
    const unsubEvent = connection.api.onEvent((tabId: string, event: NormalizedEvent) => {
      if (session.sessionFor(tabId)?.serverId !== connection.serverId) return
      session.handleNormalizedEvent(tabId, event)
    })
    const unsubError = connection.api.onError((tabId: string, error: any) => {
      if (session.sessionFor(tabId)?.serverId !== connection.serverId) return
      session.handleError(tabId, error)
    })
    const unsubReset = connection.api.onResetRuntime?.(() => {
      void resyncRuntime(session, connection.serverId)
    })
    connectionUnsubscribes.set(connection.serverId, () => {
      unsubEvent()
      unsubError()
      unsubReset?.()
    })
  }

  const primary = serverConnections.connectionFor()
  if (primary) bindConnection(primary)
  const unsubConnectionCreated = serverConnections.onConnectionCreated(bindConnection)

  const unsubSkill = window.solus.onSkillStatus((status: SkillStatus) => {
    if (status.state === 'failed') {
      console.warn(`[SOLUS] Skill install failed: ${status.name} — ${status.error}`)
    }
  })

  onDestroy(() => {
    unsubConnectionCreated()
    for (const unsubscribe of connectionUnsubscribes.values()) unsubscribe()
    connectionUnsubscribes.clear()
    unsubSkill()
  })
}
