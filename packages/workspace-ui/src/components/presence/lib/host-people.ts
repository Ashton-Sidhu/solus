import type { PresenceFocus, SessionActivity } from '@solus/contracts/presence'
import type { Session } from '@solus/contracts/types'
import { sessionTitle } from '../../../lib/sessionUtils'
import { activityWords, type PresencePerson } from './presence-people'

/** A person on one host, for the roster that spans every connected host. */
export interface HostPerson extends PresencePerson {
  serverId: string
}

/** Everyone else across the hosts this client is on, one row per person per host. */
export function hostPeopleAcrossHosts(serverIds: readonly string[], peopleOn: (serverId: string) => PresencePerson[]): HostPerson[] {
  const rows: HostPerson[] = []
  for (const serverId of serverIds) {
    for (const person of peopleOn(serverId)) rows.push({ ...person, serverId })
  }
  return rows
}

/**
 * One person across every host they are on. A teammate on the cloud host and on
 * a shared machine is one face in the roster, not two rows; each host they are
 * on is a place the reader can jump to or follow them on. `userId` is the
 * identity the rows were merged by, and `focus` the first host's, so a roster
 * person is a presence person to every avatar and stack.
 */
export interface RosterPerson extends PresencePerson {
  presences: HostPerson[]
}

/**
 * Merge per-host rows into people. `identityOf` names the person behind a row:
 * the account id, or for a personal host's `host-owner` the account that linked
 * it, so the owner of a machine and the same person on the cloud are one.
 */
export function rosterPeople(rows: readonly HostPerson[], identityOf: (row: HostPerson) => string): RosterPerson[] {
  const byIdentity = new Map<string, RosterPerson>()
  for (const row of rows) {
    const key = identityOf(row)
    const existing = byIdentity.get(key)
    if (existing) {
      existing.presences.push(row)
      existing.deviceCount += row.deviceCount
      existing.clientIds.push(...row.clientIds)
      if (row.isComposing) existing.isComposing = true
      if ((!existing.focus || existing.focus.kind === 'none') && row.focus && row.focus.kind !== 'none') {
        existing.focus = row.focus
        if (row.activity) existing.activity = row.activity
        else delete existing.activity
      }
      if (!existing.avatarUrl && row.avatarUrl) existing.avatarUrl = row.avatarUrl
      continue
    }
    const person: RosterPerson = {
      userId: key,
      displayName: row.displayName,
      initials: row.initials,
      colorIndex: row.colorIndex,
      isComposing: row.isComposing,
      deviceCount: row.deviceCount,
      clientIds: [...row.clientIds],
      presences: [row],
    }
    if (row.avatarUrl) person.avatarUrl = row.avatarUrl
    if (row.focus) person.focus = row.focus
    if (row.activity) person.activity = row.activity
    byIdentity.set(key, person)
  }
  return [...byIdentity.values()]
}

/** The host a roster person is best reached on: where they have something open, else the first. */
export function primaryPresence(person: RosterPerson): HostPerson {
  return person.presences.find((presence) => canJumpTo(presence)) ?? person.presences[0]!
}

/**
 * Where a person is, in words: the session by name, or that they are
 * idle. The host's own description of a session names it first and says what
 * its agent is doing; this client's tabs and sidebar name it only when the host
 * could not (an unindexed session), so "In Fix login, agent running" reads the
 * same on a client that never opened Fix login.
 */
export function focusLabel(
  focus: PresenceFocus | undefined,
  names: { sessionLabel: (sessionId: string) => string | null },
  activity?: SessionActivity,
): string {
  if (!focus || focus.kind === 'none') return 'Not in a session'
  const title = (activity?.sessionId === focus.sessionId ? activity.title : null) ?? names.sessionLabel(focus.sessionId) ?? 'a session'
  const doing = activityWords(activity?.sessionId === focus.sessionId ? activity : undefined)
  return doing ? `In ${title}, ${doing}` : `In ${title}`
}

/** What a roster can name things with: the mounted sessions, the sidebar's rows. */
export interface RosterNames {
  mountedSessions: Iterable<Session>
  sidebarSessions: Iterable<{ sessionId?: string | null; serverId?: string | null; label: string }>
}

/** A session's name as this client knows it: a mounted tab first, then the sidebar's rows. */
export function sessionLabelIn(names: RosterNames, serverId: string, sessionId: string): string | null {
  for (const current of names.mountedSessions) {
    if (current.id === sessionId && current.run.serverId === serverId) return sessionTitle(current)
  }
  for (const row of names.sidebarSessions) {
    if (row.sessionId === sessionId && row.serverId === serverId) return row.label
  }
  return null
}

/** Where a roster row's person is, in words. */
export function whereIs(person: HostPerson, names: RosterNames): string {
  return focusLabel(person.focus, {
    sessionLabel: (sessionId) => sessionLabelIn(names, person.serverId, sessionId),
  }, person.activity)
}

/**
 * Where a person is across hosts: their best presence in words, and the host's
 * name when the roster spans several, so "In Fix login · Cloud" says which machine.
 */
export function rosterWhere(person: RosterPerson, names: RosterNames, spansHosts: boolean, hostLabel: (serverId: string) => string | undefined): string {
  const presence = primaryPresence(person)
  const where = whereIs(presence, names)
  const host = spansHosts ? hostLabel(presence.serverId) : undefined
  return host ? `${where} · ${host}` : where
}

export function canJumpTo(person: HostPerson): boolean {
  return !!person.focus && person.focus.kind !== 'none'
}
