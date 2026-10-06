import type { ContextCompaction } from './types'
import { formatTokens } from './token-count'

export interface CompactionDividerText {
  label: string
  /** Token counts, when the provider reported them. */
  detail: string | null
}

/** The words on a compaction divider, the same on every client. Only what the
 *  provider reported is stated: Codex reports no trigger and no token counts. */
export function compactionDividerText(compaction: ContextCompaction): CompactionDividerText {
  if (compaction.isRunning) return { label: 'Compacting context', detail: null }
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
