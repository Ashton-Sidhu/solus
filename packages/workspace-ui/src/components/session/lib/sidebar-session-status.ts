import { SvelteMap } from 'svelte/reactivity'
import { isSessionBusyStatus, type SessionRecord, type SessionStatus } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import { hostKey } from '@solus/client-core/host-key'
import type { AttentionState } from '../../../lib/sessionUtils'

export interface SidebarLiveSessionState {
  attention: AttentionState
  runStartedAt: number
}

/** Same order as an open tab's `getAttentionState`: a question that waits on
 *  the person asks for input whether the run still works or has finished. */
function attentionForStatus(status: SessionStatus, hasPendingQuestion: boolean): AttentionState {
  if (status === 'awaiting_input') return 'awaiting'
  if (status === 'awaiting_plan') return 'awaiting_plan'
  if (hasPendingQuestion) return 'awaiting'
  if (status === 'rate_limited') return 'limited'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting' || status === 'running') return 'running'
  if (status === 'background') return 'background'
  return null
}

/** Live state for provider sessions that have a durable sidebar row but no tab. */
export class SidebarSessionStatusFeed {
  private states = new SvelteMap<string, SidebarLiveSessionState>()
  /** What each state was made from, and when this client learned it, so a
   *  record read can correct it without undoing a newer event. Not reactive:
   *  `states` carries every change a reader sees. */
  private sources = new Map<string, { status: SessionStatus; hasPendingQuestion: boolean; learnedAt: number }>()

  /** `now` is the clock a record read's start is taken on (`performance.now()`). */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A closed tab no longer contributes attention to its durable task row. */
  clear(serverId: string, sessionId: string): void {
    const key = hostKey(serverId, sessionId)
    this.states.delete(key)
    this.sources.delete(key)
  }

  apply(serverId: string, event: HostEventMap['session.statusChanged']): void {
    this.write(hostKey(serverId, event.sessionId), event.status, event.hasPendingQuestion === true, event.at, this.now())
  }

  /** The host's list was read again, as on every reconnect, from a read that
   *  began at `readStartedAt` on this feed's clock. It answers what the events
   *  missed: a turn that ended, and a question asked or answered. A status
   *  heard after the read began is newer than the record and stays. A busy
   *  status the record says is over takes the record's; otherwise the status
   *  heard stays, as the record only knows running or not. */
  adoptRecord(serverId: string, record: Pick<SessionRecord, 'sessionId' | 'status' | 'hasPendingQuestion'>, readStartedAt: number): void {
    const key = hostKey(serverId, record.sessionId)
    const source = this.sources.get(key)
    if (source && source.learnedAt >= readStartedAt) return
    const hasPendingQuestion = record.hasPendingQuestion === true
    if (!source && !hasPendingQuestion) return
    const status = source && (record.status === 'running' || !isSessionBusyStatus(source.status)) ? source.status : record.status
    if (source?.status === status && source.hasPendingQuestion === hasPendingQuestion) return
    this.write(key, status, hasPendingQuestion, this.states.get(key)?.runStartedAt ?? 0, readStartedAt)
  }

  private write(key: string, status: SessionStatus, hasPendingQuestion: boolean, at: number, learnedAt: number): void {
    const attention = attentionForStatus(status, hasPendingQuestion)
    if (!attention) {
      this.states.delete(key)
      this.sources.delete(key)
      return
    }
    this.sources.set(key, { status, hasPendingQuestion, learnedAt })
    const previous = this.states.get(key)
    const continuesRun = !!previous && previous.attention !== 'error' && isSessionBusyStatus(status)
    this.states.set(key, {
      attention,
      runStartedAt: continuesRun ? previous.runStartedAt : at,
    })
  }

  stateFor(serverId: string | null | undefined, sessionId: string): SidebarLiveSessionState | null {
    return serverId ? this.states.get(hostKey(serverId, sessionId)) ?? null : null
  }
}
