import { agentActivityOfTool, type AgentActivity } from '@solus/contracts/agent-activity'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { NormalizedEvent } from '@solus/contracts/types'

/** The shortest time between two `session.activityChanged` events of one session. */
export const ACTIVITY_WINDOW_MS = 250

export interface ActivityClock {
  now(): number
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const systemClock: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

/** The agent activity a top-level event gives; undefined when the event does not change it. */
function activityOf(event: NormalizedEvent): AgentActivity | null | undefined {
  // A sub-agent's work is not what the session's own agent does.
  if ('parentToolUseId' in event && event.parentToolUseId) return undefined
  switch (event.type) {
    case 'thinking':
      return event.state === 'stop' ? undefined : 'think'
    case 'tool_call':
      // A question is the Input state, not an activity.
      return agentActivityOfTool(event.toolName) ?? undefined
    case 'text_chunk':
      return 'reply'
    case 'turn_settled':
      return null
    default:
      return undefined
  }
}

interface ActivityState {
  /** The activity the events give now. */
  current: AgentActivity | null
  /** The activity the last event sent. */
  sent: AgentActivity | null
  sentAt: number
  /** Set while the window after a send is open and a change waits for its end. */
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * What the agent of each session does now inside a running turn, from its
 * top-level backend events (docs/plans/session-state-marks.md). It sends a
 * change at once when the window after the last send is closed, and else the
 * newest change at the end of that window: at most one event for each session
 * in `ACTIVITY_WINDOW_MS`. A change that is undone inside the window sends
 * nothing. The settle of a turn sends null and forgets the session.
 */
export class SessionActivity {
  private readonly states = new Map<string, ActivityState>()

  constructor(
    private readonly send: (event: HostEventMap['session.activityChanged']) => void,
    private readonly clock: ActivityClock = systemClock,
  ) {}

  observe(sessionId: string, event: NormalizedEvent): void {
    const activity = activityOf(event)
    if (activity === undefined) return
    const state = this.states.get(sessionId)
    if (!state) {
      // Nothing was sent for this turn, so a clear has nothing to clear.
      if (activity !== null) this.sendNow(sessionId, { current: activity, sent: null, sentAt: 0, timer: null })
      return
    }
    if (state.current === activity) return
    state.current = activity
    if (state.timer) return
    const waitMs = state.sentAt + ACTIVITY_WINDOW_MS - this.clock.now()
    if (waitMs <= 0) {
      this.sendNow(sessionId, state)
      return
    }
    state.timer = this.clock.setTimeout(() => {
      state.timer = null
      if (state.current !== state.sent) this.sendNow(sessionId, state)
    }, waitMs)
  }

  private sendNow(sessionId: string, state: ActivityState): void {
    const at = this.clock.now()
    state.sent = state.current
    state.sentAt = at
    if (state.current === null) this.states.delete(sessionId)
    else this.states.set(sessionId, state)
    this.send({ sessionId, activity: state.current, at })
  }
}
