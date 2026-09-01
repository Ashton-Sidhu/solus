import type { DiagramField } from '@solus/contracts/diagram-types'

/**
 * Rows an entity card shows before it collapses the rest into "+n more". The
 * card is a silhouette on the canvas, not a schema browser — the inspector's
 * Data tab is the full view.
 */
export const CARD_FIELD_LIMIT = 4

export interface CardFields {
  shown: DiagramField[]
  /** Rows hidden behind the "+n more" line. 0 when everything fits. */
  overflow: number
}

export function cardFields(fields: DiagramField[] | undefined): CardFields {
  const all = fields ?? []
  return {
    shown: all.slice(0, CARD_FIELD_LIMIT),
    overflow: Math.max(0, all.length - CARD_FIELD_LIMIT),
  }
}
