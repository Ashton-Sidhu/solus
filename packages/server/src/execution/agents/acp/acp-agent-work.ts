import type { AcpSessionUpdate } from './acp-protocol'

/** agy sends no end of work it started by itself: that turn ends once the agent has been quiet this long. */
export const AGENT_WORK_QUIET_MS = 3_000
/** A turn the agent started keeps at most this many updates until the session takes them. */
const MAX_HELD_UPDATES = 2_000

/** The updates that are work: prose, thinking, tool calls, and a checklist. Option and title changes are not. */
const WORK_UPDATES = new Set<AcpSessionUpdate['sessionUpdate']>(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

/**
 * Work an ACP agent does after its prompt answered (docs/plans/antigravity-provider.md §9, t12):
 * agy answers `session/prompt` while a daemon schedule or command still runs, and replies by itself
 * when it fires. Solus holds those updates, wakes the session once, and the wake's turn takes them
 * instead of sending a prompt, so the agent does not answer twice.
 */
export class AcpAgentWork {
  private held: AcpSessionUpdate[] = []
  private woken = false
  lastUpdateAt = 0

  /** Holds an update that arrived with no turn; true when it is the first, and the session must be woken. */
  hold(update: AcpSessionUpdate, now = Date.now()): boolean {
    if (!WORK_UPDATES.has(update.sessionUpdate)) return false
    this.lastUpdateAt = now
    if (this.held.length < MAX_HELD_UPDATES) this.held.push(update)
    if (this.woken) return false
    this.woken = true
    return true
  }

  /** The held updates, for the turn that takes them; the next update wakes the session again. */
  take(): AcpSessionUpdate[] {
    const held = this.held
    this.held = []
    this.woken = false
    return held
  }

  get isWaiting(): boolean {
    return this.woken
  }

  /** Whether the agent has been quiet long enough for its own turn to end. */
  isQuiet(now = Date.now()): boolean {
    return now - this.lastUpdateAt >= AGENT_WORK_QUIET_MS
  }
}
