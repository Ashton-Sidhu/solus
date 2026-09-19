/// <reference types="bun-types" />
/**
 * The store's thread list is a `$state` array that every card in a rail reads
 * from. If reconciling the host's answer rebuilt it, one person's reply would
 * invalidate every other thread's card; if it missed a change, the rail would
 * disagree with the host.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import { reconcileComments } from '@solus/workspace-ui/contexts/works/comment-sync'

const thread = (id: string, extra: Partial<PlanComment> = {}): PlanComment => ({ id, selectedText: id, comment: `note ${id}`, ...extra })

describe('reconcileComments', () => {
  test('keeps an untouched thread as the same object and updates a changed one in place', () => {
    const a = thread('a')
    const b = thread('b')
    const target = [a, b]
    reconcileComments(target, [thread('a'), thread('b', { comment: 'edited', resolvedAt: 5 })])
    expect(target[0]).toBe(a)
    expect(target[1]).toBe(b)
    expect(b.comment).toBe('edited')
    expect(b.resolvedAt).toBe(5)
  })

  test('removes what the host no longer has, inserts what is new, and follows the host’s order', () => {
    const a = thread('a')
    const b = thread('b')
    const target = [a, b]
    reconcileComments(target, [thread('c'), thread('b')])
    expect(target.map((c) => c.id)).toEqual(['c', 'b'])
    expect(target[1]).toBe(b)
  })

  test('drops a field the host cleared, so a reopened thread loses its resolved marks', () => {
    const a = thread('a', { resolvedAt: 5, resolvedBy: 'you' })
    const target = [a]
    reconcileComments(target, [thread('a')])
    expect(a.resolvedAt).toBeUndefined()
    expect(a.resolvedBy).toBeUndefined()
  })

  test('replaces the replies array only when a reply changed', () => {
    const replies = [{ id: 'r', author: 'you' as const, text: 'hi', createdAt: 1 }]
    const a = thread('a', { replies })
    reconcileComments([a], [thread('a', { replies: [{ id: 'r', author: 'you', text: 'hi', createdAt: 1 }] })])
    expect(a.replies).toBe(replies)
    reconcileComments([a], [thread('a', { replies: [...replies, { id: 'r2', author: 'you', text: 'more', createdAt: 2 }] })])
    expect(a.replies).toHaveLength(2)
  })
})
