/// <reference types="bun-types" />
/**
 * How a thread card reads people (docs/plans/multiplayer-comments.md §4). A
 * byline on the reader's own thread makes a one-person document read as a
 * meeting; a missing one on a teammate's makes their note look like the
 * reader's. Unread must mean "someone else spoke", never "you spoke".
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import type { TurnAuthor } from '@solus/contracts/presence'
import {
  authorLabel,
  canChangeThread,
  isOwnMessage,
  isUnread,
  messagePerson,
  showsAuthor,
} from '@solus/workspace-ui/components/comments/lib/thread'

const ALICE: TurnAuthor = { userId: 'alice', displayName: 'Alice Ng', colorIndex: 3 }
const BOB: TurnAuthor = { userId: 'bob', displayName: 'Bob', colorIndex: 4 }

const thread = (extra: Partial<PlanComment> = {}): PlanComment => ({ id: 'c1', selectedText: 'x', comment: 'note', createdAt: 100, ...extra })

describe('who wrote it', () => {
  test('the reader’s own thread carries no byline; a teammate’s carries their name and colour', () => {
    expect(messagePerson(thread({ person: ALICE }), ['alice'])).toBeNull()
    expect(authorLabel(thread({ person: ALICE }), ['alice'])).toBe('You')
    expect(messagePerson(thread({ person: ALICE }), ['bob'])).toMatchObject({ userId: 'alice', displayName: 'Alice Ng', initials: 'AN', colorIndex: 3 })
    expect(authorLabel(thread({ person: ALICE }), ['bob'])).toBe('Alice Ng')
  })

  test('a reader who does not yet know their own ids still sees a named thread’s name', () => {
    expect(authorLabel(thread({ person: ALICE }), [])).toBe('Alice Ng')
  })

  test('a thread from before works had people is the reader’s, and an agent’s names the agent', () => {
    expect(isOwnMessage(thread(), ['bob'])).toBe(true)
    expect(authorLabel(thread(), ['bob'])).toBe('You')
    expect(authorLabel(thread({ author: 'solus', authorAgent: { sessionId: 's', provider: 'claude-code', title: 'refactor-auth' } }), ['bob'])).toBe('refactor-auth')
  })

  test('a reply repeats no name for the same person twice in a row, but two people alternate', () => {
    const replies = [
      { id: 'r1', author: 'you' as const, person: ALICE, text: 'a', createdAt: 1 },
      { id: 'r2', author: 'you' as const, person: ALICE, text: 'b', createdAt: 2 },
      { id: 'r3', author: 'you' as const, person: BOB, text: 'c', createdAt: 3 },
    ]
    expect(showsAuthor(replies, 1)).toBe(false)
    expect(showsAuthor(replies, 2)).toBe(true)
  })
})

describe('the verbs', () => {
  test('Edit and Delete are offered on the reader’s own thread, on an agent’s, and to a moderator; not on a teammate’s', () => {
    expect(canChangeThread(thread({ person: ALICE }), { selfUserIds: ['alice'], canModerate: false })).toBe(true)
    expect(canChangeThread(thread({ person: ALICE }), { selfUserIds: ['bob'], canModerate: false })).toBe(false)
    expect(canChangeThread(thread({ person: ALICE }), { selfUserIds: ['bob'], canModerate: true })).toBe(true)
    expect(canChangeThread(thread({ author: 'solus' }), { selfUserIds: ['bob'], canModerate: false })).toBe(true)
  })
})

describe('unread', () => {
  test('a teammate’s reply after the reader’s own read mark is unread; the reader’s own words never are', () => {
    // The host marks the thread read for whoever replies, so Alice's mark is her reply's time.
    const answered = thread({ person: BOB, readBy: [{ userId: 'bob', readAt: 150 }, { userId: 'alice', readAt: 200 }], replies: [{ id: 'r', author: 'you', person: ALICE, text: 'hi', createdAt: 200 }] })
    expect(isUnread(answered, ['bob'])).toBe(true)
    expect(isUnread(answered, ['alice'])).toBe(false)
  })

  test('one person’s read mark does not read the thread for another', () => {
    const c = thread({ person: ALICE, createdAt: 100, readBy: [{ userId: 'alice', readAt: 100 }] })
    expect(isUnread(c, ['bob'])).toBe(true)
    expect(isUnread(thread({ person: ALICE, readBy: [{ userId: 'bob', readAt: 150 }] }), ['bob'])).toBe(false)
  })

  test('the single-reader mark a plan keeps still works, and a reader with no ids counts only the agent', () => {
    expect(isUnread(thread({ author: 'solus', createdAt: 100, readAt: 50 }))).toBe(true)
    expect(isUnread(thread({ author: 'solus', createdAt: 100, readAt: 150 }))).toBe(false)
    expect(isUnread(thread({ person: ALICE }), [])).toBe(false)
  })
})
