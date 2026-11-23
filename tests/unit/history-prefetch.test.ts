import { expect, test } from 'bun:test'
import { shouldReadOlderHistory } from '@solus/workspace-ui/components/conversation/lib/history-prefetch'

// WHY: a conversation opened at its end read seven older pages in a second:
// its turns were short, so the reader stayed within three screens of the top
// after each page. History above a reader at the end is read when they scroll
// back, not before.
test('a reader at the end of a full view reads no older page; one scrolling back keeps three screens loaded', () => {
  const screen = { clientHeight: 800, scrollHeight: 2_000 }
  expect(shouldReadOlderHistory({ ...screen, scrollTop: 1_200, atEnd: true })).toBe(false)
  expect(shouldReadOlderHistory({ ...screen, scrollTop: 1_100, atEnd: false })).toBe(true)
  expect(shouldReadOlderHistory({ clientHeight: 800, scrollHeight: 10_000, scrollTop: 5_000, atEnd: false })).toBe(false)
})

test('a view the history does not fill reads, and a tap on the top button always does', () => {
  expect(shouldReadOlderHistory({ clientHeight: 800, scrollHeight: 600, scrollTop: 0, atEnd: true })).toBe(true)
  expect(shouldReadOlderHistory({ clientHeight: 800, scrollHeight: 10_000, scrollTop: 9_200, atEnd: true }, true)).toBe(true)
})
