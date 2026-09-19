import type { HostParticipant, HostPresenceSnapshot, PresenceFocus, PresenceParticipant, SessionActivity, SessionParticipant } from '@solus/contracts/presence'
import { PRESENCE_COLOR_COUNT } from '@solus/contracts/presence'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { initialsFor } from '../../ui/list-page/list-page'

/**
 * The view model of every presence surface (docs/plans/multiplayer-presence.md
 * §3). A participant is a client; a person is a user. The same person on a
 * laptop and a phone is one avatar with two devices behind it, and the person
 * reading the screen is never in their own stack.
 */

export interface PresencePerson {
  userId: string
  displayName: string
  initials: string
  avatarUrl?: string
  colorIndex: number
  /** Any of this person's clients has a draft in the session the stack is for. */
  isComposing: boolean
  /** How many of this person's clients are in the room. */
  deviceCount: number
  /** What the person has focused, when the stack is host-wide; the first client's answer. */
  focus?: PresenceFocus
  /** The focused session as the host describes it, when the focus is a session the host knows. */
  activity?: SessionActivity
  clientIds: string[]
}

type AnyParticipant = PresenceParticipant & Partial<Pick<SessionParticipant, 'isComposing'>> & Partial<Pick<HostParticipant, 'focus' | 'activity'>>

/**
 * Who the reader is on a host: every user id that is theirs there. The host names
 * a client by the principal it admitted — `host-owner` on a local or owner
 * connection, the account id on a member connection — so the same person can
 * carry two ids on one host, and the account id is one of them on every host.
 * Empty while the reader does not know who they are.
 */
export type SelfIds = readonly string[]

/**
 * How a host's participants are read: who the reader is there, and what the
 * personal host's owner is called. The host says `Host owner` for its owner
 * because a local connection knows no account; the client knows the account
 * from the directory and names the person instead.
 */
export interface PeopleOptions {
  self: SelfIds
  hostOwnerName?: string
}

/** Group clients into people, oldest arrival first, leaving the reader out. */
export function peopleFrom(participants: readonly AnyParticipant[], options: PeopleOptions): PresencePerson[] {
  const self = new Set(options.self)
  const byUser = new Map<string, PresencePerson>()
  for (const participant of [...participants].sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (self.has(participant.userId)) continue
    const existing = byUser.get(participant.userId)
    if (existing) {
      existing.deviceCount += 1
      existing.clientIds.push(participant.clientId)
      if (participant.isComposing) existing.isComposing = true
      continue
    }
    const displayName = participant.userId === HOST_OWNER_USER_ID && options.hostOwnerName ? options.hostOwnerName : participant.displayName
    const person: PresencePerson = {
      userId: participant.userId,
      displayName,
      initials: initialsFor(displayName),
      colorIndex: participant.colorIndex,
      isComposing: participant.isComposing === true,
      deviceCount: 1,
      clientIds: [participant.clientId],
    }
    if (participant.avatarUrl) person.avatarUrl = participant.avatarUrl
    if (participant.focus) person.focus = participant.focus
    if (participant.activity) person.activity = participant.activity
    byUser.set(participant.userId, person)
  }
  return [...byUser.values()]
}

/** The people whose focused pane shows one session or work. */
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
    if (person.activity) return person.activity.activeTurn?.authorUserId ?? null
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
  if (!previous || options.self.length === 0) return []
  const before = new Set(previous.participants.map((participant) => participant.userId))
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

/**
 * The palette: eight hues at one lightness and chroma, spaced so neighbours are
 * telling-apart distinct, and mixed against the foreground for text so each
 * reads on paper and on ink alike. A person's index comes from the host.
 */
const PRESENCE_HUES = [25, 70, 120, 165, 205, 250, 295, 340] as const

export interface PresenceTint {
  /** The person's colour itself, for rings and dots. */
  color: string
  /** A wash of it, for an avatar's fill behind initials. */
  fill: string
  /** Initials over the wash. */
  ink: string
}

export function presenceTint(colorIndex: number): PresenceTint {
  const hue = PRESENCE_HUES[((colorIndex % PRESENCE_COLOR_COUNT) + PRESENCE_COLOR_COUNT) % PRESENCE_COLOR_COUNT]
  const color = `oklch(0.66 0.15 ${hue})`
  return {
    color,
    fill: `color-mix(in oklch, ${color} 26%, transparent)`,
    ink: `color-mix(in oklch, ${color} 70%, var(--foreground))`,
  }
}
