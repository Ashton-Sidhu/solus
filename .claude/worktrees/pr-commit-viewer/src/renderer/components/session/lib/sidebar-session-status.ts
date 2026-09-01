import { SvelteMap } from 'svelte/reactivity'
import { isSessionBusyStatus, type SessionStatus } from '../../../../shared/types'
import type { HostEventMap } from '../../../../shared/host-events'
import { hostKey } from '@client-core/host-key'
import type { AttentionState } from '../../../lib/sessionUtils'

export interface SidebarLiveSessionState {
  attention: AttentionState
  runStartedAt: number
}

function attentionForStatus(status: SessionStatus): AttentionState {
  if (status === 'awaiting_input') return 'awaiting'
  if (status === 'awaiting_plan') return 'awaiting_plan'
  if (status === 'rate_limited') return 'queued'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting' || status === 'running') return 'running'
  return null
}

/** Live state for provider sessions that have a durable sidebar row but no tab. */
export class SidebarSessionStatusFeed {
  private states = new SvelteMap<string, SidebarLiveSessionState>()

  apply(serverId: string, event: HostEventMap['session.statusChanged']): void {
    // Sidebar task links use the provider session id. The Solus session id is
    // only the event address and differs for sessions created by an agent tool.
    const sessionId = event.agentSessionId ?? event.sessionId
    const key = hostKey(serverId, sessionId)
    const attention = attentionForStatus(event.status)
    if (!attention) {
      this.states.delete(key)
      return
    }

    const previous = this.states.get(key)
    const continuesRun = previous
      && previous.attention !== 'error'
      && isSessionBusyStatus(event.status)
    this.states.set(key, {
      attention,
      runStartedAt: continuesRun ? previous.runStartedAt : event.at,
    })
  }

  stateFor(serverId: string | null | undefined, sessionId: string): SidebarLiveSessionState | null {
    return serverId ? this.states.get(hostKey(serverId, sessionId)) ?? null : null
  }
}
