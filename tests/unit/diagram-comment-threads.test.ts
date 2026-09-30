/// <reference types="bun-types" />
/**
 * A pin is the only thing on the canvas that claims a node has unfinished
 * conversation on it. If it collapses the wrong threads, tints to the wrong
 * state, or survives a resolve, the graph lies about what still needs a human.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'

const YOU: Attribution = { kind: 'user', user: { id: { kind: 'local', localId: 'reader' }, displayName: 'Reader' } }
const SOLUS: Attribution = { kind: 'agent', sessionId: 'agent-session', provider: 'claude-code' }
import {
  firstUnreadThread,
  pinSummary,
  threadCounts,
  threadsByAnchor,
  threadTone,
} from '@solus/workspace-ui/components/diagram/lib/comment-threads'

const thread = (extra: Partial<PlanComment>): PlanComment => ({
  id: 'c1',
  selectedText: 'Node',
  comment: 'text',
  ...extra,
})

describe('threadTone', () => {
  test('a resolved agent thread is resolved, not agent — settled outranks who wrote it', () => {
    expect(threadTone(thread({ author: SOLUS, resolvedAt: 1 }))).toBe('resolved')
  })

  test('a thread the host has not stamped yet is a human one: the reader just wrote it', () => {
    expect(threadTone(thread({}))).toBe('open')
    expect(threadTone(thread({ author: SOLUS }))).toBe('agent')
  })
})

describe('pinSummary', () => {
  test('several threads on a node collapse into one pin carrying the total', () => {
    const pin = pinSummary([thread({ id: 'a' }), thread({ id: 'b' }), thread({ id: 'c' })], false)
    expect(pin).toEqual({ tone: 'open', count: 3, unread: false })
  })

  test('resolved threads drop their pin entirely unless resolved are shown', () => {
    const threads = [thread({ id: 'a', resolvedAt: 1 })]
    expect(pinSummary(threads, false)).toBeNull()
    expect(pinSummary(threads, true)).toEqual({ tone: 'resolved', count: 1, unread: false })
  })

  test('an unresolved human thread outranks an agent note on the same node', () => {
    const pin = pinSummary([thread({ id: 'a', author: SOLUS }), thread({ id: 'b' })], false)
    expect(pin?.tone).toBe('open')
  })

  test('unread is Solus speaking since the last read, not the reader’s own note', () => {
    const mine = thread({ id: 'a', author: YOU, createdAt: 50 })
    expect(pinSummary([mine], false)?.unread).toBe(false)

    const answered = thread({
      id: 'b',
      author: YOU,
      createdAt: 50,
      readAt: 60,
      replies: [{ id: 'r', author: SOLUS, text: 'done', createdAt: 90 }],
    })
    expect(pinSummary([answered], false)?.unread).toBe(true)
  })

  test('a resolved thread hidden from the canvas cannot make the pin unread', () => {
    const resolvedUnread = thread({ id: 'a', author: SOLUS, createdAt: 90, resolvedAt: 95 })
    expect(pinSummary([resolvedUnread], false)).toBeNull()
  })
})

describe('threadsByAnchor', () => {
  test('keys nodes and edges alike, and leaves whole-diagram threads out of the canvas', () => {
    const byAnchor = threadsByAnchor([
      thread({ id: 'a', nodeId: 'n1' }),
      thread({ id: 'b', nodeId: 'n1' }),
      thread({ id: 'c', edgeId: 'e1' }),
      thread({ id: 'd' }),
    ])
    expect(byAnchor.get('n1')?.map((t) => t.id)).toEqual(['a', 'b'])
    expect(byAnchor.get('e1')?.map((t) => t.id)).toEqual(['c'])
    expect(byAnchor.size).toBe(2)
  })
})

describe('threadCounts / firstUnreadThread', () => {
  const comments = [
    thread({ id: 'a', resolvedAt: 1 }),
    thread({ id: 'b' }),
    thread({ id: 'c', author: SOLUS, createdAt: 10 }),
  ]

  test('the pill counts what is still open, so resolving one lowers it', () => {
    expect(threadCounts(comments)).toEqual({ total: 2, unread: 1 })
  })

  test('the pill scopes to the first unread thread, skipping resolved ones', () => {
    expect(firstUnreadThread(comments)?.id).toBe('c')
    expect(firstUnreadThread([thread({ id: 'b' })])).toBeUndefined()
  })
})
