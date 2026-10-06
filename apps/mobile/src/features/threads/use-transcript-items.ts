import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { ConversationStore } from '../conversation/conversation-store'
import type { TranscriptItem } from '../conversation/lib/transcript-model'

/**
 * One feed row's own transcript item. A streamed token re-renders this row
 * only, as the Solus transcript row did.
 */
export function useTranscriptItem(store: ConversationStore, id: string): TranscriptItem | undefined {
  const subscribe = useCallback((listener: () => void) => store.subscribeItem(id, listener), [store, id])
  const read = useCallback(() => store.item(id), [store, id])
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Several items at once, for a work row that summarizes a group of tool
 * calls. The snapshot is a new array only when one of the items changed.
 */
export function useTranscriptItems(store: ConversationStore, ids: readonly string[]): readonly TranscriptItem[] {
  const snapshot = useRef<readonly TranscriptItem[]>([])
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribes = ids.map((id) => store.subscribeItem(id, listener))
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [store, ids])
  const read = useCallback(() => {
    const next = ids.map((id) => store.item(id)).filter((item): item is TranscriptItem => item !== undefined)
    const previous = snapshot.current
    if (next.length === previous.length && next.every((item, index) => item === previous[index])) return previous
    snapshot.current = next
    return next
  }, [store, ids])
  return useSyncExternalStore(subscribe, read, read)
}
