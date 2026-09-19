import { presenceSetComposingRequestSchema, presenceSetFocusRequestSchema, PRESENCE_NO_FOCUS, type PresenceFocus } from '@solus/contracts/presence'
import type { PresenceManager } from '../../presence/presence-manager'
import type { Principal } from '../principal'
import type { SolusServer } from '../server'

/**
 * What a client tells the host about itself (docs/plans/multiplayer-presence.md):
 * where it is looking and whether it is typing. Both are hints for other people's
 * screens, never an authorization. Identity is never taken from the request; the
 * manager already named this client from its principal at admission.
 */
export function registerPresenceHandlers(server: SolusServer, deps: {
  presence: PresenceManager
  onHostChanged: () => void
  onSessionChanged: (sessionId: string) => void
}): void {
  server.register('presenceSnapshot', (_args, ctx) => ({
    clientId: ctx.clientId,
    // A guest is never told about the host: it sees its one session's room, nothing more.
    host: ctx.principal.kind === 'guest' ? { participants: [] } : deps.presence.hostSnapshot(),
  }))

  server.register('presenceSetFocus', (args, ctx) => {
    const { focus } = presenceSetFocusRequestSchema.parse(args[0])
    if (deps.presence.setFocus(ctx.clientId, guestScopedFocus(focus, ctx.principal))) deps.onHostChanged()
  })

  server.register('presenceSetComposing', (args, ctx) => {
    const { sessionId, isComposing } = presenceSetComposingRequestSchema.parse(args[0])
    const changed = deps.presence.setComposing(ctx.clientId, sessionId, isComposing)
    for (const changedSessionId of changed) deps.onSessionChanged(changedSessionId)
    // The roster row marks a draft in the focused session only, so the host
    // hears about a draft exactly when it moves into or out of that session.
    const focus = deps.presence.focusOf(ctx.clientId)
    if (focus?.kind === 'session' && changed.includes(focus.sessionId)) deps.onHostChanged()
  })
}

/** A guest can only ever be looking at the one resource it was let in to see. */
function guestScopedFocus(focus: PresenceFocus, principal: Principal): PresenceFocus {
  if (principal.kind !== 'guest') return focus
  const shared = principal.share.resource
  if (focus.kind === 'session' && shared.kind === 'session' && focus.sessionId === shared.id) return focus
  if (focus.kind === 'work' && shared.kind === 'work' && focus.workId === shared.id) return focus
  return PRESENCE_NO_FOCUS
}
