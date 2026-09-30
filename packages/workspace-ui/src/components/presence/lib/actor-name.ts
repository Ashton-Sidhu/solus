import type { PermissionDecision, RateLimitDecisionAction } from '@solus/contracts/types'
import { attributionLabel, sameUser, type Attribution, type User, type UserId } from '@solus/contracts/user'
import { firstName } from '../../users/lib/users'

/**
 * How a label names the person who acted (plan 004 D2): "you" only when it is
 * the reader (`sameUser` with the one id the host gave them), their name
 * otherwise, and nothing when the host did not say who it was — never a guess.
 */
export function actorName(by: User | undefined, self: UserId | null): string | null {
  if (!by) return null
  return self && sameUser(by.id, self) ? 'you' : by.displayName
}

/**
 * How a label names who did something (plans/012 §2): a person as `actorName`
 * names them ("you" for the reader); an agent or an automation as the one that
 * worked for a person ("Solus agent" for the reader's own, "Alice's agent"), else by its own name;
 * an upstream system and Solus by name. Lower case, as `actorName` is: a
 * sentence capitalises its own start.
 */
export function attributionName(by: Attribution, self: UserId | null): string {
  switch (by.kind) {
    case 'user': return actorName(by.user, self) ?? by.user.displayName
    // The reader's own agent is Solus's agent; a teammate's keeps their name.
    case 'agent': return by.for ? (self && sameUser(by.for.id, self) ? 'Solus agent' : `${possessive(by.for, self)} agent`) : by.title ?? 'an agent'
    case 'automation': return by.for ? `${possessive(by.for, self)} automation` : by.name ?? 'an automation'
    case 'upstream':
    case 'system': return attributionLabel(by)
  }
}

function possessive(user: User, self: UserId | null): string {
  return self && sameUser(user.id, self) ? 'your' : `${firstName(user.displayName)}'s`
}

/**
 * The person, only when they are someone other than the reader. Null for the
 * reader, for a reader the host has not yet identified, and when the host named
 * no one: a session where only the reader acts stays quiet, and a missing name is
 * never read as "you".
 */
export function otherPerson(by: User | null | undefined, self: UserId | null): User | null {
  if (!by || !self || sameUser(by.id, self)) return null
  return by
}

/** A session waiting on a person: "Needs you", or "Needs Alice" when it is her turn. */
export function needsLabel(turnAuthor: User | null | undefined, self: UserId | null): string {
  const other = otherPerson(turnAuthor, self)
  return other ? `Needs ${firstName(other.displayName)}` : 'Needs you'
}

/** The question card's chip: whom the turn waits on. */
export function waitingOnLabel(turnAuthor: User | null | undefined, self: UserId | null): string {
  const other = otherPerson(turnAuthor, self)
  return other ? `Waiting on ${firstName(other.displayName)}` : 'Waiting on you'
}

/** The question card's title, addressed to the turn's author. */
export function callTitle(serverName: string | undefined, turnAuthor: User | null | undefined, self: UserId | null): string {
  const other = otherPerson(turnAuthor, self)
  const call = other ? `${firstName(other.displayName)}'s call` : 'your call'
  return serverName ? `${serverName} needs ${call}` : `Needs ${call}`
}

/** "Alice's turn", when the turn is someone else's; null otherwise. */
export function othersTurnLabel(turnAuthor: User | null | undefined, self: UserId | null): string | null {
  const other = otherPerson(turnAuthor, self)
  return other ? `${firstName(other.displayName)}'s turn` : null
}

/**
 * The composer while a turn runs. A steer joins the running turn and runs on its
 * author's seat (D3), so a teammate's turn is named; the reader's own is not.
 */
export function steerPlaceholder(turnOwner: User | null, hasKeyboard: boolean): string {
  const turn = turnOwner ? `${firstName(turnOwner.displayName)}'s turn` : null
  if (hasKeyboard) return turn ? `Enter to steer ${turn} · ⌥Enter to queue next` : 'Enter to steer now · ⌥Enter to queue next'
  return turn ? `Send to steer ${turn}...` : 'Send to steer this response...'
}

/** The verb phrase after a person's name on a permission they decided. */
export function permissionDecisionNotice(decision: PermissionDecision, subject: string): string {
  if (decision === 'denied') return `denied ${subject}`
  if (decision === 'approved_for_session') return `approved ${subject} for this session`
  return `approved ${subject}`
}

/** The verb phrase after a person's name on a rate-limit decision. */
export function rateLimitDecisionNotice(action: RateLimitDecisionAction): string {
  if (action === 'send_now') return 'sent the held prompt now'
  if (action === 'stop') return 'stopped and discarded the held prompt'
  return 'queued the prompt until the limit resets'
}

/** Whose held prompt it was, from the reader's side: "your", "Alice's", or "a". */
export function heldPromptOwner(author: User | undefined, self: UserId | null): string {
  const name = actorName(author, self)
  if (!name) return 'a'
  return name === 'you' ? 'your' : `${firstName(name)}'s`
}

/** The rate-limit card's title: whose seat reached the limit, when it is not the reader's. */
export function limitTitle(windowLabel: string, turnAuthor: User | null | undefined, self: UserId | null): string {
  const other = otherPerson(turnAuthor, self)
  const limit = `the ${windowLabel || 'usage'} limit`
  return other ? `${firstName(other.displayName)}'s seat reached ${limit}` : `Reached ${limit}`
}
