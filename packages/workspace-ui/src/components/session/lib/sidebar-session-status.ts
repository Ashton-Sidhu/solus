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
  if (status === 'rate_limited') return 'queued'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting' || status === 'running') return 'running'
  return null
}

/** Live state for provider sessions that have a durable sidebar row but no tab. */
export class SidebarSessionStatusFeed {
  private states = new SvelteMap<string, SidebarLiveSessionState>()

  apply(serverId: string, event: HostEventMap['session.statusChanged']): void {
    // Ordinary task links use the provider session id. A handoff re-keys that
    // same attempt to the stable Solus session id. Keep both aliases in sync so
    // the switch frame cannot leave the old row running or start a second timer.
    const sessionIds = [...new Set([event.sessionId, event.agentSessionId].filter(
      (sessionId): sessionId is string => !!sessionId,
    ))]
    const keys = sessionIds.map((sessionId) => hostKey(serverId, sessionId))
    const attention = attentionForStatus(event.status)
    if (!attention) {
      for (const key of keys) this.states.delete(key)
      return
    }

    const previousRunStartedAt = keys
      .map((key) => this.states.get(key))
      .filter((state) => state && state.attention !== 'error')
      .reduce<number | null>((earliest, state) => (
        earliest === null ? state!.runStartedAt : Math.min(earliest, state!.runStartedAt)
      ), null)
    const continuesRun = previousRunStartedAt !== null && isSessionBusyStatus(event.status)
    const next = {
      attention,
      runStartedAt: continuesRun ? previousRunStartedAt : event.at,
    }
    for (const key of keys) this.states.set(key, next)
  }

  stateFor(serverId: string | null | undefined, sessionId: string): SidebarLiveSessionState | null {
    return serverId ? this.states.get(hostKey(serverId, sessionId)) ?? null : null
  }
}
