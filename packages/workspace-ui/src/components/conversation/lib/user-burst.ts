import type { Message } from '@solus/contracts/types'
import { sameUser } from '@solus/contracts/user'
import { hostNoticeKind } from './host-notice'
import type { Turn } from './turns'

/**
 * Back-to-back messages from one person read as one burst: tight spacing, and
 * their name once. A render-level answer read from a turn and its neighbour,
 * so a second message that arrives live re-asks two rows, not the transcript.
 */
export interface UserBurst {
  /** The next row continues this one's burst: the gap below closes. */
  groupedWithNext: boolean
  /** This row continues the burst above: the gap above closes, the name hides. */
  continuesBurst: boolean
}

export const NO_BURST: UserBurst = { groupedWithNext: false, continuesBurst: false }

/** A message a person typed. An automation's prompt and a host notice are not. */
function personMessage(turn: Turn | undefined): Message | null {
  const lead = turn?.lead
  if (lead?.kind !== 'user') return null
  if (lead.message.via === 'automation' || hostNoticeKind(lead.message)) return null
  return lead.message
}

/** The turn is its prompt and nothing else: no reply, work, images, or ending between it and the next. */
function isBare(turn: Turn): boolean {
  return turn.body.length === 0 && turn.tail.length === 0 && turn.images.length === 0 && turn.end === null
}

/** Two messages share a burst when one person sent both. An unstamped author matches only another. */
function sameAuthor(a: Message, b: Message): boolean {
  if (!a.author || !b.author) return !a.author && !b.author
  return sameUser(a.author.id, b.author.id)
}

function joins(previous: Turn | undefined, next: Turn | undefined): boolean {
  if (!previous || !isBare(previous)) return false
  const before = personMessage(previous)
  const after = personMessage(next)
  return !!before && !!after && sameAuthor(before, after)
}

export function userBurstAt(turns: readonly Turn[], index: number): UserBurst {
  const groupedWithNext = joins(turns[index], turns[index + 1])
  const continuesBurst = joins(turns[index - 1], turns[index])
  return groupedWithNext || continuesBurst ? { groupedWithNext, continuesBurst } : NO_BURST
}
