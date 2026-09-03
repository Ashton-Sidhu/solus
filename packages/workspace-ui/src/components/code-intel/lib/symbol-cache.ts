import type { CodeIntelSymbolResult } from '@solus/contracts/code-intel'

/** A symbol answer is safe until an index status event clears the cache. Misses
 *  are kept only when the ready index confirms that they are fresh. */
export function canReuseSymbolAnswer(result: CodeIntelSymbolResult | undefined): boolean {
  if (!result?.ok) return false
  if (result.symbol !== null) return true
  return result.freshness === 'fresh' && result.language?.state === 'ready'
}
