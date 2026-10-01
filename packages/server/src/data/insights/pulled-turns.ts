import type { WorkspaceInsight, WorkspaceInsightTree } from '@solus/contracts/solus-api'
import { getMetricsDb } from './metrics-db'
import type { SpanStatus } from './registries'
import { announceTurnRow } from './span-table'

// ─── Turns pulled from other hosts (docs/plans/insights-across-hosts.md) ───
//
// The workspace service holds the turns every host of a person mirrored. A
// pulled turn lands here as its root row, with the host that ran it in
// `host_id`, so the list, totals and SQL read it like a turn this host ran.
// Writes never overwrite: a mirrored span does not change once it ends, and a
// turn this host recorded keeps its own complete row. The one replace is a
// pulled root whose full tree arrives.

function spanStatus(status: string): SpanStatus {
  return status === 'ok' || status === 'error' || status === 'interrupted' ? status : 'unknown'
}

/** Writes the turn rows another host ran, and answers how many were new. */
export function writePulledTurns(organizationId: string, turns: WorkspaceInsight[]): number {
  const db = getMetricsDb()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      user_id, user_email, organization_id, host_id,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, NULL, ?, 'turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const written: WorkspaceInsight[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const turn of turns) {
      const startedAt = Date.parse(turn.startedAt)
      const endedAt = turn.endedAt ? Date.parse(turn.endedAt) : startedAt + turn.durationMs
      const result = insert.run(
        turn.traceId, turn.traceId, turn.name, turn.service,
        turn.sessionId, turn.provider, turn.model, turn.projectRoot, turn.origin,
        turn.userId, turn.userEmail, organizationId, turn.hostId,
        startedAt, endedAt, turn.durationMs, spanStatus(turn.status), JSON.stringify(turn.attrs),
      )
      if (Number(result.changes) > 0) written.push(turn)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  for (const turn of written) announceTurnRow({ traceId: turn.traceId, sessionId: turn.sessionId ?? undefined }, spanStatus(turn.status))
  return written.length
}

/** The start of the newest turn pulled for the organization, or null before the first pull. */
export function newestPulledTurnStart(organizationId: string): number | null {
  const rawRow: unknown = getMetricsDb().prepare(`
    SELECT MAX(started_at) AS newest FROM spans
    WHERE kind = 'turn' AND span_id = trace_id AND host_id IS NOT NULL AND organization_id = ?
  `).get(organizationId)
  // SAFETY: an aggregate without GROUP BY always returns one row with that one column.
  const row = rawRow as { newest: number | null }
  return row.newest
}

/** Where a pulled turn's tree comes from, or null when this host ran the turn or already holds its tree. */
export function pulledTurnAwaitingTree(traceId: string): { hostId: string; organizationId: string } | null {
  const rawRow: unknown = getMetricsDb().prepare(`
    SELECT root.host_id AS hostId, root.organization_id AS organizationId FROM spans AS root
    WHERE root.span_id = ? AND root.span_id = root.trace_id AND root.host_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM spans AS child WHERE child.trace_id = root.trace_id AND child.span_id != root.span_id)
  `).get(traceId)
  // SAFETY: the statement selects exactly these two columns, and `host_id IS NOT NULL` holds.
  const row = rawRow as { hostId: string; organizationId: string | null } | undefined
  return row?.organizationId ? { hostId: row.hostId, organizationId: row.organizationId } : null
}

/**
 * Writes a pulled turn's full tree. The root replaces the trimmed row the list
 * pulled; every other span is new. The trace's events are rewritten as one set,
 * so a second fetch of the same tree does not double them.
 */
export function writePulledTree(organizationId: string, hostId: string, tree: WorkspaceInsightTree): void {
  const db = getMetricsDb()
  const span = (replace: boolean) => db.prepare(`
    INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      user_id, user_email, organization_id, host_id,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const replaceRoot = span(true)
  const insertChild = span(false)
  const insertEvent = db.prepare(`
    INSERT INTO log_events (trace_id, span_id, occurred_at, level, name, tag, file, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const traceIds = new Set(tree.spans.map((row) => row.traceId))
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of tree.spans) {
      const statement = row.spanId === row.traceId ? replaceRoot : insertChild
      statement.run(
        row.spanId, row.parentSpanId, row.traceId, row.kind, row.name, row.service,
        row.sessionId, row.provider, row.model, row.projectRoot, row.origin,
        row.userId, row.userEmail, organizationId, hostId,
        row.startedAt, row.endedAt, row.endedAt - row.startedAt, spanStatus(row.status), JSON.stringify(row.attrs),
      )
    }
    const traceOf = new Map(tree.spans.map((row) => [row.spanId, row.traceId]))
    for (const traceId of traceIds) db.prepare('DELETE FROM log_events WHERE trace_id = ?').run(traceId)
    for (const event of tree.events) {
      const traceId = traceOf.get(event.spanId)
      if (!traceId) continue
      insertEvent.run(traceId, event.spanId, event.occurredAt, event.level, event.name, event.tag, event.file, JSON.stringify(event.attrs))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
