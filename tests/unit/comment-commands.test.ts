/// <reference types="bun-types" />
/**
 * The reducer behind every comment change on a shared work
 * (docs/plans/multiplayer-comments.md §3). If it lets a member rewrite someone
 * else's thread, forgets to name who wrote one, or shares one person's read
 * mark with everyone, the rail lies about who said what and who has seen it.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import type { TurnAuthor } from '@solus/contracts/presence'
import {
  applyCommentCommand,
  CommentCommandError,
  mayChangeThread,
  workCommentCommandSchema,
  type CommentActor,
} from '@solus/contracts/comment-commands'

const ALICE: TurnAuthor = { userId: 'alice', displayName: 'Alice', colorIndex: 1 }
const BOB: TurnAuthor = { userId: 'bob', displayName: 'Bob', colorIndex: 2 }

const actor = (person: TurnAuthor | null, canModerate = false, now = 1000): CommentActor => ({ person, canModerate, now })

const thread = (extra: Partial<PlanComment> = {}): PlanComment => ({
  id: 'c1',
  selectedText: 'Pin 1',
  comment: 'Tighten this',
  author: 'you',
  createdAt: 500,
  ...extra,
})

describe('adding a thread', () => {
  test('the host names the person and starts their read mark; the client cannot say who it is', () => {
    const [created] = applyCommentCommand([], { kind: 'add', comment: { id: 'c1', selectedText: 'Pin 1', comment: 'Tighten this', pin: { x: 0.25, y: 0.5 } } }, actor(ALICE))
    expect(created).toMatchObject({ id: 'c1', author: 'you', person: ALICE, createdAt: 1000, pin: { x: 0.25, y: 0.5 } })
    expect(created!.readBy).toEqual([{ userId: 'alice', readAt: 1000 }])
    expect(created!.readAt).toBeUndefined()
  })

  test('the host’s own work carries no name and keeps the single-reader mark', () => {
    const [created] = applyCommentCommand([], { kind: 'add', comment: { id: 'c1', selectedText: 'x', comment: 'note' } }, actor(null))
    expect(created!.person).toBeUndefined()
    expect(created!.readAt).toBe(1000)
  })

  test('a second add with the same id is a conflict, not a silent overwrite', () => {
    expect(() => applyCommentCommand([thread()], { kind: 'add', comment: { id: 'c1', selectedText: 'x', comment: 'again' } }, actor(ALICE))).toThrow(CommentCommandError)
  })

  test('the wire schema rejects a client that tries to stamp author or person itself', () => {
    const parsed = workCommentCommandSchema.safeParse({ kind: 'add', comment: { id: 'c1', selectedText: 'x', comment: 'note', person: BOB } })
    // Zod strips unknown keys: whatever the client claimed about who wrote it is gone.
    expect(parsed.success && parsed.data.kind === 'add' && 'person' in parsed.data.comment).toBe(false)
    expect(workCommentCommandSchema.safeParse({ kind: 'add', comment: { id: 'c1', selectedText: 'x', comment: 'note', pin: { x: 2, y: 0 } } }).success).toBe(false)
  })
})

describe('changing a thread', () => {
  const alices = thread({ person: ALICE })

  test('the author edits and deletes their own thread; another member may not', () => {
    expect(applyCommentCommand([alices], { kind: 'edit', commentId: 'c1', text: 'Loosen this' }, actor(ALICE))[0]!.comment).toBe('Loosen this')
    expect(() => applyCommentCommand([alices], { kind: 'edit', commentId: 'c1', text: 'Mine now' }, actor(BOB))).toThrow(/edit/)
    expect(() => applyCommentCommand([alices], { kind: 'delete', commentId: 'c1' }, actor(BOB))).toThrow(/delete/)
    expect(applyCommentCommand([alices], { kind: 'delete', commentId: 'c1' }, actor(ALICE))).toEqual([])
  })

  test('a moderator — the work’s owner or a host admin — may tidy anyone’s thread', () => {
    expect(applyCommentCommand([alices], { kind: 'delete', commentId: 'c1' }, actor(BOB, true))).toEqual([])
  })

  test('an agent’s note belongs to nobody in particular, so any editor may tidy it', () => {
    const agents = thread({ author: 'solus' })
    expect(mayChangeThread(agents, actor(BOB))).toBe(true)
  })

  test('a thread written before works had people is the moderator’s, not every member’s', () => {
    expect(mayChangeThread(thread(), actor(BOB))).toBe(false)
    expect(mayChangeThread(thread(), actor(BOB, true))).toBe(true)
  })

  test('a reply and a resolve are any editor’s, and both carry who did them', () => {
    const replied = applyCommentCommand([alices], { kind: 'reply', commentId: 'c1', reply: { id: 'r1', text: 'Agreed' } }, actor(BOB))
    expect(replied[0]!.replies).toEqual([{ id: 'r1', author: 'you', person: BOB, text: 'Agreed', createdAt: 1000 }])
    // Answering is reading: Bob's own mark moves to now, so his reply is not unread to him.
    expect(replied[0]!.readBy).toEqual([{ userId: 'bob', readAt: 1000 }])
    const settled = applyCommentCommand(replied, { kind: 'resolve', commentId: 'c1', resolved: true }, actor(BOB))
    expect(settled[0]).toMatchObject({ resolvedAt: 1000, resolvedBy: 'you', resolvedByPerson: BOB })
    const reopened = applyCommentCommand(settled, { kind: 'resolve', commentId: 'c1', resolved: false }, actor(ALICE))
    expect(reopened[0]!.resolvedAt).toBeUndefined()
    expect(reopened[0]!.resolvedByPerson).toBeUndefined()
  })

  test('a missing thread is not found', () => {
    expect(() => applyCommentCommand([], { kind: 'reply', commentId: 'nope', reply: { id: 'r', text: 'x' } }, actor(ALICE))).toThrow(/No thread/)
  })
})

describe('read marks', () => {
  test('are per person: Bob reading does not mark the thread read for Alice, and his second read replaces his first', () => {
    let threads = applyCommentCommand([thread({ person: ALICE, readBy: [{ userId: 'alice', readAt: 500 }] })], { kind: 'read', commentId: 'c1' }, actor(BOB, false, 700))
    threads = applyCommentCommand(threads, { kind: 'read', commentId: 'c1' }, actor(BOB, false, 900))
    expect(threads[0]!.readBy).toEqual([{ userId: 'alice', readAt: 500 }, { userId: 'bob', readAt: 900 }])
  })
})

describe('resolving every open thread', () => {
  test('settles the open ones and returns the settled ones as the same objects', () => {
    const open = thread({ id: 'a' })
    const settled = thread({ id: 'b', resolvedAt: 1 })
    const next = applyCommentCommand([open, settled], { kind: 'resolve-open' }, actor(ALICE))
    expect(next[0]).toMatchObject({ id: 'a', resolvedAt: 1000, resolvedByPerson: ALICE })
    expect(next[1]).toBe(settled)
  })
})
