import { presenceSetComposingRequestSchema, presenceSetEditingRequestSchema, presenceSetFocusRequestSchema, PRESENCE_NO_FOCUS, type PresenceFocus } from '@solus/contracts/presence'
import type { PresenceManager } from '../../presence/presence-manager'
import type { Principal } from '../../admission/principal'
import { presenceRoomOf, workPresence } from '../../presence/presence-manager'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { SolusServer } from '../server'

/**
 * Send one organization's room to the clients in it, or to `recipients` among
 * them. The audience filter keeps the host room from guests; a guest on a work's
 * link gets the people on that work instead, as the work's room.
 */
export async function publishPresenceRoom(presence: PresenceManager, events: HostEventPublisher, organizationId: string, recipients?: readonly string[]): Promise<void> {
  const snapshot = await presence.hostSnapshot(organizationId)
  const clientIds = recipients ?? presence.clientsIn(organizationId)
  void events.publish(clientIds, 'host.presenceChanged', snapshot)
  for (const [workId, guestClientIds] of presence.workGuestsIn(organizationId)) {
    const audience = guestClientIds.filter((clientId) => clientIds.includes(clientId))
    if (audience.length) void events.publishToRoom({ kind: 'work', id: workId }, audience, 'work.presenceChanged', workPresence(snapshot, workId))
  }
}

/**
 * What a client tells the host about itself (docs/plans/multiplayer-presence.md):
 * where it is looking and whether it is typing. Both are hints for other people's
 * screens, never an authorization. Identity is never taken from the request; the
 * manager already named this client from its principal at admission.
 */
export function registerPresenceHandlers(server: SolusServer, deps: {
  presence: PresenceManager
  /** The client whose room changed; the caller republishes that room. */
  onHostChanged: (clientId: string) => void
  onSessionChanged: (sessionId: string) => void
}): void {
  server.register('presenceSnapshot', async (_args, ctx) => ({
    clientId: ctx.clientId,
    // A guest is never told about the host: it sees its one session's room, nothing more.
    // Everyone else gets their organization's room: the whole host, or one organization of the workspace service.
    host: ctx.principal.kind === 'guest' ? { participants: [] } : await deps.presence.hostSnapshot(presenceRoomOf(ctx.principal)),
  }))

  server.register('presenceSetFocus', (args, ctx) => {
    const { focus } = presenceSetFocusRequestSchema.parse(args[0])
    if (deps.presence.setFocus(ctx.clientId, guestScopedFocus(focus, ctx.principal))) deps.onHostChanged(ctx.clientId)
  })

  // A typing mark changes by a report, or falls when the reports stop; both tell the same rooms.
  const composingChanged = (clientId: string, changed: string[]): void => {
    for (const changedSessionId of changed) deps.onSessionChanged(changedSessionId)
    // The roster row marks typing in the focused session only, so the host
    // hears about it exactly when it moves into or out of that session.
    const focus = deps.presence.focusOf(clientId)
    if (focus?.kind === 'session' && changed.includes(focus.sessionId)) deps.onHostChanged(clientId)
  }
  deps.presence.onComposingExpired((clientId, sessionId) => composingChanged(clientId, [sessionId]))

  server.register('presenceSetComposing', (args, ctx) => {
    const { sessionId, isComposing } = presenceSetComposingRequestSchema.parse(args[0])
    composingChanged(ctx.clientId, deps.presence.setComposing(ctx.clientId, sessionId, isComposing))
  })

  // Editing a work shows in the roster and the work's avatar stack, which both
  // read the host room; a mark that falls on its own tells it the same way.
  deps.presence.onEditingExpired((clientId) => deps.onHostChanged(clientId))
  server.register('presenceSetEditing', (args, ctx) => {
    const { workId, isEditing } = presenceSetEditingRequestSchema.parse(args[0])
    if (deps.presence.setEditing(ctx.clientId, workId, isEditing)) deps.onHostChanged(ctx.clientId)
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
