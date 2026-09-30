import type { TurnFlag, TurnFlagKind } from '@solus/contracts/observability-types'
import { getDb } from '../../db'

// A person's mark on a turn lives in solus.db beside the saved queries: it is
// durable judgement, not telemetry, so it survives metrics.db rollover and it
// is never written by an emitter. One mark per turn — a second replaces the
// first, and the first's creation time survives so "when did I flag this"
// keeps its answer.

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

export function listTurnFlags(): TurnFlag[] {
  const rawRows: unknown = getDb().prepare(`
    SELECT trace_id, kind, note, created_at, updated_at
    FROM turn_flags
    ORDER BY updated_at DESC
  `).all()
  // SAFETY: the SELECT names exactly the columns `TurnFlagRow` declares.
  const rows = rawRows as TurnFlagRow[]
  return rows.flatMap((row) => {
    const flag = toFlag(row)
    return flag ? [flag] : []
  })
}

/** Mark a turn. A kind the contract does not name is refused rather than
 *  stored, because a stored unknown would be dropped on every read. */
export function setTurnFlag(flag: { traceId: string; kind: TurnFlagKind; note: string }): TurnFlag[] {
  if (!flag.traceId.trim()) throw new Error('A turn flag needs a trace id.')
  if (!isFlagKind(flag.kind)) throw new Error(`Unknown turn flag kind: ${String(flag.kind)}`)
  const rawExisting: unknown = getDb()
    .prepare('SELECT created_at FROM turn_flags WHERE trace_id = ?')
    .get(flag.traceId)
  // SAFETY: the SELECT names one column, so a matched row carries only `created_at`.
  const existing = rawExisting as { created_at: number } | undefined
  const now = Date.now()
  getDb().prepare(`
    INSERT OR REPLACE INTO turn_flags (trace_id, kind, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(flag.traceId, flag.kind, flag.note.trim(), existing?.created_at ?? now, now)
  return listTurnFlags()
}

/** Idempotent, so two surfaces unmarking the same turn both succeed. */
export function clearTurnFlag(traceId: string): TurnFlag[] {
  getDb().prepare('DELETE FROM turn_flags WHERE trace_id = ?').run(traceId)
  return listTurnFlags()
}
