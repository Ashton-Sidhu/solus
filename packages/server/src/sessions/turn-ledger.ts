import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import { createLogger } from '../logger'

const log = createLogger('main', 'turn-ledger')

/**
 * The durable turn ledger in its minimal shape (Step 2 plan §3.4, decision
 * 2026-09-04): who asked for a turn, whose seat it ran on, and when it settled.
 * Written at dispatch and settlement; read by nothing yet except the per-seat
 * usage attribution and, later, billing. This file owns its table and the handle
 * is injected, so a managed host that moves to Postgres ports this one file.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_turn (
  turn_id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seat_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'interrupted', 'failed')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS session_turn_session_idx ON session_turn(session_id, created_at);
CREATE INDEX IF NOT EXISTS session_turn_seat_idx ON session_turn(seat_user_id, created_at);
`

export const turnRecordSchema = z.object({
  turn_id: z.string(),
  prompt_id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  seat_user_id: z.string(),
  provider: z.string(),
  state: z.enum(['running', 'completed', 'interrupted', 'failed']),
  created_at: z.number(),
  started_at: z.number().nullable(),
  settled_at: z.number().nullable(),
})
export type TurnRecord = z.infer<typeof turnRecordSchema>

/** Who a turn is for: the prompt's author and the member whose seat runs it. */
export interface TurnActor {
  /** Account identity for integration tools, distinct from host-local ownership. */
  credentialUserId?: string | null
  userId: string
  seatUserId: string
  /** How the author is shown to other people on the transcript and in the room; absent for the host's own work. */
  displayName?: string
  avatarUrl?: string
}

export class TurnLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
  }

  /** A turn is on the ledger the moment the provider is launched. */
  start(turn: { turnId: string; promptId: string; sessionId: string; actor: TurnActor; provider: AgentId; startedAt: number }): void {
    try {
      this.db.prepare(`
        INSERT INTO session_turn (turn_id, prompt_id, session_id, user_id, seat_user_id, provider, state, created_at, started_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL)
        ON CONFLICT(turn_id) DO NOTHING
      `).run(turn.turnId, turn.promptId, turn.sessionId, turn.actor.userId, turn.actor.seatUserId, turn.provider, turn.startedAt, turn.startedAt)
    } catch (error) {
      // The ledger never blocks a turn; a missed row is a diagnostic gap, not a refusal.
      log.warn('turn_ledger_write_failed', { turnId: turn.turnId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  settle(turnId: string, state: 'completed' | 'interrupted' | 'failed', settledAt: number): void {
    try {
      this.db.prepare("UPDATE session_turn SET state = ?, settled_at = ? WHERE turn_id = ? AND state = 'running'")
        .run(state, settledAt, turnId)
    } catch (error) {
      log.warn('turn_ledger_settle_failed', { turnId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The most recent turns of one session, newest first. */
  forSession(sessionId: string, limit = 50): TurnRecord[] {
    return turnRecordSchema.array().parse(
      this.db.prepare('SELECT * FROM session_turn WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit),
    )
  }
}
