import { resolve } from 'path'
import type { NormalizedEvent } from '@solus/contracts/types'

/**
 * When each session's turns and tool calls run, per checkout. This is live
 * state on this host, kept in memory. `session-snapshots.ts` reads it to tell
 * one session's writes from another's when their turns overlap in one checkout.
 */

/** Allowance between a write and the tool event that brackets it. Events are
 *  read on this host, so the clocks are the same; this covers only delivery. */
const WRITE_SLACK_MS = 100

interface Span {
  startedAt: number
  endedAt?: number
}

interface RecordedTurn {
  sessionId: string
  workTree: string
  startedAt: number
  endedAt?: number
  tools: Map<string, Span>
}

/** A session's open turn, seen beside the other sessions' turns that overlap
 *  it in the same checkout. */
export interface ConcurrentTurn {
  startedAt: number
  /** True when one of this session's tool calls ran at `at`. */
  isOwnToolCallAt(at: number): boolean
  /** True when another session's tool call ran at `at`. */
  isOtherToolCallAt(at: number): boolean
}

export class TurnActivity {
  /** Open turns, and ended turns that an open turn in the same checkout still overlaps. */
  private readonly turns: RecordedTurn[] = []
  private readonly openTurns = new Map<string, RecordedTurn>()

  turnStarted(sessionId: string, workTree: string): void {
    this.turnEnded(sessionId)
    const turn: RecordedTurn = { sessionId, workTree: resolve(workTree), startedAt: Date.now(), tools: new Map() }
    this.turns.push(turn)
    this.openTurns.set(sessionId, turn)
  }

  turnEnded(sessionId: string): void {
    const turn = this.openTurns.get(sessionId)
    if (!turn) return
    const now = Date.now()
    turn.endedAt = now
    for (const span of turn.tools.values()) span.endedAt ??= now
    this.openTurns.delete(sessionId)
    this.forgetUnneededTurns(turn.workTree)
  }

  /** Record when a session's tool calls start and end. Both providers' events
   *  arrive here in the normalized shape. */
  observe(sessionId: string, event: NormalizedEvent): void {
    const turn = this.openTurns.get(sessionId)
    if (!turn) return
    if (event.type === 'tool_call') {
      if (!turn.tools.has(event.toolId)) turn.tools.set(event.toolId, { startedAt: Date.now() })
      return
    }
    // A tool_call_complete without an outcome only ends Claude's input stream.
    const endedToolId = event.type === 'tool_result'
      ? event.toolUseId
      : event.type === 'tool_call_complete' && (event.outcome || event.completedAtMs !== undefined)
        ? event.toolId
        : undefined
    const span = endedToolId ? turn.tools.get(endedToolId) : undefined
    if (span) span.endedAt ??= Date.now()
  }

  /** The session's open turn in `workTree`, or null when it has none or no
   *  other session had a turn there at the same time (the usual case). */
  concurrentTurn(sessionId: string, workTree: string): ConcurrentTurn | null {
    const own = this.openTurns.get(sessionId)
    if (!own || own.workTree !== resolve(workTree)) return null
    const now = Date.now()
    const others = this.turns.filter((turn) => turn.sessionId !== sessionId
      && turn.workTree === own.workTree
      && (turn.endedAt ?? now) >= own.startedAt)
    if (others.length === 0) return null
    return {
      startedAt: own.startedAt,
      isOwnToolCallAt: (at) => isInToolCall(own, at, now),
      isOtherToolCallAt: (at) => others.some((turn) => isInToolCall(turn, at, now)),
    }
  }

  /** Keep an ended turn only while an open turn in its checkout overlaps it. */
  private forgetUnneededTurns(workTree: string): void {
    const openStarts = [...this.openTurns.values()]
      .filter((turn) => turn.workTree === workTree)
      .map((turn) => turn.startedAt)
    const earliestOpen = openStarts.length ? Math.min(...openStarts) : Infinity
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]
      if (turn.workTree === workTree && turn.endedAt !== undefined && turn.endedAt < earliestOpen) this.turns.splice(i, 1)
    }
  }
}

function isInToolCall(turn: RecordedTurn, at: number, now: number): boolean {
  for (const span of turn.tools.values()) {
    if (span.startedAt - WRITE_SLACK_MS <= at && at <= (span.endedAt ?? now) + WRITE_SLACK_MS) return true
  }
  return false
}

/** Every Solus session on this host. */
export const turnActivity = new TurnActivity()
