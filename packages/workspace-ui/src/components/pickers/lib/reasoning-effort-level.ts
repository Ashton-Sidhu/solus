import type { ReasoningEffort } from '@solus/contracts/types'

/** How many of the glyph's four bars a reasoning effort fills. The four
 *  deepest levels share the top: past Extra High the bars have nowhere to go,
 *  and the label in the tooltip and the menu still names them apart. */
export function reasoningEffortBars(effort: ReasoningEffort | null | undefined): number {
  switch (effort) {
    case 'none': return 0
    case 'low': return 1
    case 'medium': return 2
    case 'high': return 3
    case 'xhigh':
    case 'max':
    case 'ultra':
    case 'ultracode': return 4
    default: return 3
  }
}
