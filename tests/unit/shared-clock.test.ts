import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { SharedClock } from '@solus/workspace-ui/lib/shared-clock'

let originalDocument: PropertyDescriptor | undefined
let fakeDocument: EventTarget & { visibilityState: DocumentVisibilityState }

beforeEach(() => {
  jest.useFakeTimers()
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  fakeDocument = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  })
})

afterEach(() => {
  jest.useRealTimers()
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: Document }).document
})

describe('shared display clock', () => {
  test('shares one cadence, suspends while hidden, and releases inactive subscribers', () => {
    const clock = new SharedClock(1_000)
    const first: number[] = []
    const second: number[] = []
    const releaseFirst = clock.subscribe((now) => first.push(now))
    const releaseSecond = clock.subscribe((now) => second.push(now))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    jest.advanceTimersByTime(1_000)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)

    releaseFirst()
    jest.advanceTimersByTime(1_000)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(3)

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    jest.advanceTimersByTime(5_000)
    expect(second).toHaveLength(3)

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(second).toHaveLength(4)
    releaseSecond()
    releaseSecond()
    jest.advanceTimersByTime(1_000)
    expect(second).toHaveLength(4)
  })
})
