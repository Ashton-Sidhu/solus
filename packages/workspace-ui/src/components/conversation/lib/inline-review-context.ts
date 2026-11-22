import { getContext, setContext } from 'svelte'
import type { ReadTurnDiff } from '@solus/client-core/inline-review-guide'

const key = Symbol('conversation-turn-diff')

export function provideTurnDiffReader(read: ReadTurnDiff): void {
  setContext(key, read)
}

export function getTurnDiffReader(): ReadTurnDiff | undefined {
  return getContext(key)
}
