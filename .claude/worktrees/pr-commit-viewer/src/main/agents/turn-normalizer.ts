import type { NormalizedEvent } from '../../shared/types'

export interface TurnSummary {
  toolCallCount: number
  sawRateLimit: boolean
  sawProtocolError: boolean
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
}

/**
 * Per-turn stateful translator from one provider's raw events to canonical
 * NormalizedEvents. One instance per turn; the only seam between raw and
 * normalized. After interrupt(), push() emits nothing.
 */
export interface TurnNormalizer<Raw> {
  push(raw: Raw): NormalizedEvent[]
  interrupt(): void
  readonly summary: TurnSummary
}
