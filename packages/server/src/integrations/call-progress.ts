import type { Progress } from '@modelcontextprotocol/client'
import { cutText } from '@solus/contracts/text-cut'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentToolContext } from '../execution/agents/tools/agent-tool'

/**
 * What progress does to one upstream tool call (docs/plans/mcp-first-class.md
 * §5): it starts the silence limit again, and it reaches the person as a
 * `tool_progress` event. The agent sees none of it.
 */

/** A call that hears nothing from its server for this long stops. Each progress notification starts it again. */
export const CALL_TIMEOUT_MS = 60 * 1000
/** A call stops after this much time in all, however much progress it reports. */
export const CALL_MAX_TOTAL_MS = 30 * 60 * 1000
/** At most four `tool_progress` events a second for one call. */
const PROGRESS_INTERVAL_MS = 250
const PROGRESS_MESSAGE_MAX_LENGTH = 200

/** The timers and the time a call reads. A test gives a fake one. */
export type CallClock = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> & { now: () => number }

export const SYSTEM_CALL_CLOCK: CallClock = { setTimeout, clearTimeout, now: () => Date.now() }

export type CallLimit = 'silence' | 'total'

type ToolProgressEvent = Extract<NormalizedEvent, { type: 'tool_progress' }>

/**
 * The two limits of one call. Both stop while a person answers a question of
 * the server, and the total limit keeps the time it has used.
 */
export class CallLimits {
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private totalTimer: ReturnType<typeof setTimeout> | null = null
  private totalLeftMs = CALL_MAX_TOTAL_MS
  private runningSince: number | null = null

  constructor(private readonly clock: CallClock, private readonly reached: (limit: CallLimit) => void) {}

  /** Starts both limits, or starts them again after a person answered. */
  start(): void {
    if (this.runningSince !== null) return
    this.runningSince = this.clock.now()
    this.totalTimer = this.clock.setTimeout(() => this.reached('total'), this.totalLeftMs)
    this.restartSilence()
  }

  /** Stops both limits: a person answers, or the call ended. */
  pause(): void {
    if (this.runningSince === null) return
    this.totalLeftMs = Math.max(0, this.totalLeftMs - (this.clock.now() - this.runningSince))
    this.runningSince = null
    if (this.totalTimer) this.clock.clearTimeout(this.totalTimer)
    if (this.silenceTimer) this.clock.clearTimeout(this.silenceTimer)
    this.totalTimer = this.silenceTimer = null
  }

  /** The server reported progress: the silence limit starts again. */
  progressed(): void {
    if (this.runningSince !== null) this.restartSilence()
  }

  private restartSilence(): void {
    if (this.silenceTimer) this.clock.clearTimeout(this.silenceTimer)
    this.silenceTimer = this.clock.setTimeout(() => this.reached('silence'), CALL_TIMEOUT_MS)
  }
}

/**
 * One call's progress as `tool_progress` events on the id of its card. A burst
 * sends the first at once and then the newest each 250 ms; the others are
 * dropped. A call with no card id sends none: no client could place them.
 */
export class ProgressEvents {
  private windowTimer: ReturnType<typeof setTimeout> | null = null
  private pending: ToolProgressEvent | null = null
  private ended = false

  constructor(private readonly clock: CallClock, private readonly context: Pick<AgentToolContext, 'parentToolUseId' | 'emit'>) {}

  report(update: Progress): void {
    const toolUseId = this.context.parentToolUseId()
    if (this.ended || !toolUseId) return
    const event: ToolProgressEvent = { type: 'tool_progress', toolUseId, progress: update.progress }
    if (update.total !== undefined) event.total = update.total
    // Plain text from the server (§3 rule 3): one line, cut.
    const message = update.message?.replace(/\s+/g, ' ').trim()
    if (message) event.message = cutText(message, PROGRESS_MESSAGE_MAX_LENGTH)
    if (this.windowTimer) this.pending = event
    else this.send(event)
  }

  /** The call ended: an event still waiting is dropped, so none follows the result. */
  end(): void {
    this.ended = true
    this.pending = null
    if (this.windowTimer) this.clock.clearTimeout(this.windowTimer)
    this.windowTimer = null
  }

  private send(event: ToolProgressEvent): void {
    this.context.emit(event)
    this.windowTimer = this.clock.setTimeout(() => {
      this.windowTimer = null
      const next = this.pending
      this.pending = null
      if (next) this.send(next)
    }, PROGRESS_INTERVAL_MS)
  }
}
