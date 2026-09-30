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
import type { Attribution, User } from '@solus/contracts/user'
import {
  authorLabel,
  canChangeThread,
  isOwnMessage,
  isUnread,
  messageUser,
  showsAuthor,
  SINGLE_READER,
  type CommentReader,
} from '@solus/workspace-ui/components/comments/lib/thread'

const ALICE: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Ng' }
const BOB: User = { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' }
const by = (user: User): Attribution => ({ kind: 'user', user })
const AGENT: Attribution = { kind: 'agent', sessionId: 's', provider: 'claude-code', title: 'refactor-auth', for: ALICE }

const readerOf = (user: User | null): CommentReader => ({ userId: user?.id ?? null, isSingleReader: false })

const thread = (extra: Partial<PlanComment> = {}): PlanComment => ({ id: 'c1', selectedText: 'x', comment: 'note', createdAt: 100, ...extra })

describe('who wrote it', () => {
  test('the reader’s own thread carries no byline; a teammate’s carries them as a user', () => {
    expect(messageUser(thread({ author: by(ALICE) }), readerOf(ALICE))).toBeNull()
    expect(authorLabel(thread({ author: by(ALICE) }), readerOf(ALICE))).toBe('You')
    expect(messageUser(thread({ author: by(ALICE) }), readerOf(BOB))).toEqual(ALICE)
    expect(authorLabel(thread({ author: by(ALICE) }), readerOf(BOB))).toBe('Alice Ng')
  })

  test('the reader is told apart by user id, not by name', () => {
    const renamed = { ...ALICE, displayName: 'Alice Smith' }
    const guestNamedAlice: User = { id: { kind: 'guest', guestId: 'alice' }, displayName: 'Alice Ng' }
    expect(isOwnMessage(thread({ author: by(renamed) }), readerOf(ALICE))).toBe(true)
    expect(isOwnMessage(thread({ author: by(guestNamedAlice) }), readerOf(ALICE))).toBe(false)
  })

  test('a reader who does not yet know who they are still sees a named thread’s name', () => {
    expect(authorLabel(thread({ author: by(ALICE) }), readerOf(null))).toBe('Alice Ng')
  })

  test('a message the host has not stamped yet is the reader’s own; a plan’s people are its one reader; an agent’s names the agent', () => {
    expect(isOwnMessage(thread(), readerOf(BOB))).toBe(true)
    expect(authorLabel(thread(), readerOf(BOB))).toBe('You')
    expect(authorLabel(thread({ author: by(ALICE) }), SINGLE_READER)).toBe('You')
    expect(authorLabel(thread({ author: AGENT }), readerOf(BOB))).toBe('refactor-auth')
    expect(messageUser(thread({ author: AGENT }), readerOf(BOB))).toBeNull()
  })

  test('a reply repeats no name for the same person twice in a row, but two people alternate', () => {
    const replies = [
      { id: 'r1', author: by(ALICE), text: 'a', createdAt: 1 },
      { id: 'r2', author: by({ ...ALICE, displayName: 'Alice' }), text: 'b', createdAt: 2 },
      { id: 'r3', author: by(BOB), text: 'c', createdAt: 3 },
      { id: 'r4', author: AGENT, text: 'd', createdAt: 4 },
    ]
    expect(showsAuthor(replies, 1)).toBe(false)
    expect(showsAuthor(replies, 2)).toBe(true)
    expect(showsAuthor(replies, 3)).toBe(true)
  })
})

describe('the verbs', () => {
  test('Edit and Delete are offered on the reader’s own thread, on an agent’s, and to a moderator; not on a teammate’s or on Solus’s own', () => {
    expect(canChangeThread(thread({ author: by(ALICE) }), { ...readerOf(ALICE), canModerate: false })).toBe(true)
    expect(canChangeThread(thread({ author: by(ALICE) }), { ...readerOf(BOB), canModerate: false })).toBe(false)
    expect(canChangeThread(thread({ author: by(ALICE) }), { ...readerOf(BOB), canModerate: true })).toBe(true)
    expect(canChangeThread(thread({ author: AGENT }), { ...readerOf(BOB), canModerate: false })).toBe(true)
    expect(canChangeThread(thread({ author: { kind: 'system' } }), { ...readerOf(BOB), canModerate: false })).toBe(false)
  })
})

describe('unread', () => {
  test('a teammate’s reply after the reader’s own read mark is unread; the reader’s own words never are', () => {
    // The host marks the thread read for whoever replies, so Alice's mark is her reply's time.
    const answered = thread({ author: by(BOB), readBy: [{ userId: 'bob', readAt: 150 }, { userId: 'alice', readAt: 200 }], replies: [{ id: 'r', author: by(ALICE), text: 'hi', createdAt: 200 }] })
    expect(isUnread(answered, readerOf(BOB))).toBe(true)
    expect(isUnread(answered, readerOf(ALICE))).toBe(false)
  })

  test('one person’s read mark does not read the thread for another', () => {
    const c = thread({ author: by(ALICE), createdAt: 100, readBy: [{ userId: 'alice', readAt: 100 }] })
    expect(isUnread(c, readerOf(BOB))).toBe(true)
    expect(isUnread(thread({ author: by(ALICE), readBy: [{ userId: 'bob', readAt: 150 }] }), readerOf(BOB))).toBe(false)
  })

  test('the single-reader mark a plan keeps still works, and a reader who does not know who they are counts only the agent', () => {
    expect(isUnread(thread({ author: AGENT, createdAt: 100, readAt: 50 }))).toBe(true)
    expect(isUnread(thread({ author: AGENT, createdAt: 100, readAt: 150 }))).toBe(false)
    expect(isUnread(thread({ author: by(ALICE) }), readerOf(null))).toBe(false)
    expect(isUnread(thread({ author: by(ALICE) }), SINGLE_READER)).toBe(false)
  })
})
