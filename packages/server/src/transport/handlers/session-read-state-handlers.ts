import { markSessionUnread, markSessionViewed } from '../../data/sessions/session-states'
import { actorFor, ownerKeyOf } from '../../admission/actor'
import type { SolusServer } from '../server'

/**
 * Read state for a session, owned by the host rather than by whichever client
 * happened to open it, and kept per person: reading a session on the desktop
 * clears its indicator on the phone of the same person, and on nobody else's.
 *
 * One method rather than a read/unread pair: the state is a single nullable
 * boundary, and the event that carries it back is a single nullable field too.
 * The two directions differ only in their rule — a read is monotonic, clearing
 * is not — and that belongs in the decider, not in the wire surface.
 *
 * The host publishes `session.readStateChanged` to the person's connections for
 * each move of the boundary (boot-server.ts), so an agent's mark_unread reaches
 * every device of the person it marks it for.
 */
export function registerSessionReadStateHandlers(server: SolusServer): void {
  server.register('setSessionReadState', async (args, ctx) => {
    const [sessionId, viewedAt] = args
    // A connection that acts for no person — a runner, the host itself — reads nothing as a person.
    const personKey = ownerKeyOf(actorFor(ctx.principal))
    if (!personKey) return null
    if (viewedAt === null) {
      await markSessionUnread(sessionId, personKey)
      return null
    }
    return markSessionViewed(sessionId, personKey, viewedAt)
  })
}
