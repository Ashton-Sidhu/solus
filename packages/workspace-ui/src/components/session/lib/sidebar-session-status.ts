import { SvelteMap } from 'svelte/reactivity'
import { isSessionBusyStatus, type SessionRecord, type SessionStatus } from '@solus/contracts/types'
import type { AgentActivity } from '@solus/contracts/agent-activity'
import type { HostEventMap } from '@solus/contracts/host-events'
import { hostKey } from '@solus/client-core/host-key'
import type { AttentionState } from '../../../lib/sessionUtils'

export interface SidebarLiveSessionState {
  attention: AttentionState
  runStartedAt: number
}

/** What waits for the person, as the status feed says it. */
interface WaitFacts {
  hasPendingQuestion: boolean
  awaitingApproval: boolean
}

/** Same order as an open tab's `getAttentionState`: a question that waits on
 *  the person asks for input whether the run still works or has finished. */
function attentionForStatus(status: SessionStatus, wait: WaitFacts): AttentionState {
  if (status === 'awaiting_input') return wait.awaitingApproval ? 'approval' : 'awaiting'
  if (status === 'awaiting_plan') return 'awaiting_plan'
  if (wait.hasPendingQuestion) return 'awaiting'
  if (status === 'rate_limited') return 'limited'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting') return 'starting'
  if (status === 'running') return 'running'
  if (status === 'background') return 'background'
  return null
}

/** Live state for provider sessions that have a durable sidebar row but no
 *  tab, and the agent activity of every running session the hosts report. */
export class SidebarSessionStatusFeed {
  private states = new SvelteMap<string, SidebarLiveSessionState>()
  /** The agent activity of each running turn. Live only: a session that is
   *  not running, or whose host connection was reset, has none, and its row
   *  shows Working until the next activity event. */
  private activities = new SvelteMap<string, AgentActivity>()
  /** What each state was made from, and when this client learned it, so a
   *  record read can correct it without undoing a newer event. Not reactive:
   *  `states` carries every change a reader sees. */
  private sources = new Map<string, { status: SessionStatus; wait: WaitFacts; learnedAt: number }>()

  /** `now` is the clock a record read's start is taken on (`performance.now()`). */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A closed tab no longer contributes attention to its durable task row. */
  clear(serverId: string, sessionId: string): void {
    const key = hostKey(serverId, sessionId)
    this.states.delete(key)
    this.sources.delete(key)
    this.activities.delete(key)
  }

  apply(serverId: string, event: HostEventMap['session.statusChanged']): void {
    const key = hostKey(serverId, event.sessionId)
    if (event.status !== 'running') this.activities.delete(key)
    const wait = { hasPendingQuestion: event.hasPendingQuestion === true, awaitingApproval: event.awaitingApproval === true }
    this.write(key, event.status, wait, event.at, this.now())
  }

  applyActivity(serverId: string, event: HostEventMap['session.activityChanged']): void {
    const key = hostKey(serverId, event.sessionId)
    if (event.activity) this.activities.set(key, event.activity)
    else this.activities.delete(key)
  }

  /** The host's connection was reset: the activity events it sent while it
   *  was away are lost, so each of its running rows shows Working until the
   *  next one. */
  resetActivities(serverId: string): void {
    const prefix = hostKey(serverId, '')
    for (const key of this.activities.keys()) {
      if (key.startsWith(prefix)) this.activities.delete(key)
    }
  }

  /** The host's list was read again, as on every reconnect, from a read that
   *  began at `readStartedAt` on this feed's clock. It answers what the events
   *  missed: a turn that ended, and a question asked or answered. A status
   *  heard after the read began is newer than the record and stays. A busy
   *  status the record says is over takes the record's; otherwise the status
   *  heard stays, as the record only knows running or not. The record has no
   *  `awaiting_input`, so the approval heard stays with the status heard. */
  adoptRecord(serverId: string, record: Pick<SessionRecord, 'sessionId' | 'status' | 'hasPendingQuestion'>, readStartedAt: number): void {
    const key = hostKey(serverId, record.sessionId)
    const source = this.sources.get(key)
    if (source && source.learnedAt >= readStartedAt) return
    const hasPendingQuestion = record.hasPendingQuestion === true
    if (!source && !hasPendingQuestion) return
    const keepsHeard = !!source && (record.status === 'running' || !isSessionBusyStatus(source.status))
    const status = keepsHeard ? source.status : record.status
    const wait = { hasPendingQuestion, awaitingApproval: keepsHeard && source.wait.awaitingApproval }
    if (source?.status === status && source.wait.hasPendingQuestion === wait.hasPendingQuestion && source.wait.awaitingApproval === wait.awaitingApproval) return
    if (status !== 'running') this.activities.delete(key)
    this.write(key, status, wait, this.states.get(key)?.runStartedAt ?? 0, readStartedAt)
  }

  private write(key: string, status: SessionStatus, wait: WaitFacts, at: number, learnedAt: number): void {
    const attention = attentionForStatus(status, wait)
    if (!attention) {
      this.states.delete(key)
      this.sources.delete(key)
      return
    }
    this.sources.set(key, { status, wait, learnedAt })
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

  /** The agent activity of the session's running turn; null when it is not
   *  known (no event yet, or after a reconnect). */
  activityFor(serverId: string | null | undefined, sessionId: string): AgentActivity | null {
    return serverId ? this.activities.get(hostKey(serverId, sessionId)) ?? null : null
  }
}
