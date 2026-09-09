import { afterEach, describe, expect, jest, test } from 'bun:test'
import { PresenceWatch } from '@solus/workspace-ui/lib/presence-watch'

const settle = async () => {
  // Drain the request and its catch/finally chain without advancing a timer.
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

afterEach(() => jest.useRealTimers())

describe('PresenceWatch', () => {
  test('reports completion and the shared timer deadline without moving it on focus checks', async () => {
    jest.useFakeTimers()
    const watches = new PresenceWatch()
    const startedAt = Date.now()
    const release = watches.watch('doc', () => {})
    expect(watches.timings.get('doc')).toEqual({ lastCheckedAt: null, nextCheckAt: startedAt + 300_000, checking: true })
    await settle()
    expect(watches.timings.get('doc')?.lastCheckedAt).toBe(Date.now())
    expect(watches.timings.get('doc')?.checking).toBe(false)
    const releaseSecondary = watches.watch('doc', () => {})
    await settle()
    expect(watches.timings.get('doc')?.nextCheckAt).toBe(startedAt + 300_000)
    jest.advanceTimersByTime(300_000)
    await settle()
    expect(watches.timings.get('doc')?.nextCheckAt).toBe(Date.now() + 300_000)
    release()
    releaseSecondary()
    expect(watches.timings.has('doc')).toBe(false)
  })

  test('shares one poll and stops it when the last viewer leaves', async () => {
    jest.useFakeTimers()
    const watches = new PresenceWatch()
    let refreshes = 0
    const refresh = () => { refreshes += 1 }
    const releaseFirst = watches.watch('doc-1', refresh)
    const releaseSecond = watches.watch('doc-1', refresh)
    await settle()
    expect(refreshes).toBe(1)
    jest.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(refreshes).toBe(2)
    releaseFirst()
    jest.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(refreshes).toBe(3)
    releaseSecond()
    jest.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(refreshes).toBe(3)
  })

  test('opening the secondary pane checks again without waiting for the shared timer', async () => {
    const watches = new PresenceWatch()
    let refreshes = 0
    const refresh = () => { refreshes += 1 }
    const releaseFirst = watches.watch('doc', refresh)
    await settle()
    const releaseSecondary = watches.watch('doc', refresh)
    await settle()
    expect(refreshes).toBe(2)
    releaseFirst()
    releaseSecondary()
  })

  test('returning to Solus refreshes mounted documents and shares overlapping signals', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const windowEvents = new EventTarget()
    const documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentEvents })
    const watches = new PresenceWatch()
    let refreshes = 0
    const release = watches.watch('secondary-doc', () => { refreshes += 1 })
    try {
      await settle()
      windowEvents.dispatchEvent(new Event('focus'))
      documentEvents.dispatchEvent(new Event('visibilitychange'))
      await settle()
      expect(refreshes).toBe(2)
      documentEvents.visibilityState = 'hidden'
      documentEvents.dispatchEvent(new Event('visibilitychange'))
      await settle()
      expect(refreshes).toBe(2)
      release()
      windowEvents.dispatchEvent(new Event('focus'))
      await settle()
      expect(refreshes).toBe(2)
    } finally {
      release()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })

  test('a slow or failed request cannot overlap a poll or stop later checks', async () => {
    jest.useFakeTimers()
    const watches = new PresenceWatch()
    let refreshes = 0
    let rejectRequest: (error: Error) => void = () => {}
    const pending = new Promise<void>((_, reject) => { rejectRequest = reject })
    const release = watches.watch('doc', () => {
      refreshes += 1
      return refreshes === 1 ? pending : Promise.resolve()
    })
    await settle()
    jest.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(refreshes).toBe(1)
    rejectRequest(new Error('Disconnected'))
    await settle()
    jest.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(refreshes).toBe(2)
    release()
  })
})
