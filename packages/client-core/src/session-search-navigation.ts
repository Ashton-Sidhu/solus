import type { SessionSearchTarget } from '@solus/contracts/session-search'

export interface SearchMessageRequest { target: SessionSearchTarget; query: string }
const pending = new Map<string, SearchMessageRequest>()
const listeners = new Set<() => void>()
const keyOf = (serverId: string, sessionId: string) => `${serverId}\0${sessionId}`

/** One pending navigation per conversation; views consume it only when they are visible. */
export const sessionSearchNavigation = {
  request(serverId: string, sessionId: string, request: SearchMessageRequest) {
    if (pending.size >= 100) pending.delete(pending.keys().next().value!)
    pending.set(keyOf(serverId, sessionId), request)
    for (const listener of listeners) listener()
  },
  take(serverId: string, sessionId: string): SearchMessageRequest | undefined {
    const key = keyOf(serverId, sessionId)
    const request = pending.get(key)
    pending.delete(key)
    return request
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
}
