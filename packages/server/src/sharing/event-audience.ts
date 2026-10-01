import type { AttentionEntry } from '@solus/contracts/attention-types'
import type { HostEvent } from '@solus/contracts/host-events'
import type { ShareResource } from '@solus/contracts/sharing'
import { isHostOwner, type Principal } from '../admission/principal'
import type { ShareManager } from './share-manager'

/**
 * Which host events a connected principal may receive
 * (docs/plans/multiplayer-sharing.md §3.7: list RPCs never return an id the caller
 * cannot open; the same holds for the event stream). The owner and the host itself
 * hear everything. A member hears host-wide facts plus the sessions and works they
 * can open. A guest hears its one resource and nothing about the host.
 *
 * Room events (a session's watchers, a work open live) go through
 * `HostEventPublisher.publishToRoom`: this check runs on a member's first event
 * in the room, and again after any share or task change, not on every event.
 */
export async function eventVisibleTo(principal: Principal, event: HostEvent, shares: ShareManager): Promise<boolean> {
  if (principal.kind === 'system' || isHostOwner(principal)) return true
  // A runner writes; it reads nothing back from the people's side.
  if (principal.kind === 'runner') return false
  const resource = eventResource(event)
  if (event.type === 'share.changed') {
    if (await shares.roleFor(principal, event.payload.resource) !== 'none') return true
    // The person whose access was just removed still hears about it once.
    return principal.kind === 'org-member' && event.payload.removedUserIds.includes(principal.userId)
  }
  if (principal.kind === 'guest') {
    // A guest on a task page re-reads it when tasks change. An event that names
    // a task reaches only a guest who can open that task.
    if (event.type === 'tasks.invalidated') {
      if (principal.share.resource.kind !== 'task') return false
      return !resource || await shares.roleFor(principal, resource) !== 'none'
    }
    return resource !== null && await shares.roleFor(principal, resource) !== 'none'
  }
  if (!resource) return !GUEST_ONLY_HIDDEN.has(event.type) || principal.kind === 'org-member'
  return await shares.roleFor(principal, resource) !== 'none'
}

/**
 * The attention entries a principal may see: one per session it can open (plan 004
 * item 5). The owner and the host itself see every entry; a runner sees none.
 */
export async function attentionVisibleTo(principal: Principal, entries: readonly AttentionEntry[], shares: ShareManager): Promise<AttentionEntry[]> {
  if (principal.kind === 'system' || isHostOwner(principal)) return [...entries]
  if (principal.kind === 'runner') return []
  const visible = await Promise.all(entries.map(async (entry) => await shares.roleFor(principal, { kind: 'session', id: entry.sessionId }) !== 'none'))
  return entries.filter((_entry, index) => visible[index])
}

/** Events that carry no resource id and describe the host as a whole; members hear them, guests never do. */
const GUEST_ONLY_HIDDEN = new Set<HostEvent['type']>([
  'session.indexChanged',
  'attention.snapshotChanged',
  'tasks.invalidated',
  'workspaceProjects.changed',
  'outbox.changed',
  'config.changed',
  'usage.limitsChanged',
  'metrics.turnsChanged',
  'metrics.insightPullChanged',
  'host.presenceChanged',
  'host.uplinkStatusChanged',
])

/** The session, work, or task an event is about, when it names exactly one. */
export function eventResource(event: HostEvent): ShareResource | null {
  switch (event.type) {
    case 'session.eventReceived':
    case 'session.errorReceived':
    case 'session.titleChanged':
    case 'session.pullRequestsChanged':
    case 'session.stateChanged':
    case 'session.readStateChanged':
    case 'session.transcriptChanged':
    case 'session.statusChanged':
    case 'session.presenceChanged':
      return { kind: 'session', id: event.payload.sessionId }
    case 'works.changed':
      return { kind: 'work', id: event.payload.workId }
    case 'workReviews.changed':
    case 'workLive.update':
    case 'workLive.awareness':
    case 'workLive.state':
      return { kind: 'work', id: event.payload.workId }
    case 'annotations.changed':
      return event.payload.kind === 'work'
        ? { kind: 'work', id: event.payload.targetId }
        : { kind: 'session', id: event.payload.targetId.split('__')[0] ?? event.payload.targetId }
    case 'metrics.turnsChanged':
      return event.payload.sessionId ? { kind: 'session', id: event.payload.sessionId } : null
    case 'share.changed':
      return event.payload.resource
    case 'tasks.invalidated':
      return event.payload.taskId ? { kind: 'task', id: event.payload.taskId } : null
    default:
      return null
  }
}
