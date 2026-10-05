import type { ContextCompaction } from '@solus/contracts/types'
import { formatTokens } from '../../../lib/contextUsage'

/** The words on a compaction divider. Only what the provider reported is
 *  stated: Codex reports no trigger and no token counts. */
export function compactionDividerText(compaction: ContextCompaction): { label: string; detail: string | null } {
  const label = compaction.trigger === 'auto'
    ? 'Context compacted automatically'
    : compaction.trigger === 'manual' ? 'Context compacted on request' : 'Context compacted'
  const { preTokens, postTokens } = compaction
  let detail: string | null = null
  if (preTokens !== undefined && postTokens !== undefined) {
    detail = `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens`
  } else if (preTokens !== undefined) {
    detail = `from ${formatTokens(preTokens)} tokens`
  }
  return { label, detail }
}
