import { describe, expect, test } from 'bun:test'
import { SessionHostTurns, SessionHostTurnsBook } from '@solus/client-core/session-heads'

class CountingMap extends Map<string, SessionHostTurns> {
  writes = 0
  override set(key: string, value: SessionHostTurns): this {
    this.writes++
    return super.set(key, value)
  }
}

describe('SessionHostTurnsBook', () => {
  test('keeps one changed session entry and skips equal reads', () => {
    // WHY: a repeated info read must not invalidate the reactive session list.
    const map = new CountingMap()
    const book = new SessionHostTurnsBook(map)
    expect(book.noteMeta('mac', { sessionId: 'one', head: 'head-1', syncedTurn: 1 })).toBe(true)
    expect(book.forSession('one').of('mac')?.head).toBe('head-1')
    expect(map.writes).toBe(1)
    expect(book.noteMeta('mac', { sessionId: 'one', head: 'head-1', syncedTurn: 1 })).toBe(false)
    expect(book.noteMeta('old', { sessionId: 'one', head: 'head-0' })).toBe(false)
    expect(map.writes).toBe(1)
    expect(book.noteTurnSettled('mac', 'one', 2)).toBe(true)
    expect(book.forSession('one').of('mac')?.syncedTurn).toBe(3)
    expect(map.writes).toBe(2)
    expect(book.forgetHost('absent')).toBe(false)
    expect(map.writes).toBe(2)
    expect(book.forgetHost('mac')).toBe(true)
    expect(book.forSession('one').of('mac')).toBeUndefined()
    expect(map.writes).toBe(3)
  })
})
