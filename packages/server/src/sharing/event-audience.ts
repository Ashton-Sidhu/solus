import type { HostEvent } from '@solus/contracts/host-events'
import type { ShareResource } from '@solus/contracts/sharing'
import { isHostOwner, type Principal } from '../server/principal'
import type { ShareManager } from './share-manager'

/**
 * Which host events a connected principal may receive
 * (docs/plans/multiplayer-sharing.md §3.7: list RPCs never return an id the caller
 * cannot open; the same holds for the event stream). The owner and the host itself
 * hear everything. A member hears host-wide facts plus the sessions and works they
 * can open. A guest hears its one resource and nothing about the host.
 */
export function eventVisibleTo(principal: Principal, event: HostEvent, shares: ShareManager): boolean {
  if (principal.kind === 'system' || isHostOwner(principal)) return true
  const resource = eventResource(event)
  if (event.type === 'share.changed') {
    if (shares.roleFor(principal, event.payload.resource) !== 'none') return true
    // The person whose access was just removed still hears about it once.
    return principal.kind === 'org-member' && event.payload.removedUserIds.includes(principal.userId)
  }
  if (principal.kind === 'guest') {
    return resource !== null && shares.roleFor(principal, resource) !== 'none'
  }
  if (!resource) return !GUEST_ONLY_HIDDEN.has(event.type) || principal.kind === 'org-member'
  return shares.roleFor(principal, resource) !== 'none'
}

/** Events that carry no resource id and describe the host as a whole; members hear them, guests never do. */
const GUEST_ONLY_HIDDEN = new Set<HostEvent['type']>([
  'session.indexChanged',
  'attention.snapshotChanged',
  'tasks.invalidated',
  'outbox.changed',
  'config.changed',
  'usage.limitsChanged',
])

/** The session or work an event is about, when it names exactly one. */
export function eventResource(event: HostEvent): ShareResource | null {
  switch (event.type) {
    case 'session.eventReceived':
    case 'session.errorReceived':
    case 'session.titleChanged':
    case 'session.readStateChanged':
    case 'session.statusChanged':
      return { kind: 'session', id: event.payload.sessionId }
    case 'annotations.changed':
      return event.payload.kind === 'work'
        ? { kind: 'work', id: event.payload.targetId }
        : { kind: 'session', id: event.payload.targetId.split('__')[0] ?? event.payload.targetId }
    case 'share.changed':
      return event.payload.resource
    default:
      return null
  }
}
