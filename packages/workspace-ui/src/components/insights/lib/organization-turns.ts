import type { MetricsQueryResult } from '@solus/contracts/observability-types'
import type { WorkspaceInsightPage } from '@solus/contracts/solus-api'
import { formatCost, formatDuration } from './format'

/**
 * One organization's turns (docs/plans/organization-scope.md §6.1), as the Solus
 * API holds them, in the shape the result table draws: one row per turn with who
 * ran it, on what, and what it cost. Pure, so the columns are tested once.
 */

export const ORGANIZATION_TURN_COLUMNS = ['started', 'user', 'provider', 'model', 'status', 'duration', 'cost'] as const

export function organizationTurnsTable(result: WorkspaceInsightPage): MetricsQueryResult {
  return {
    columns: ORGANIZATION_TURN_COLUMNS.map((name) => ({ name })),
    rows: result.items.map((turn) => [
      new Date(turn.startedAt).toISOString(),
      turn.userEmail ?? turn.userId ?? '—',
      turn.provider ?? '—',
      turn.model ?? '—',
      turn.status,
      formatDuration(turn.durationMs),
      turn.costUsd === null ? '—' : formatCost(turn.costUsd),
    ]),
  }
}

/** The page describes only the records loaded, never a total for the full range. */
export function organizationTurnsSummary(result: WorkspaceInsightPage, organizationName: string): string {
  const count = result.items.length
  return `${organizationName} · ${count} ${count === 1 ? 'turn' : 'turns'} on this page`
}
