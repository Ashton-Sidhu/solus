import { markSessionUnread, markSessionViewed } from '../../data/sessions/session-states'
import type { SolusServer } from '../server'

/**
 * Read state for a session, owned by the host rather than by whichever client
 * happened to open it.
 *
 * One method rather than a read/unread pair: the state is a single nullable
 * boundary, and the event that carries it back is a single nullable field too.
 * The two directions differ only in their rule — a read is monotonic, clearing
 * is not — and that belongs in the decider, not in the wire surface.
 *
 * The host broadcasts `session.readStateChanged` for each move of the boundary
 * (boot-server.ts), so reading a session on the desktop clears its indicator
 * on the phone too, and an agent's mark_unread reaches every client.
 */
export function registerSessionReadStateHandlers(server: SolusServer): void {
  server.register('setSessionReadState', async (args) => {
    const [sessionId, viewedAt] = args
    if (viewedAt === null) {
      await markSessionUnread(sessionId)
      return null
    }
    return markSessionViewed(sessionId, viewedAt)
  })
}
