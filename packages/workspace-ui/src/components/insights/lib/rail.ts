import { formatClock, formatCost, formatDuration, singleLine } from './format'
import type { EventColumn, EventRow } from './result-shape'
import type { TurnRow } from './turn-rows'

/**
 * The list rail beside an open turn (docs/plans/observability.md).
 *
 * While the detail panel is open the full-width listing compresses to a 380px
 * rail, the way the pull-request list does. A rail item keeps two things: the
 * identity a reader needs to hold their place (title, time, status), and the
 * drill identity a click or a step needs to move the panel (trace id, and the
 * span id when the listing is span-grained).
 */
export interface RailItem {
  key: string
  traceId: string
  sessionId: string | null
  /** Present on event rows: the panel lands on this span, not just its turn. */
  spanId: string | null
  title: string
  status: string
  timeLabel: string
  metaLabel: string
}

export function railItemsFromTurns(rows: TurnRow[]): RailItem[] {
  return rows.map((row) => ({
    key: row.traceId,
    traceId: row.traceId,
    sessionId: row.sessionId,
    spanId: null,
    title: singleLine(row.prompt) || '—',
    status: row.status,
    timeLabel: formatClock(row.startedAt),
    metaLabel: [row.model ?? '—', formatDuration(row.durationMs), formatCost(row.costUsd)].join(
      ' · ',
    ),
  }))
}

/** The first cell that reads as a name: a non-numeric raw column with text. */
function eventTitle(columns: EventColumn[], row: EventRow, fallback: string): string {
  for (const [index, column] of columns.entries()) {
    if (column.format !== 'raw' || column.numeric) continue
    const value = row.cells[index]
    if (typeof value === 'string' && value) return singleLine(value)
  }
  return fallback
}

/** Rows without a trace cannot open the panel, so they stay off the rail. */
export function railItemsFromEvents(
  columns: EventColumn[],
  rows: EventRow[],
  kind: string,
): RailItem[] {
  const fallback = kind || 'event'
  return rows.flatMap((row, index) =>
    row.traceId
      ? [
          {
            key: `${row.traceId}/${row.spanId ?? index}`,
            traceId: row.traceId,
            sessionId: null,
            spanId: row.spanId,
            title: eventTitle(columns, row, fallback),
            status: row.status ?? 'ok',
            timeLabel: formatClock(row.startedAt),
            metaLabel: formatDuration(row.durationMs),
          },
        ]
      : [],
  )
}

/**
 * Where the open turn sits in the rail — what the panel's `n of N` stepper
 * walks. A turn-grained item matches on its trace alone; a span-grained item
 * matches its exact span, so stepping an event listing moves span by span.
 */
export function railIndexOf(
  items: RailItem[],
  traceId: string | null,
  spanId: string | null,
): number {
  if (!traceId) return -1
  return items.findIndex(
    (item) =>
      item.traceId === traceId &&
      (item.spanId === null || spanId === null || item.spanId === spanId),
  )
}
