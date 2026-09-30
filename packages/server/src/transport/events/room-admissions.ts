import type { ShareResource } from '@solus/contracts/sharing'
import type { ClientId } from './client-event-registry'

/**
 * Who has already passed the audience check for a room's events.
 *
 * A room is the clients that opened one resource: a session's watchers, a
 * work open live. Its events are frequent — every streamed provider event,
 * every live edit — and the audience check reads the share list. The first
 * event to each member is checked as any event is; a pass is remembered, so
 * the member's later events in that room are not checked again. A refusal is
 * never remembered: a session gains its owner after it is first watched, and
 * the next event checks again. Any change to a share list forgets every pass,
 * so the event after a change is checked against the new list.
 */
export class RoomAdmissions {
  private readonly admitted = new Map<string, Set<ClientId>>()

  static key(resource: ShareResource): string {
    return `${resource.kind}:${resource.id}`
  }

  has(room: string, clientId: ClientId): boolean {
    return this.admitted.get(room)?.has(clientId) ?? false
  }

  admit(room: string, clientId: ClientId): void {
    let members = this.admitted.get(room)
    if (!members) {
      members = new Set()
      this.admitted.set(room, members)
    }
    members.add(clientId)
  }

  /** A share list changed: every member is checked again on its next event. */
  forgetAll(): void {
    this.admitted.clear()
  }

  /** A client went away: its passes go with it. */
  forgetClient(clientId: ClientId): void {
    for (const [room, members] of this.admitted) {
      members.delete(clientId)
      if (members.size === 0) this.admitted.delete(room)
    }
  }
}
