import { useEffect, useRef, useState, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react-native'
import { sessionSearchNavigation, type SearchMessageRequest } from '@solus/client-core/session-search-navigation'
import { searchTargetMatches } from '@solus/contracts/session-search'
import { useListened } from '../../app/app-context'
import type { ConversationStore } from '../conversation/conversation-store'
import type { ThreadFeedRow } from './thread-feed-presentation'

/** Resolve an indexed message through bounded history pages and the native list. */
export function useSearchMessageJump(options: {
  store: ConversationStore
  rows: readonly ThreadFeedRow[]
  listRef: RefObject<LegendListRef | null>
  revealTurn: (turnId: string) => void
  releaseEnd: () => void
}): string | null {
  const { store, rows, listRef, revealTurn, releaseEnd } = options
  const [request, setRequest] = useState<SearchMessageRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastReadLength = useRef<number | null>(null)
  const meta = useListened(store.meta, store.metaSnapshotOf)
  const order = useListened(store.order, store.orderSnapshot)
  useEffect(() => {
    const take = () => {
      const next = sessionSearchNavigation.take(store.controller.hostId, store.controller.run.sessionId ?? '')
      if (next) { lastReadLength.current = null; releaseEnd(); setError(null); setRequest(next) }
    }
    take()
    return sessionSearchNavigation.subscribe(take)
  }, [store, releaseEnd])
  useEffect(() => {
    if (!request || meta.phase.kind === 'loading' || meta.loadingOlder) return
    if (meta.phase.kind === 'error') { setError(meta.phase.message); setRequest(null); return }
    let wanted = true
    const messageId = order.find(id => {
      const item = store.item(id)
      return item && (item.kind === 'user' || item.kind === 'assistant') && searchTargetMatches(request.target, { id: item.id, role: item.kind, content: item.text, timestamp: item.timestamp, sourceSessionId: item.sourceSessionId })
    })
    if (messageId) {
      const index = rows.findIndex(row => row.id === messageId)
      if (index < 0) {
        const position = order.indexOf(messageId)
        const userId = order.slice(0, position + 1).findLast(id => store.item(id)?.kind === 'user')
        revealTurn(userId ? `turn:${userId}` : 'turn:start')
        return
      }
      const frame = requestAnimationFrame(() => {
        releaseEnd()
        listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.4 })
        setRequest(null)
      })
      return () => cancelAnimationFrame(frame)
    }
    if (!meta.hasOlder) { setError('The matching message is no longer available.'); setRequest(null); return }
    if (lastReadLength.current !== null && order.length <= lastReadLength.current) {
      setError('Could not load the matching message. Open search to try again.')
      setRequest(null)
      return
    }
    lastReadLength.current = order.length
    void store.controller.loadOlder().catch(cause => {
      if (wanted) { setError(cause instanceof Error ? cause.message : String(cause)); setRequest(null) }
    })
    return () => { wanted = false }
  }, [request, meta.phase.kind, meta.loadingOlder, meta.hasOlder, order, rows, store, listRef, revealTurn, releaseEnd])
  return error ?? (request ? 'Finding matching message…' : null)
}
