import { SvelteMap } from 'svelte/reactivity'
import { isSessionBusyStatus, type SessionStatus } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import { hostKey } from '@solus/client-core/host-key'
import type { AttentionState } from '../../../lib/sessionUtils'

export interface SidebarLiveSessionState {
  attention: AttentionState
  runStartedAt: number
}

function attentionForStatus(status: SessionStatus): AttentionState {
  if (status === 'awaiting_input') return 'awaiting'
  if (status === 'awaiting_plan') return 'awaiting_plan'
  if (status === 'rate_limited') return 'limited'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting' || status === 'running') return 'running'
  if (status === 'background') return 'background'
  return null
}

/** Live state for provider sessions that have a durable sidebar row but no tab. */
export class SidebarSessionStatusFeed {
  private states = new SvelteMap<string, SidebarLiveSessionState>()

  /** A closed tab no longer contributes attention to its durable task row. */
  clear(serverId: string, sessionId: string): void {
    this.states.delete(hostKey(serverId, sessionId))
  }

  apply(serverId: string, event: HostEventMap['session.statusChanged']): void {
    const key = hostKey(serverId, event.sessionId)
    const attention = attentionForStatus(event.status)
    if (!attention) {
      this.states.delete(key)
      return
    }
    const previous = this.states.get(key)
    const continuesRun = !!previous && previous.attention !== 'error' && isSessionBusyStatus(event.status)
    this.states.set(key, {
      attention,
      runStartedAt: continuesRun ? previous.runStartedAt : event.at,
    })
  }

  stateFor(serverId: string | null | undefined, sessionId: string): SidebarLiveSessionState | null {
    return serverId ? this.states.get(hostKey(serverId, sessionId)) ?? null : null
  }
}
