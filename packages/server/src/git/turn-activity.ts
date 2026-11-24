import { resolve } from 'path'
import type { NormalizedEvent } from '@solus/contracts/types'

/**
 * When each session's turns and tool calls run, per checkout. A session has
 * one open turn in each repository it works in. This is live
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
  /** The open turns of each session, by checkout: a session with several
   *  repositories has one open turn in each (docs/plans/codebases.md §8). */
  private readonly openTurns = new Map<string, Map<string, RecordedTurn>>()

  turnStarted(sessionId: string, workTree: string): void {
    this.turnEnded(sessionId, workTree)
    const turn: RecordedTurn = { sessionId, workTree: resolve(workTree), startedAt: Date.now(), tools: new Map() }
    this.turns.push(turn)
    let open = this.openTurns.get(sessionId)
    if (!open) this.openTurns.set(sessionId, open = new Map())
    open.set(turn.workTree, turn)
  }

  /** End the session's open turn in `workTree`. Its turns in other checkouts stay open. */
  turnEnded(sessionId: string, workTree: string): void {
    const open = this.openTurns.get(sessionId)
    const turn = open?.get(resolve(workTree))
    if (!open || !turn) return
    const now = Date.now()
    turn.endedAt = now
    for (const span of turn.tools.values()) span.endedAt ??= now
    open.delete(turn.workTree)
    if (open.size === 0) this.openTurns.delete(sessionId)
    this.forgetUnneededTurns(turn.workTree)
  }

  /** End each open turn of the session, in all its checkouts. */
  sessionTurnsEnded(sessionId: string): void {
    for (const workTree of this.openTurns.get(sessionId)?.keys() ?? []) this.turnEnded(sessionId, workTree)
  }

  /** Record when a session's tool calls start and end, in each checkout the
   *  session has an open turn in: a tool event names no checkout. Both
   *  providers' events arrive here in the normalized shape. */
  observe(sessionId: string, event: NormalizedEvent): void {
    const open = this.openTurns.get(sessionId)
    if (!open) return
    if (event.type === 'tool_call') {
      const startedAt = Date.now()
      for (const turn of open.values()) if (!turn.tools.has(event.toolId)) turn.tools.set(event.toolId, { startedAt })
      return
    }
    // A tool_call_complete without an outcome only ends Claude's input stream.
    const endedToolId = event.type === 'tool_result'
      ? event.toolUseId
      : event.type === 'tool_call_complete' && (event.outcome || event.completedAtMs !== undefined)
        ? event.toolId
        : undefined
    if (!endedToolId) return
    const endedAt = Date.now()
    for (const turn of open.values()) {
      const span = turn.tools.get(endedToolId)
      if (span) span.endedAt ??= endedAt
    }
  }

  /** The session's open turn in `workTree`, or null when it has none or no
   *  other session had a turn there at the same time (the usual case). */
  concurrentTurn(sessionId: string, workTree: string): ConcurrentTurn | null {
    const own = this.openTurns.get(sessionId)?.get(resolve(workTree))
    if (!own) return null
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
    const openStarts: number[] = []
    for (const open of this.openTurns.values()) {
      const turn = open.get(workTree)
      if (turn) openStarts.push(turn.startedAt)
    }
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
