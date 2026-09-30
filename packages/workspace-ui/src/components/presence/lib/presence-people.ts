import type { HostParticipant, HostPresenceSnapshot, PresenceFocus, PresenceParticipant, SessionActivity, SessionParticipant } from '@solus/contracts/presence'
import { sameUser, userKey, type User, type UserId } from '@solus/contracts/user'

/**
 * The view model of every presence surface (docs/plans/multiplayer-presence.md
 * §3). A participant is a client; a person is a user. The same person on a
 * laptop and a phone is one avatar with two devices behind it, and the person
 * reading the screen is never in their own stack.
 */

export interface PresencePerson {
  /** The person as `UserAvatar` draws them. */
  user: User
  userId: string
  displayName: string
  /** Any of this person's clients is typing in the session the stack is for. */
  isComposing: boolean
  /** Any of this person's clients is editing the work it has focused. */
  isEditing: boolean
  /** How many of this person's clients are in the room. */
  deviceCount: number
  /** What the person has focused, when the stack is host-wide; the first client's answer. */
  focus?: PresenceFocus
  /** The focused session as the host describes it, when the focus is a session the host knows. */
  activity?: SessionActivity
  clientIds: string[]
}

type AnyParticipant = PresenceParticipant & Partial<Pick<SessionParticipant, 'isComposing'>> & Partial<Pick<HostParticipant, 'focus' | 'activity' | 'isEditing'>>

/** How a host's participants are read: who the reader is there (plans/012 §1); null until the host has said. */
export interface PeopleOptions {
  self: UserId | null
}

/** One user as a presence stack counts them: one face for all their clients. */
export function personOf(user: User): PresencePerson {
  return {
    user,
    userId: userKey(user.id),
    displayName: user.displayName,
    isComposing: false,
    isEditing: false,
    deviceCount: 1,
    clientIds: [],
  }
}

/** Group clients into people, oldest arrival first, leaving the reader out. */
export function peopleFrom(participants: readonly AnyParticipant[], options: PeopleOptions): PresencePerson[] {
  const byUser = new Map<string, PresencePerson>()
  for (const participant of [...participants].sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (options.self && sameUser(participant.user.id, options.self)) continue
    const key = userKey(participant.user.id)
    const existing = byUser.get(key)
    if (existing) {
      existing.deviceCount += 1
      existing.clientIds.push(participant.clientId)
      if (participant.isComposing) existing.isComposing = true
      if (participant.isEditing) existing.isEditing = true
      continue
    }
    const person = personOf(participant.user)
    person.isComposing = participant.isComposing === true
    person.isEditing = participant.isEditing === true
    person.clientIds.push(participant.clientId)
    if (participant.focus) person.focus = participant.focus
    if (participant.activity) person.activity = participant.activity
    byUser.set(key, person)
  }
  return [...byUser.values()]
}

/** The people whose focused pane shows one session. */
export function peopleFocusedOn(people: readonly PresencePerson[], focus: PresenceFocus): PresencePerson[] {
  return people.filter((person) => person.focus && sameFocus(person.focus, focus))
}

/**
 * Whose prompt runs in the session these people have focused, from the host's
 * description of it; null when nothing runs or nobody here carries the answer.
 * Every person focused on one session carries the same description.
 */
export function activeTurnAuthorOf(people: readonly PresencePerson[]): string | null {
  for (const person of people) {
    if (person.activity) return person.activity.activeTurn ? userKey(person.activity.activeTurn.author.id) : null
  }
  return null
}

/** The state of a session in words, after its name: "agent running", "waiting for input"; nothing when it rests. */
export function activityWords(activity: SessionActivity | undefined): string | null {
  if (activity?.state === 'running') return 'agent running'
  if (activity?.state === 'waiting') return 'waiting for input'
  return null
}

export function sameFocus(a: PresenceFocus, b: PresenceFocus): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  if (a.kind === 'work' && b.kind === 'work') return a.workId === b.workId
  return true
}

/**
 * The people on a host who were not there a moment ago: the join notice. Nothing
 * is new on the first snapshot, and nothing until the reader knows who they are,
 * because until then their own second device would be announced as a stranger.
 */
export function newArrivals(previous: HostPresenceSnapshot | undefined, next: HostPresenceSnapshot, options: PeopleOptions): PresencePerson[] {
  if (!previous || !options.self) return []
  const before = new Set(previous.participants.map((participant) => userKey(participant.user.id)))
  return peopleFrom(next.participants, options).filter((person) => !before.has(person.userId))
}

/** What a client shows, as it reports it to the host: the host and the focus there. */
export interface FocusReport {
  serverId: string | null
  focus: PresenceFocus
}

/** What following a person asks of the client on this pass. */
export type FollowStep =
  /** They have nothing open yet; keep waiting where we are. */
  | { kind: 'wait' }
  /** They moved: go where they are. */
  | { kind: 'open'; focus: PresenceFocus }
  /** We are with them; nothing to do. */
  | { kind: 'hold' }
  /** Following ends: they left the host, or the reader went somewhere else on their own. */
  | { kind: 'stop'; reason: 'left' | 'navigated' }

/**
 * Follow mode is a chain of jumps: each time the followed person's focus
 * changes, the client opens it once. A reader who then opens something else
 * has chosen for themselves, and that ends the follow — it is a tether, not a lock.
 */
export function followStep(input: {
  person: PresencePerson | null
  /** The focus this client last opened for them; null right after following began. */
  lastOpened: PresenceFocus | null
  /** What this client shows: the host and focus it reports to the room. */
  mine: FocusReport
  serverId: string
}): FollowStep {
  if (!input.person) return { kind: 'stop', reason: 'left' }
  const target = input.person.focus
  if (!target || target.kind === 'none') return { kind: 'wait' }
  if (!input.lastOpened || !sameFocus(input.lastOpened, target)) return { kind: 'open', focus: target }
  if (input.mine.serverId !== input.serverId || !sameFocus(input.mine.focus, target)) return { kind: 'stop', reason: 'navigated' }
  return { kind: 'hold' }
}

/** "Alice is typing…", "Alice and Bob are typing…", "3 people are typing…"; null when nobody is. */
export function composingLabel(people: readonly PresencePerson[]): string | null {
  const names = people.filter((person) => person.isComposing).map((person) => person.displayName)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names.length} people are typing…`
}

/** The stack shows a few faces and counts the rest. */
export interface StackedPeople<T extends PresencePerson = PresencePerson> {
  shown: T[]
  overflow: number
}

export function stackPeople<T extends PresencePerson>(people: readonly T[], max: number): StackedPeople<T> {
  if (people.length <= max) return { shown: [...people], overflow: 0 }
  return { shown: people.slice(0, max), overflow: people.length - max }
}
