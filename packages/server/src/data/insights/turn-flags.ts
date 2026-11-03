import type { TurnFlag, TurnFlagKind } from '@solus/contracts/observability-types'
import { getDb } from '../../db'

// A person's mark on a turn lives in solus.db beside the saved queries: it is
// durable judgement, not telemetry, so it survives metrics.db rollover and it
// is never written by an emitter. Every flag names the person who made it,
// `createdBy` (their user key, as `ownerKeyOf` answers it), and a person reads
// their own flags only: a shared host shows nobody another member's judgement
// (plans/029 P8). One mark per turn per person — a second replaces the first,
// and the first's creation time survives so "when did I flag this" keeps its
// answer.

const FLAG_KINDS = new Set<TurnFlagKind>(['good', 'bad_answer', 'too_slow', 'expensive'])

interface TurnFlagRow {
  trace_id: string
  kind: string
  note: string
  created_at: number
  updated_at: number
}

function isFlagKind(value: string): value is TurnFlagKind {
  // SAFETY: the set holds exactly the union's members, so membership is the
  // narrowing.
  return FLAG_KINDS.has(value as TurnFlagKind)
}

function toFlag(row: TurnFlagRow): TurnFlag | null {
  if (!isFlagKind(row.kind)) return null
  return {
    traceId: row.trace_id,
    kind: row.kind,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The flags `createdBy` made, newest change first. */
export function listTurnFlags(createdBy: string): TurnFlag[] {
  const rawRows: unknown = getDb().prepare(`
    SELECT trace_id, kind, note, created_at, updated_at
    FROM turn_flags
    WHERE created_by = ?
    ORDER BY updated_at DESC
  `).all(createdBy)
  // SAFETY: the SELECT names exactly the columns `TurnFlagRow` declares.
  const rows = rawRows as TurnFlagRow[]
  return rows.flatMap((row) => {
    const flag = toFlag(row)
    return flag ? [flag] : []
  })
}

/** Mark a turn. A kind the contract does not name is refused rather than
 *  stored, because a stored unknown would be dropped on every read. */
export function setTurnFlag(createdBy: string, flag: { traceId: string; kind: TurnFlagKind; note: string }): TurnFlag[] {
  if (!flag.traceId.trim()) throw new Error('A turn flag needs a trace id.')
  if (!isFlagKind(flag.kind)) throw new Error(`Unknown turn flag kind: ${String(flag.kind)}`)
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO turn_flags (created_by, trace_id, kind, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (created_by, trace_id) DO UPDATE SET
      kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at
  `).run(createdBy, flag.traceId, flag.kind, flag.note.trim(), now, now)
  return listTurnFlags(createdBy)
}

/** Idempotent, so two surfaces unmarking the same turn both succeed. */
export function clearTurnFlag(createdBy: string, traceId: string): TurnFlag[] {
  getDb().prepare('DELETE FROM turn_flags WHERE created_by = ? AND trace_id = ?').run(createdBy, traceId)
  return listTurnFlags(createdBy)
}
