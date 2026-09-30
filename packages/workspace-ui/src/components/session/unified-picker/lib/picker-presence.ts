import type { PresenceFocus } from '@solus/contracts/presence'
import type { PresencePerson } from '../../../presence/lib/presence-people'
import type { PickerEntry } from './picker-rows'

/** One session a picker row stands for, on the host that runs it. */
export interface PickerSessionRef {
  serverId: string
  sessionId: string
}

/**
 * The sessions a row stands for: a task row all of its sessions, so a closed
 * task still says who is working under it; a session or conversation row the
 * one session. A session with no host or id yet (a draft) has no room.
 */
export function pickerRowSessions(row: PickerEntry): PickerSessionRef[] {
  if (row.kind === 'conversation') {
    const serverId = row.hitServerId ?? row.meta.serverId
    return serverId ? [{ serverId, sessionId: row.meta.sessionId }] : []
  }
  const children = row.kind === 'task' ? row.sessions : [row.session]
  const refs: PickerSessionRef[] = []
  for (const child of children) {
    if (child.serverId && child.sessionId) refs.push({ serverId: child.serverId, sessionId: child.sessionId })
  }
  return refs
}

/**
 * Everyone whose screen shows one of the sessions, once per person: a person in
 * two of a task's sessions is one face. The picker says who is working where,
 * not who is typing, so the faces carry no typing mark.
 */
export function peopleOnSessions(
  sessions: PickerSessionRef[],
  peopleFocusedOn: (serverId: string, focus: PresenceFocus) => PresencePerson[],
): PresencePerson[] {
  const byUser = new Map<string, PresencePerson>()
  for (const { serverId, sessionId } of sessions) {
    for (const person of peopleFocusedOn(serverId, { kind: 'session', sessionId })) {
      if (!byUser.has(person.userId)) byUser.set(person.userId, { ...person, isComposing: false })
    }
  }
  return [...byUser.values()]
}
